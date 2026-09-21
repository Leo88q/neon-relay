/**
 * HTTP primitive tests: malformed JSON fails closed, and the client IP only
 * trusts X-Forwarded-For when TRUST_PROXY=1 (CRITICAL-04 rate-limiter bypass).
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { HttpError, clientIp, readJsonBody } from "../src/http.ts";

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
