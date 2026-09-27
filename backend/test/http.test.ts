/**
 * HTTP primitive tests: malformed JSON fails closed, and the client IP only
 * trusts X-Forwarded-For when TRUST_PROXY=1 (CRITICAL-04 rate-limiter bypass).
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { HttpError, Router, bearerToken, clientIp, readJsonBody } from "../src/http.ts";

const bodyOf = (text: string): IncomingMessage =>
  Readable.from([Buffer.from(text, "utf8")]) as unknown as IncomingMessage;

const reqWith = (headers: Record<string, string>): IncomingMessage =>
  ({ headers, socket: { remoteAddress: "10.0.0.9" } }) as unknown as IncomingMessage;

function withTrustProxy(value: string | undefined, fn: () => void): void {
  const prev = process.env.TRUST_PROXY;
  try {
    if (value === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = value;
    fn();
  } finally {
    if (prev === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = prev;
  }
}

test("malformed JSON bodies fail closed as bad-json", async () => {
  await assert.rejects(readJsonBody(bodyOf("{nope")),
    (e: Error) => e instanceof HttpError && e.code === "bad-json" && e.status === 400);
});

test("client IP trusts x-forwarded-for only when TRUST_PROXY=1", () => {
  withTrustProxy("1", () => {
    assert.equal(clientIp(reqWith({ "x-forwarded-for": " 203.0.113.7 , 10.0.0.1 " })), "203.0.113.7");
  });
  withTrustProxy(undefined, () => {
    assert.equal(clientIp(reqWith({ "x-forwarded-for": "203.0.113.7" })), "10.0.0.9");
  });
});

test("client IP falls back to the socket peer on short or absent headers", () => {
  withTrustProxy("1", () => {
    assert.equal(clientIp(reqWith({ "x-forwarded-for": "x" })), "10.0.0.9");
    assert.equal(clientIp(reqWith({})), "10.0.0.9");
  });
});

test("bearerToken only accepts a single string Authorization header", () => {
  assert.equal(bearerToken(reqWith({ authorization: "Bearer abc" })), "abc");
  assert.equal(bearerToken(reqWith({ authorization: "Basic abc" })), null);
  // Node delivers repeated headers as string[]; those must never authenticate.
  assert.equal(bearerToken(reqWith({ authorization: ["Bearer abc"] })), null);
  assert.equal(bearerToken(reqWith({})), null);
});

test("readJsonBody enforces the byte limit with 413 before buffering the rest", async () => {
  await assert.rejects(readJsonBody(bodyOf('{"a":11}'), 4), (err: unknown) =>
    err instanceof HttpError && err.status === 413 && err.code === "payload-too-large");
  assert.deepEqual(await readJsonBody(bodyOf('{"a":1}'), 64), { a: 1 });
});

test("router pattern matching captures params and rejects shape mismatches", () => {
  const router = new Router();
  router.add("GET", "/watchtower/events/:signature", () => ({}));
  router.add("POST", "/api/ingest/solana", () => ({}));

  const hit = router.resolve("GET", "/watchtower/events/abc%20def");
  assert.ok(hit, "pattern route must resolve");
  assert.deepEqual(hit.params, { signature: "abc def" });

  assert.equal(router.resolve("POST", "/watchtower/events/x"), undefined, "method must not cross");
  assert.equal(router.resolve("GET", "/watchtower/events/a/b"), undefined, "extra path segment must miss");
  assert.equal(router.resolve("GET", "/api/ingest/solana"), undefined, "exact route is method-scoped");
  const exact = router.resolve("POST", "/api/ingest/solana");
  assert.ok(exact, "exact route must resolve");
  assert.deepEqual(exact.params, {});
});
