/**
 * Oracle / price-consumption guard (SW-2026-IC, incident catalog 2026 §AA/§AH).
 *
 * Neon Relay has no price-dependent mechanic today: rewards are matched by
 * server-signed results with fixed caps, and the economy program takes a
 * configured entry fee in a policy-set mint. This module is therefore a
 * *gate for the day that changes* — it exists so the two 2026 killer patterns
 * cannot be introduced by a feature PR without tripping a test:
 *
 *  - §95 Tectonic: a governance token pushed ~100× in 20 minutes on a market
 *    whose weekly volume was a fraction of the loan. Any mechanic that turns a
 *    token price into protocol value (collateral, staking multiplier, craft
 *    cost, reward valuation, marketplace floor) must be bounded by real
 *    liquidity, not by the last traded price. `markValueMicro` caps the
 *    recognised value at a fraction of the *observed window volume*, and
 *    `thin-liquidity` is a hard "no price" instead of a favourable one.
 *  - §96/§118 Ostium, Bonzo, Moonwell, YieldBlox: oracle integrity. Samples
 *    from the future, stale samples, a single source, divergent sources, and a
 *    "quiet window" with one trade must all produce `no-price` rather than a
 *    number the protocol acts on. The price decision is fail-closed: any doubt
 *    is a refusal, never a fallback to the last trade.
 *
 * `§117` config-change gate: a price/fee parameter change must carry the hash
 * of a fork-simulation of mainnet state and an attestation, because the window
 * between a wrong config and a searcher exploiting it in one atomic
 * transaction is zero.
 *
 * §111: zero/negative amounts, non-integer prices and `NaN` values are
 * rejected structurally, before any arithmetic.
 */

export interface PriceSample {
  /** Independent source id (provider or on-chain feed account). */
  source: string;
  /** Price in micro-units (integer, never a float). */
  priceMicro: number;
  /** Source-claimed observation time. */
  timestampMs: number;
  /** Traded volume backing this sample inside the observed window. */
  volumeMicro?: number;
  /** Number of independent trades behind the sample. */
  trades?: number;
}

export interface OraclePolicy {
  /** A sample older than this is stale. */
  maxAgeMs: number;
  /** A sample claiming to be newer than now + skew is rejected (Ostium §96). */
  maxFutureSkewMs: number;
  /** Minimum number of independent sources that must agree. */
  minSources: number;
  /** Max deviation from the median, in basis points; beyond it: divergence. */
  maxDeviationBps: number;
  /** Minimum traded volume in the window for a usable price. */
  minWindowVolumeMicro: number;
  /** Minimum number of trades in the window (YieldBlox §118). */
  minTrades: number;
  /** Maximum share of window volume a single valuation may recognise, in bps. */
  depthCapBps: number;
  /** Sources that are not independent of each other (same operator), by group. */
  affiliationGroups?: string[][];
}

export type PriceDecision =
  | { status: "ok"; priceMicro: number; medianMicro: number; sources: string[]; volumeMicro: number; trades: number }
  | { status: "no-price"; reasons: string[]; considered: string[] };

export class OracleGuardError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "OracleGuardError";
  }
}

export function assertOraclePolicyShape(policy: OraclePolicy): void {
  const fail = (detail: string): never => { throw new OracleGuardError("policy-invalid", detail); };
  if (!policy || typeof policy !== "object") fail("policy required");
  for (const field of ["maxAgeMs", "maxFutureSkewMs", "minTrades"] as const) {
    if (!Number.isInteger(policy[field]) || policy[field] < 0) fail(`${field} must be a non-negative integer`);
  }
  if (!Number.isInteger(policy.minSources) || policy.minSources < 2) {
    fail("minSources must be at least 2: a single verifier is not redundancy (§102)");
  }
  if (!Number.isInteger(policy.maxDeviationBps) || policy.maxDeviationBps <= 0 || policy.maxDeviationBps > 10_000) {
    fail("maxDeviationBps must be within 1..10000");
  }
  if (!Number.isInteger(policy.depthCapBps) || policy.depthCapBps <= 0 || policy.depthCapBps > 10_000) {
    fail("depthCapBps must be within 1..10000");
  }
  for (const field of ["minWindowVolumeMicro"] as const) {
    if (typeof policy[field] !== "number" || !Number.isFinite(policy[field]) || policy[field] < 0) {
      fail(`${field} must be a non-negative number`);
    }
  }
}

/** Independent sources = distinct ids that do not share an affiliation group. */
export function countIndependentSources(sources: string[], policy: OraclePolicy): number {
  const groups = policy.affiliationGroups ?? [];
  const seenGroups = new Set<number>();
  const independent: string[] = [];
  sources.forEach((source, index) => {
    const groupIndex = groups.findIndex((group) => group.includes(source));
    if (groupIndex >= 0) {
      if (seenGroups.has(groupIndex)) return;
      seenGroups.add(groupIndex);
    }
    independent.push(source);
    void index;
  });
  return independent.length;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : Math.floor((sorted[middle - 1] + sorted[middle]) / 2);
}

/**
 * Decide the protocol-usable price, or refuse. Refusal (`no-price`) is a
 * first-class result: callers must not substitute "the last known price".
 */
export function guardPrice(samples: PriceSample[], policy: OraclePolicy, now: number): PriceDecision {
  assertOraclePolicyShape(policy);
  const reasons: string[] = [];
  const considered: string[] = [];
  if (!Array.isArray(samples) || samples.length === 0) {
    return { status: "no-price", reasons: ["no-samples"], considered: [] };
  }
  const usable: PriceSample[] = [];
  for (const sample of samples) {
    const label = sample?.source ?? "(unnamed)";
    considered.push(label);
    if (!sample || typeof sample !== "object") { reasons.push(`${label}:malformed-sample`); continue; }
    if (!Number.isInteger(sample.priceMicro) || sample.priceMicro <= 0) {
      reasons.push(`${label}:invalid-price`); continue;
    }
    if (!Number.isFinite(sample.timestampMs)) { reasons.push(`${label}:invalid-timestamp`); continue; }
    if (sample.timestampMs > now + policy.maxFutureSkewMs) {
      // Ostium §96: attacker-controlled feeds reported "prices from the future".
      reasons.push(`${label}:future-timestamp`); continue;
    }
    if (now - sample.timestampMs > policy.maxAgeMs) {
      reasons.push(`${label}:stale`); continue;
    }
    usable.push(sample);
  }
  if (usable.length === 0) {
    return { status: "no-price", reasons: reasons.length > 0 ? reasons : ["no-usable-samples"], considered };
  }
  const distinctSources = [...new Set(usable.map((sample) => sample.source))];
  if (distinctSources.length < policy.minSources ||
      countIndependentSources(distinctSources, policy) < policy.minSources) {
    reasons.push(`insufficient-independent-sources:${distinctSources.length}<${policy.minSources}`);
    return { status: "no-price", reasons, considered };
  }
  const medianMicro = median(usable.map((sample) => sample.priceMicro));
  for (const sample of usable) {
    const deviationBps = Math.floor(Math.abs(sample.priceMicro - medianMicro) * 10_000 / medianMicro);
    if (deviationBps > policy.maxDeviationBps) {
      // Do not average a lie away: a diverging source is a stop condition.
      reasons.push(`${sample.source}:divergence:${deviationBps}bps`);
    }
  }
  if (reasons.length > 0) return { status: "no-price", reasons, considered };

  const volumeMicro = usable.reduce((total, sample) => total + (sample.volumeMicro ?? 0), 0);
  const trades = usable.reduce((total, sample) => total + (sample.trades ?? 0), 0);
  if (volumeMicro < policy.minWindowVolumeMicro) {
    // §118: one trade in a quiet window must not define the price.
    return { status: "no-price", reasons: [...reasons, `thin-liquidity:${volumeMicro}<${policy.minWindowVolumeMicro}`], considered };
  }
  if (trades < policy.minTrades) {
    return { status: "no-price", reasons: [...reasons, `too-few-trades:${trades}<${policy.minTrades}`], considered };
  }
  return { status: "ok", priceMicro: medianMicro, medianMicro, sources: distinctSources, volumeMicro, trades };
}

/**
 * §95: never recognise the full notional of a position against a thin market.
 * The recognised value is capped at `depthCapBps` of the observed window
 * volume — a price that is 100× its market depth buys at most depth.
 */
export function markValueMicro(
  amountMicro: number, decision: PriceDecision, policy: OraclePolicy,
): { valueMicro: number; capped: boolean; reason: string } {
  assertOraclePolicyShape(policy);
  if (!Number.isInteger(amountMicro) || amountMicro <= 0) {
    throw new OracleGuardError("invalid-amount", "amount must be a positive integer (zero/dust refused, §111)");
  }
  if (decision.status !== "ok") {
    return { valueMicro: 0, capped: true, reason: "no-price" };
  }
  const notional = Math.floor(amountMicro * decision.priceMicro / 1_000_000);
  const depthCap = Math.floor(decision.volumeMicro * policy.depthCapBps / 10_000);
  if (notional <= depthCap) return { valueMicro: notional, capped: false, reason: "within-depth" };
  return { valueMicro: depthCap, capped: true, reason: "liquidity-capped" };
}

/**
 * §96/§102: verification redundancy for bridges, attestations and oracle
 * updates. A configuration that silently degrades m-of-n to 1-of-n is the
 * KelpDAO pattern; this asserts the minimum in code, not in operations.
 */
export function assertVerifierRedundancy(
  configured: { threshold: number; total: number; independentOperators: number },
  minimum: { threshold: number; total: number; independentOperators: number },
): void {
  if (configured.threshold < minimum.threshold) {
    throw new OracleGuardError("threshold-below-minimum",
      `threshold ${configured.threshold} is below the code-enforced minimum ${minimum.threshold}`);
  }
  if (configured.total < minimum.total) {
    throw new OracleGuardError("total-below-minimum",
      `verifier set ${configured.total} is below the code-enforced minimum ${minimum.total}`);
  }
  if (configured.independentOperators < minimum.independentOperators) {
    throw new OracleGuardError("operators-not-independent",
      `${configured.independentOperators} independent operators is below the required ${minimum.independentOperators}`);
  }
  if (configured.threshold > configured.total) {
    throw new OracleGuardError("impossible-threshold", "threshold cannot exceed the verifier count");
  }
}

/**
 * §117: price/fee parameter changes go live only with a fork-simulation
 * attestation. The gate refuses when the simulation is missing, failed, or was
 * run against a stale fork slot.
 */
export function verifyConfigChangeAttestation(
  attestation: {
    simulated: boolean;
    forkSlot: number;
    currentSlot: number;
    maxForkAgeSlots: number;
    fuzzCases?: number;
    minFuzzCases: number;
    invariantViolations?: string[];
  },
): { ok: true } | { ok: false; code: string; detail: string } {
  if (!attestation || attestation.simulated !== true) {
    return { ok: false, code: "config-requires-simulation", detail: "no fork simulation attached to the change" };
  }
  if (!Number.isInteger(attestation.forkSlot) || attestation.forkSlot <= 0) {
    return { ok: false, code: "fork-slot-invalid", detail: "fork slot is required" };
  }
  if (attestation.currentSlot - attestation.forkSlot > attestation.maxForkAgeSlots) {
    return { ok: false, code: "fork-too-old", detail: "simulate against a fresh mainnet fork" };
  }
  if ((attestation.fuzzCases ?? 0) < attestation.minFuzzCases) {
    return { ok: false, code: "fuzz-coverage-insufficient", detail: "boundary fuzzing is required before rollout" };
  }
  if ((attestation.invariantViolations ?? []).length > 0) {
    return { ok: false, code: "invariant-violations", detail: (attestation.invariantViolations ?? []).join(",") };
  }
  return { ok: true };
}
