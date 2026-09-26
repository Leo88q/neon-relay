/**
 * Minimal dependency-free HTTP helpers: JSON requests/responses, a tiny
 * router, bearer-token extraction and an in-memory token-bucket rate limiter.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = "HttpError";
  }
}

export interface RequestContext {
  method: string;
  path: string;
  url: URL;
  ip: string;
  body: unknown;
  bearer: string | null;
  params: Record<string, string>;
}

export async function readJsonBody(req: IncomingMessage, limitBytes = 64 * 1024):
  Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limitBytes) throw new HttpError(413, "payload-too-large", "request body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return null;
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "bad-json", "request body is not valid JSON");
  }
}

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

export function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers["authorization"];
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

export function clientIp(req: IncomingMessage): string {
  // CRITICAL-04 / MED-02 fix: X-Forwarded-For spoof → rate limiter bypass.
  // Only trust proxy headers when explicitly enabled (TRUST_PROXY=1),
  // otherwise use the socket peer. Prevents IP rotation DoS on /v1/auth/*.
  if (process.env.TRUST_PROXY === "1") {
    const trustedProxies = process.env.TRUSTED_PROXIES
      ? process.env.TRUSTED_PROXIES.split(",").map((s) => s.trim())
      : null;
    const socketIp = req.socket.remoteAddress;
    const isSocketTrusted = !trustedProxies || (socketIp && trustedProxies.includes(socketIp));
    if (isSocketTrusted) {
      const forwarded = req.headers["x-forwarded-for"];
      if (typeof forwarded === "string" && forwarded.length > 0) {
        const first = forwarded.split(",")[0]?.trim();
        // Strict IP sanity: must be a syntactically valid IPv4 or IPv6 address.
        if (first !== undefined && isIP(first) !== 0) {
          return first;
        }
      }
    }
  }
  return req.socket.remoteAddress ?? "unknown";
}

export type Handler = (ctx: RequestContext) => Promise<unknown> | unknown;

interface PatternRoute {
  method: string;
  parts: string[];
  handler: Handler;
}

export class Router {
  private readonly routes = new Map<string, Handler>();
  private readonly patternRoutes: PatternRoute[] = [];

  add(method: string, path: string, handler: Handler): void {
    if (path.includes(":")) {
      const parts = path.split("/").filter(Boolean);
      this.patternRoutes.push({ method, parts, handler });
      return;
    }
    this.routes.set(`${method} ${path}`, handler);
  }

  resolve(method: string, path: string): { handler: Handler; params: Record<string, string> } | undefined {
    const exact = this.routes.get(`${method} ${path}`);
    if (exact) return { handler: exact, params: {} };
    const pathParts = path.split("/").filter(Boolean);
    for (const route of this.patternRoutes) {
      if (route.method !== method || route.parts.length !== pathParts.length) continue;
      const params: Record<string, string> = {};
      let matched = true;
      for (let i = 0; i < route.parts.length; i += 1) {
        const expected = route.parts[i] as string;
        const actual = pathParts[i] as string;
        if (expected.startsWith(":")) {
          params[expected.slice(1)] = decodeURIComponent(actual);
        } else if (expected !== actual) {
          matched = false;
          break;
        }
      }
      if (matched) return { handler: route.handler, params };
    }
    return undefined;
  }

  /**
   * SW-2026-AGI: introspection for the route-integrity tests — the exporter
   * surface must provably stay GET-only, so tests walk the live route table
   * instead of trusting a documented list.
   */
  routeTable(): { method: string; path: string }[] {
    return [
      ...[...this.routes.keys()].map((key) => {
        const [method, ...path] = key.split(" ");
        return { method: method as string, path: path.join(" ") };
      }),
      ...this.patternRoutes.map((route) => ({ method: route.method, path: `/${route.parts.join("/")}` })),
    ];
  }
}

/**
 * Fixed-window-free token bucket per IP. Deliberately in-process: a horizontal
 * scale-out would move this to the edge/reverse proxy (documented in
 * docs/WALLET_AUTH.md §rate limiting).
 *
 * SW-2026-09-26 F-08: buckets are evicted, so the map no longer grows with the
 * number of distinct keys ever seen. Two mechanisms:
 *   * a bucket idle for the full refill window (`capacity / refillPerMs`) is
 *     indistinguishable from a brand-new one, so dropping it is invisible;
 *   * if the map still exceeds `maxBuckets` (sustained pressure from many
 *     active keys), the least-recently-updated buckets are dropped. A dropped
 *     client simply gets fresh-bucket treatment on its next request — the same
 *     allowance a brand-new key already receives, so eviction can never widen
 *     an attacker's budget beyond "new key" behaviour.
 * With `refillPerMs <= 0` buckets never recover, so idle eviction would change
 * semantics (a permanently-denied key must not be reset); only the hard cap
 * applies in that mode.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; updated: number }>();
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly maxBuckets: number;
  private lastPrune = 0;

  constructor(capacity: number, refillPerMs: number, maxBuckets = 10_000) {
    this.capacity = capacity;
    this.refillPerMs = refillPerMs;
    this.maxBuckets = maxBuckets;
  }

  /** Full-refill window in ms: idling this long makes a bucket fresh again. */
  private get idleMs(): number {
    return this.refillPerMs > 0 ? this.capacity / this.refillPerMs : Number.POSITIVE_INFINITY;
  }

  private maybePrune(now: number): void {
    if (this.buckets.size <= this.maxBuckets && now - this.lastPrune < this.idleMs) return;
    this.lastPrune = now;
    if (this.refillPerMs > 0) {
      for (const [key, bucket] of this.buckets) {
        if (now - bucket.updated >= this.idleMs) this.buckets.delete(key);
      }
    }
    if (this.buckets.size > this.maxBuckets) this.dropOldest(this.maxBuckets);
  }

  /** Keep the `limit` most recently updated buckets; drop the rest. */
  private dropOldest(limit: number): void {
    const ordered = [...this.buckets.entries()].sort((a, b) => a[1].updated - b[1].updated);
    for (let i = 0; i < ordered.length - limit; i += 1) {
      this.buckets.delete(ordered[i]![0]);
    }
  }

  allow(key: string, now: number = Date.now()): boolean {
    const allowed = this.spend(key, now);
    // Prune after the decision: the freshly-touched bucket is never idle, so
    // this keeps the hard cap exact without influencing the current call.
    this.maybePrune(now);
    return allowed;
  }

  private spend(key: string, now: number): boolean {
    const bucket = this.buckets.get(key);
    if (!bucket) {
      this.buckets.set(key, { tokens: this.capacity - 1, updated: now });
      return true;
    }
    const refilled = Math.min(
      this.capacity,
      bucket.tokens + (now - bucket.updated) * this.refillPerMs,
    );
    if (refilled < 1) {
      bucket.updated = now;
      bucket.tokens = refilled;
      return false;
    }
    bucket.tokens = refilled - 1;
    bucket.updated = now;
    return true;
  }
}
