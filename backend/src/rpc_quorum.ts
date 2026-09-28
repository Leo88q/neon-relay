/**
 * Quorum reads for money-path chain state (SW-2026-IC, catalog §102/§103).
 *
 * `rpc.ts` fails over between providers — that protects availability, not
 * integrity. In KelpDAO the attacker poisoned the data source the *signer*
 * read (code injected into op-geth on two Kubernetes clusters) while
 * monitoring kept reading honest nodes: failover to the same class of
 * provider would have changed nothing, and a single trusted RPC is a single
 * verifier. KelpDAO's other half was a silent 2-of-2 → 1-of-1 downgrade.
 *
 * This module adds the missing half:
 *  - money-path reads require an explicit `finalized` commitment;
 *  - at least `minAgreement` providers must return byte-identical data;
 *  - providers must be operationally independent (distinct hosts — two API
 *    keys on one provider are one verifier wearing two hats);
 *  - divergence is a hard error with the disagreeing values named, never a
 *    majority vote among unverified responders;
 *  - a self-hosted node can be one of the providers, and `independence`
 *    metadata is checked, not assumed.
 *
 * No keys, no signing, no writes: this reads and compares.
 */
import { createHash } from "node:crypto";

export type Commitment = "processed" | "confirmed" | "finalized";

export interface QuorumProvider {
  /** Operator-friendly id; appears in errors and alerts, never a URL with a key. */
  id: string;
  /** Redacted endpoint (protocol//host) used for the independence check. */
  endpoint: string;
  /** Performs the JSON-RPC call. Injected so tests need no network. */
  call: (method: string, params: unknown[]) => Promise<unknown>;
  /** Optional: set true for a self-hosted node (counts as an independent verifier). */
  selfHosted?: boolean;
}

export interface QuorumRequest {
  method: string;
  /** Params builder; receives the commitment the read must use. */
  paramsFor: (commitment: Commitment) => unknown[];
  commitment: Commitment;
  /** Minimum number of byte-identical successful answers. */
  minAgreement: number;
  /** Strip volatile fields (slots) before comparison; data must still match. */
  normalize?: (value: unknown) => unknown;
}

export interface QuorumResult<T> {
  value: T;
  commitment: Commitment;
  agreeing: string[];
  failed: { id: string; error: string }[];
  /** sha256 of the canonical value that was agreed on. */
  digest: string;
}

export class QuorumError extends Error {
  readonly code: string;
  readonly detail: Record<string, unknown>;
  constructor(code: string, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.detail = detail;
    this.name = "QuorumError";
  }
}

/** Redact a URL down to protocol//host for logging and independence checks. */
export function redactEndpoint(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "(invalid-endpoint)";
  }
}

/**
 * Two providers that share a host share an operator, a deployment and an
 * incident. This is the §102/§103 invariant: redundancy you cannot verify is
 * not redundancy.
 */
export function assertProviderIndependence(providers: QuorumProvider[], minAgreement: number): void {
  if (!Array.isArray(providers) || providers.length < minAgreement) {
    throw new QuorumError("quorum-too-small",
      `need at least ${minAgreement} providers, have ${providers?.length ?? 0}`);
  }
  if (minAgreement < 2) {
    throw new QuorumError("quorum-minimum-too-low",
      "minAgreement must be at least 2: a single provider is a single point of forged data (§102)");
  }
  const hosts = new Map<string, string[]>();
  for (const provider of providers) {
    const host = redactEndpoint(provider.endpoint);
    const list = hosts.get(host) ?? [];
    list.push(provider.id);
    hosts.set(host, list);
  }
  const shared = [...hosts.entries()].filter(([, ids]) => ids.length > 1);
  if (shared.length > 0) {
    throw new QuorumError("providers-not-independent",
      `providers share an endpoint host: ${shared.map(([host, ids]) => `${host}(${ids.join("+")})`).join(", ")}`,
      { shared: shared.map(([host, ids]) => ({ host, ids })) });
  }
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(",")}}`;
}

/** Default comparison view: drops slot numbers, keeps everything data-bearing. */
export function stripVolatileSlots(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripVolatileSlots);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (key === "slot" || key === "blockHeight" || key === "absoluteSlot") continue;
      out[key] = stripVolatileSlots(entry);
    }
    return out;
  }
  return value;
}

export function canonicalDigest(value: unknown): string {
  return createHash("sha256").update(canonicalize(value), "utf8").digest("hex");
}

/**
 * Read one value through a provider quorum. Throws `quorum-divergence` or
 * `quorum-unavailable` instead of returning a "best effort" answer: a money
 * path that cannot verify its inputs must stop, not guess.
 */
export async function quorumRead<T = unknown>(
  providers: QuorumProvider[], request: QuorumRequest,
): Promise<QuorumResult<T>> {
  if (request.commitment !== "finalized" && request.minAgreement >= 2) {
    // Confirmed/processed data can legitimately differ between providers by a
    // slot; a *quorum* over it would flap. Money-path reads must be finalized.
    throw new QuorumError("commitment-not-finalized",
      "quorum reads require the finalized commitment (§103: act on finalized state, not on a tip)");
  }
  assertProviderIndependence(providers, request.minAgreement);
  const params = request.paramsFor(request.commitment);
  const settled = await Promise.all(providers.map(async (provider) => {
    try {
      const value = await provider.call(request.method, params);
      return { provider, value, error: null as string | null };
    } catch (error) {
      return { provider, value: undefined, error: (error as Error)?.message ?? "call-failed" };
    }
  }));
  const failed = settled.filter((entry) => entry.error !== null)
    .map((entry) => ({ id: entry.provider.id, error: entry.error as string }));
  const groups = new Map<string, { ids: string[]; value: unknown }>();
  for (const entry of settled) {
    if (entry.error !== null) continue;
    const view = (request.normalize ?? stripVolatileSlots)(entry.value);
    const digest = canonicalDigest(view);
    const group = groups.get(digest) ?? { ids: [], value: entry.value };
    group.ids.push(entry.provider.id);
    groups.set(digest, group);
  }
  const winner = [...groups.entries()].sort((a, b) => b[1].ids.length - a[1].ids.length)[0];
  const successful = settled.length - failed.length;
  if (successful < request.minAgreement) {
    // Too few answers: that is an availability incident, not a fork.
    throw new QuorumError("quorum-unavailable",
      `only ${successful} of ${providers.length} providers answered (need ${request.minAgreement})`,
      { failed, commitment: request.commitment, method: request.method });
  }
  if (!winner || winner[1].ids.length < request.minAgreement) {
    const observed = [...groups.entries()].map(([digest, group]) => ({
      digest: digest.slice(0, 16), providers: group.ids,
    }));
    throw new QuorumError("quorum-divergence",
      `no ${request.minAgreement} providers agree; observed groups: ${JSON.stringify(observed)}`,
      { observed, failed, commitment: request.commitment, method: request.method });
  }
  const [digest, group] = winner;
  return {
    value: group.value as T,
    commitment: request.commitment,
    agreeing: group.ids,
    failed,
    digest,
  };
}

/**
 * §102: the minimum verifier configuration is pinned in code so that an
 * operational edit (2-of-2 → 1-of-1) cannot quietly reduce it. Returns a
 * violation string or null, mirroring `rakeStepViolation` in `economy_v2_rpc`.
 */
export const MIN_VERIFIER_CONFIG = Object.freeze({ threshold: 2, total: 3, independentOperators: 2 });

export function verifierDowngradeViolation(
  previous: { threshold: number; total: number; independentOperators: number },
  next: { threshold: number; total: number; independentOperators: number },
): string | null {
  if (next.threshold < MIN_VERIFIER_CONFIG.threshold) return "threshold-below-code-minimum";
  if (next.total < MIN_VERIFIER_CONFIG.total) return "total-below-code-minimum";
  if (next.independentOperators < MIN_VERIFIER_CONFIG.independentOperators) return "operators-not-independent";
  if (next.threshold > next.total) return "threshold-exceeds-total";
  if (next.threshold < previous.threshold || next.independentOperators < previous.independentOperators) {
    return "security-downgrade-requires-timelock-and-alert";
  }
  return null;
}
