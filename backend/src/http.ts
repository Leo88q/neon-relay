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
  return match ? match[1] : null;
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
        const first = forwarded.split(",")[0].trim();
        // Strict IP sanity: must be a syntactically valid IPv4 or IPv6 address.
        if (isIP(first) !== 0) {
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
}

/**
 * Fixed-window-free token bucket per IP. Deliberately in-process: a horizontal
 * scale-out would move this to the edge/reverse proxy (documented in
 * docs/WALLET_AUTH.md §rate limiting).
 */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; updated: number }>();
  private readonly capacity: number;
  private readonly refillPerMs: number;

  constructor(capacity: number, refillPerMs: number) {
    this.capacity = capacity;
    this.refillPerMs = refillPerMs;
  }

  allow(key: string, now: number = Date.now()): boolean {
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
