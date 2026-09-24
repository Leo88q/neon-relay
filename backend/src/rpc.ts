/**
 * Dual-provider Solana JSON-RPC pool: failover + chain-identity guard.
 *
 * All backend chain reads (ticket checks, vault pool, reconciliation,
 * treasury snapshots) go through one pool built from
 * `NEONRELAY_RPC_URL` (primary) and the optional
 * `NEONRELAY_RPC_FALLBACK_URL`. Routing rules:
 *
 * - Every call tries the endpoints in order (primary first), skipping
 *   endpoints inside their cooldown window — unless *all* endpoints are
 *   cooling down, in which case all are retried once (degraded mode).
 * - Any transport failure (network error, timeout, HTTP !ok, unparsable
 *   reply) or JSON-RPC error fails the endpoint over: its failure
 *   counters grow, a cooldown starts, and the next endpoint is tried.
 * - A call that fails on primary but succeeds on fallback records a
 *   *failover*; a later success back on primary records a *failback*.
 *   Both are visible in `getStatus()`, `GET /v1/admin/rpc-status` and
 *   the `pipeline.rpc` metrics section — and an on-fallback state adds
 *   a line to stuck-report digests.
 * - Chain identity ("config comparison"): before an endpoint is trusted,
 *   the pool reads its `getGenesisHash` once and pins it. The first
 *   genesis ever learned pins the pool; any endpoint serving a different
 *   chain — or a different chain than `NEONRELAY_EXPECTED_GENESIS_HASH`
 *   when set — is rejected exactly like a failed endpoint, so a provider
 *   pointed at the wrong cluster can never silently feed money-path
 *   reads. Identity is pinned for the process lifetime (a restart
 *   re-verifies). When an expected genesis is configured (mandatory in
 *   production), a genesis read that fails or is malformed fails the call
 *   closed; development-only pools may remain identity-unknown.
 * - With no fallback configured the pool behaves like the legacy
 *   single-shot caller plus timeout/status plumbing.
 *
 * Status output never contains credentials: URLs are redacted to
 * `protocol//host[/…]` (provider API keys travel in query strings and
 * path segments, both stripped).
 */
import type { RpcCaller } from "./economy.ts";

export class RpcError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "RpcError";
  }
}

/** Strip query/fragment and collapse non-root paths (both carry API keys). */
export function redactRpcUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === "/" || parsed.pathname === "" ? "" : "/…";
    return `${parsed.protocol}//${parsed.host}${path}`;
  } catch {
    return "(invalid-url)";
  }
}

export interface RpcPoolOptions {
  primary: string;
  fallback?: string | null;
  timeoutMs?: number;
  cooldownMs?: number;
  expectedGenesis?: string | null;
  /** Require a successful genesis read before any money-path RPC call. */
  requireGenesis?: boolean;
  fetchFn?: typeof fetch;
  nowFn?: () => number;
}

export interface RpcEndpointStatus {
  role: "primary" | "fallback";
  /** Redacted endpoint URL — never contains credentials. */
  url: string;
  ok: boolean;
  requests: number;
  errors: number;
  consecutive_failures: number;
  last_ok_at: number | null;
  last_error_at: number | null;
  last_error: string | null;
  /** Cached getGenesisHash, or null while unknown. */
  genesis: string | null;
  /** True when the endpoint was last seen serving the wrong chain. */
  chain_rejected: boolean;
}

export interface RpcPoolStatus {
  active: "primary" | "fallback" | null;
  single_provider: boolean;
  failovers_total: number;
  last_failover_at: number | null;
  last_failback_at: number | null;
  chain: {
    expected: string | null;
    /** Both providers agree; null while either identity is unknown. */
    match: boolean | null;
  };
  endpoints: {
    primary: RpcEndpointStatus;
    fallback: RpcEndpointStatus | null;
  };
}

interface EndpointState {
  role: "primary" | "fallback";
  url: string;
  requests: number;
  errors: number;
  consecutiveFailures: number;
  cooldownUntil: number;
  lastOkAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
  genesis: string | null;
  genesisCheckedAt: number;
  chainRejected: boolean;
}

const trimError = (message: string): string =>
  message.length > 200 ? `${message.slice(0, 197)}…` : message;

export function createRpcPool(options: RpcPoolOptions): {
  call: RpcCaller;
  getStatus: () => RpcPoolStatus;
} {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const cooldownMs = options.cooldownMs ?? 30_000;
  const fetchFn = options.fetchFn ?? fetch;
  const nowFn = options.nowFn ?? Date.now;
  const expectedGenesis = options.expectedGenesis ?? null;
  const requireGenesis = options.requireGenesis ?? expectedGenesis !== null;

  const endpoints: EndpointState[] = [{
    role: "primary", url: options.primary,
    requests: 0, errors: 0, consecutiveFailures: 0, cooldownUntil: 0,
    lastOkAt: null, lastErrorAt: null, lastError: null,
    genesis: null, genesisCheckedAt: 0, chainRejected: false,
  }];
  if (options.fallback) {
    endpoints.push({
      role: "fallback", url: options.fallback,
      requests: 0, errors: 0, consecutiveFailures: 0, cooldownUntil: 0,
      lastOkAt: null, lastErrorAt: null, lastError: null,
      genesis: null, genesisCheckedAt: 0, chainRejected: false,
    });
  }

  let active: "primary" | "fallback" | null = null;
  let failoversTotal = 0;
  let lastFailoverAt: number | null = null;
  let lastFailbackAt: number | null = null;
  /** First accepted genesis pins the pool's chain identity (see module doc). */
  let pinnedGenesis: string | null = null;

  const fail = (ep: EndpointState, now: number, err: unknown): void => {
    const message = err instanceof Error ? err.message : String(err);
    ep.errors += 1;
    ep.consecutiveFailures += 1;
    ep.cooldownUntil = now + cooldownMs;
    ep.lastErrorAt = now;
    ep.lastError = trimError(message);
  };

  const rawCall = async (ep: EndpointState, method: string, params: unknown[]): Promise<unknown> => {
    ep.requests += 1;
    let res: Response;
    try {
      res = await fetchFn(ep.url, {
        method: "POST",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new RpcError("rpc-timeout", `rpc request timed out after ${timeoutMs}ms`);
      }
      throw new RpcError("rpc-transport", `rpc transport failed: ${(err as Error).message}`);
    }
    if (!res.ok) throw new RpcError("rpc-http", `rpc http ${res.status}`);
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new RpcError("rpc-protocol", "rpc reply is not valid JSON");
    }
    if (json === null || typeof json !== "object" || Array.isArray(json)) {
      throw new RpcError("rpc-protocol", "rpc reply has an unexpected shape");
    }
    const error = (json as { error?: { code?: unknown; message?: unknown } }).error;
    if (error !== undefined && error !== null) {
      const detail = typeof error.message === "string" ? error.message : "unknown";
      throw new RpcError("rpc-error", `rpc error: ${detail}`);
    }
    return (json as { result?: unknown }).result;
  };

  /** Resolve and enforce the endpoint's chain identity (cached once known). */
  const ensureChain = async (ep: EndpointState, now: number): Promise<void> => {
    if (ep.genesis !== null) return;
    // Throttle re-discovery: a development provider that cannot answer
    // getGenesisHash must not double the cost of every call. Production is
    // different: an unverified endpoint must remain unusable during the
    // cooldown, rather than falling through to the money-path RPC method.
    if (now - ep.genesisCheckedAt < cooldownMs && ep.genesisCheckedAt !== 0) {
      if (requireGenesis) {
        throw new RpcError("chain-identity-unavailable",
          `cannot verify ${ep.role} genesis before trusting the endpoint`);
      }
      return;
    }
    ep.genesisCheckedAt = now;
    let result: unknown;
    try {
      result = await rawCall(ep, "getGenesisHash", []);
    } catch (error) {
      if (requireGenesis) {
        throw new RpcError("chain-identity-unavailable",
          `cannot verify ${ep.role} genesis before trusting the endpoint`);
      }
      return;
    }
    if (typeof result !== "string" || result.length === 0) {
      if (requireGenesis) {
        throw new RpcError("chain-identity-invalid", `${ep.role} returned an invalid genesis hash`);
      }
      return;
    }
    if (expectedGenesis !== null && result !== expectedGenesis) {
      ep.chainRejected = true;
      throw new RpcError("chain-mismatch",
        `${ep.role} serves unexpected chain ${result} (expected ${expectedGenesis})`);
    }
    if (expectedGenesis === null && pinnedGenesis !== null && result !== pinnedGenesis) {
      ep.chainRejected = true;
      throw new RpcError("chain-mismatch",
        `${ep.role} serves chain ${result} but the pool is pinned to ${pinnedGenesis}`);
    }
    ep.genesis = result;
    pinnedGenesis ??= result;
    ep.chainRejected = false;
  };

  const call: RpcCaller = async (method, params) => {
    const now = nowFn();
    const rested = endpoints.filter((ep) => now >= ep.cooldownUntil);
    // Degraded mode: when everything is cooling down, still try each
    // endpoint once rather than failing without an attempt.
    const order = rested.length > 0 ? rested : endpoints;
    let lastErr: unknown = new RpcError("rpc-unavailable", "no rpc endpoint configured");
    let primaryFailedThisCall = false;
    for (const ep of order) {
      try {
        await ensureChain(ep, now);
        const result = await rawCall(ep, method, params);
        ep.consecutiveFailures = 0;
        ep.cooldownUntil = 0;
        ep.lastOkAt = now;
        if (ep.role === "fallback" && primaryFailedThisCall) {
          failoversTotal += 1;
          lastFailoverAt = now;
        } else if (ep.role === "primary" && active === "fallback") {
          lastFailbackAt = now;
        }
        active = ep.role;
        return result;
      } catch (err) {
        if (ep.role === "primary") primaryFailedThisCall = true;
        fail(ep, now, err);
        lastErr = err;
      }
    }
    throw lastErr instanceof RpcError
      ? lastErr
      : new RpcError("rpc-unavailable", `rpc call failed: ${(lastErr as Error).message}`);
  };

  const endpointStatus = (ep: EndpointState): RpcEndpointStatus => ({
    role: ep.role,
    url: redactRpcUrl(ep.url),
    ok: ep.consecutiveFailures === 0 && !ep.chainRejected,
    requests: ep.requests,
    errors: ep.errors,
    consecutive_failures: ep.consecutiveFailures,
    last_ok_at: ep.lastOkAt,
    last_error_at: ep.lastErrorAt,
    last_error: ep.lastError,
    genesis: ep.genesis,
    chain_rejected: ep.chainRejected,
  });

  const getStatus = (): RpcPoolStatus => {
    const primary = endpointStatus(endpoints[0] as EndpointState);
    const fallbackState = endpoints[1];
    const fallback = fallbackState ? endpointStatus(fallbackState) : null;
    const match = primary.genesis === null || fallback?.genesis === null || fallback === null
      ? null
      : primary.genesis === fallback.genesis;
    return {
      active,
      single_provider: fallback === null,
      failovers_total: failoversTotal,
      last_failover_at: lastFailoverAt,
      last_failback_at: lastFailbackAt,
      chain: { expected: expectedGenesis, match },
      endpoints: { primary, fallback },
    };
  };

  return { call, getStatus };
}
