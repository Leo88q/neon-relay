/**
 * Rate limiting and client-IP attribution.
 *
 * Two halves:
 *   1. the guarantees that already hold (token-bucket semantics, and the
 *      CRITICAL-04/MED-02 fix that makes `X-Forwarded-For` unspoofable unless
 *      an operator explicitly opts into a trusted proxy);
 *   2. F-08 from docs/SECURITY_REVIEW_2026_09_26.md — FIXED: idle buckets are
 *      evicted after the full-refill window and the map is hard-capped; the
 *      regression below pins that it can never go back to unbounded growth.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { RateLimiter, clientIp } from "../src/http.ts";

/** Minimal stand-in for the parts of `IncomingMessage` that clientIp reads. */
function request(socketIp: string | undefined, headers: Record<string, unknown> = {}) {
  return { socket: { remoteAddress: socketIp }, headers } as unknown as IncomingMessage;
}

test("token bucket allows a burst up to capacity and then denies", () => {
  const limiter = new RateLimiter(3, 0.001); // 3 tokens, 1 per second
  const now = 1_000;
  assert.equal(limiter.allow("ip-a", now), true);
  assert.equal(limiter.allow("ip-a", now), true);
  assert.equal(limiter.allow("ip-a", now), true);
  assert.equal(limiter.allow("ip-a", now), false, "the 4th call in the same instant passed");
});

test("token bucket refills proportionally to elapsed time", () => {
  const limiter = new RateLimiter(2, 1 / 1000); // 1 token per second
  assert.equal(limiter.allow("ip-b", 0), true);
  assert.equal(limiter.allow("ip-b", 0), true);
  assert.equal(limiter.allow("ip-b", 0), false);
  assert.equal(limiter.allow("ip-b", 500), false, "half a token must not be spendable");
  assert.equal(limiter.allow("ip-b", 1000), true, "one full second refilled one token");
  assert.equal(limiter.allow("ip-b", 1000), false);
});

test("refill never exceeds capacity, so an idle client gets no mega-burst", () => {
  const limiter = new RateLimiter(2, 1 / 1000);
  assert.equal(limiter.allow("ip-c", 0), true);
  // A year of idleness must not bank more than `capacity` tokens.
  assert.equal(limiter.allow("ip-c", 365 * 24 * 3600 * 1000), true);
  assert.equal(limiter.allow("ip-c", 365 * 24 * 3600 * 1000), true);
  assert.equal(limiter.allow("ip-c", 365 * 24 * 3600 * 1000), false);
});

test("keys are isolated: one abusive client cannot exhaust another's budget", () => {
  const limiter = new RateLimiter(1, 0);
  const now = 5;
  assert.equal(limiter.allow("ip-d", now), true);
  assert.equal(limiter.allow("ip-d", now), false);
  assert.equal(limiter.allow("ip-e", now), true, "a different key was denied");
});

test("F-08 (FIXED) — idle buckets are reclaimed and the map stays bounded", () => {
  // Regression for SW-2026-09-26 F-08 (was LOW). The bucket map used to keep
  // every key ever seen forever, so distinct source IPs grew it without bound.
  // Now: a bucket idle for the full refill window is indistinguishable from a
  // fresh one and is evicted; a hard cap bounds even fully active pressure.
  const limiter = new RateLimiter(2, 1 / 1000);
  const buckets = (limiter as unknown as { buckets: Map<string, unknown> }).buckets;
  assert.ok(buckets instanceof Map, "the limiter no longer keeps a map — re-check F-08");

  // Fresh keys are still tracked: nothing is evicted before the idle window.
  for (let i = 0; i < 5_000; i++) limiter.allow(`203.0.113.${i % 256}.${i >> 8}`, 0);
  assert.equal(buckets.size, 5_000, "fresh buckets must still be tracked");

  // One call ten minutes later reclaims every idle bucket: each has long
  // since refilled to capacity, so dropping it changes nothing observable.
  assert.equal(limiter.allow("203.0.113.1.0", 10 * 60 * 1000), true);
  assert.ok(buckets.size <= 2, `idle buckets were not reclaimed (${buckets.size})`);
  // ...and a reclaimed key simply behaves like a brand-new one.
  assert.equal(limiter.allow("203.0.113.9.0", 10 * 60 * 1000), true);

  // Hard cap: even with every key active (no idle buckets to drop), the map
  // cannot outgrow maxBuckets. Evicted keys get fresh-bucket treatment on
  // their next request — the same allowance a brand-new key already gets.
  const capped = new RateLimiter(2, 1 / 1000, 1_000);
  const cappedBuckets = (capped as unknown as { buckets: Map<string, unknown> }).buckets;
  for (let i = 0; i < 5_000; i++) capped.allow(`198.51.100.${i % 256}.${i >> 8}`, 0);
  assert.ok(cappedBuckets.size <= 1_000,
    `the map outgrew its hard cap (${cappedBuckets.size})`);

  // Zero-refill mode never idle-evicts (a permanently-denied key must not be
  // reset by eviction), but the hard cap still applies — and a RETAINED key
  // stays denied.
  const frozen = new RateLimiter(1, 0, 100);
  const frozenBuckets = (frozen as unknown as { buckets: Map<string, unknown> }).buckets;
  for (let i = 0; i < 300; i++) frozen.allow(`192.0.2.${i}`, 1_000);
  assert.ok(frozenBuckets.size <= 100,
    `the zero-refill limiter outgrew its cap (${frozenBuckets.size})`);
  assert.equal(frozen.allow("192.0.2.299", 1_000), false,
    "a retained zero-refill key was reset by eviction");
});


test("clientIp ignores X-Forwarded-For unless TRUST_PROXY is explicitly enabled", () => {
  const saved = { trust: process.env.TRUST_PROXY, proxies: process.env.TRUSTED_PROXIES };
  try {
    delete process.env.TRUST_PROXY;
    delete process.env.TRUSTED_PROXIES;
    const spoofed = request("198.51.100.7", { "x-forwarded-for": "203.0.113.99" });
    assert.equal(clientIp(spoofed), "198.51.100.7",
      "an untrusted client set the rate-limit key via X-Forwarded-For");
    assert.equal(clientIp(request(undefined)), "unknown");
  } finally {
    if (saved.trust === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = saved.trust;
    if (saved.proxies === undefined) delete process.env.TRUSTED_PROXIES; else process.env.TRUSTED_PROXIES = saved.proxies;
  }
});

test("clientIp trusts the first hop only from an allowlisted proxy, and only if it parses", () => {
  const saved = { trust: process.env.TRUST_PROXY, proxies: process.env.TRUSTED_PROXIES };
  try {
    process.env.TRUST_PROXY = "1";
    process.env.TRUSTED_PROXIES = "10.0.0.1";
    // Allowlisted proxy → the forwarded client IP is used.
    assert.equal(clientIp(request("10.0.0.1", { "x-forwarded-for": "203.0.113.5, 10.0.0.1" })),
      "203.0.113.5");
    // A non-allowlisted socket may not set the key, even with TRUST_PROXY on.
    assert.equal(clientIp(request("198.51.100.7", { "x-forwarded-for": "203.0.113.99" })),
      "198.51.100.7");
    // Garbage in the header falls back to the socket peer instead of becoming
    // an unbounded-cardinality rate-limit key.
    assert.equal(clientIp(request("10.0.0.1", { "x-forwarded-for": "not-an-ip" })), "10.0.0.1");
    assert.equal(clientIp(request("10.0.0.1", { "x-forwarded-for": "" })), "10.0.0.1");
    assert.equal(clientIp(request("10.0.0.1", { "x-forwarded-for": ["a", "b"] })), "10.0.0.1");
    // IPv6 is accepted as a key.
    assert.equal(clientIp(request("10.0.0.1", { "x-forwarded-for": "2001:db8::1" })), "2001:db8::1");
  } finally {
    if (saved.trust === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = saved.trust;
    if (saved.proxies === undefined) delete process.env.TRUSTED_PROXIES; else process.env.TRUSTED_PROXIES = saved.proxies;
  }
});
