/**
 * Stage-8 cross-language golden vectors.
 *
 * These events were signed by the C++ signer (`src/neonrelay/match_signer.cpp`
 * via `src/tools/neonrelay_match_sign`, vendored ed25519-donna) using the
 * TEST-ONLY seed `deadbeef...` x8 — reproduced by scripts/neonrelay_signer_test.sh.
 * The test proves the backend verification path (canonicalEventBytes +
 * verifySignature, the exact code /v1/rewards/events uses) accepts C++-produced
 * signatures byte-for-byte, including JSON escaping of quotes, backslashes and
 * multi-byte UTF-8. The seed is a public test vector, never a production key.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { publicKeyFromBase64Url, verifySignature } from "../src/crypto.ts";
import { canonicalEventBytes } from "../src/rewards.ts";

const TEST_VECTOR_PUBLIC_KEY = "_1dXXcevi_xNCDfMHOIBe2hqiBRdxVealY40Yv6akI4";

const GOLDEN_EVENTS = [
  {
    match_id: "6f9b8d2e-1c3a-4b5d-8e7f-0a1b2c3d4e5f:Kobra",
    player_id: "nameless tee",
    event_type: "map_finish",
    amount_micro: 250,
    occurred_at: 1760000000000,
    server_signature:
      "sUfPmPXnmmR5ETXUd-Vfhto5O1nQXOrzD7G-_UqEbSeM8KIaxfz5kWNVadzlNkCzL1fJx0DIPNsWvifUFr4MCw",
    canonical:
      '{"match_id":"6f9b8d2e-1c3a-4b5d-8e7f-0a1b2c3d4e5f:Kobra","player_id":"nameless tee",' +
      '"event_type":"map_finish","amount_micro":250,"occurred_at":1760000000000}',
  },
  {
    match_id: "aa00bb11-2233-4455-6677-8899aabbccdd:Multimap",
    player_id: 'Player "One" \\ ünïcode 日本語 🚀',
    event_type: "map_finish",
    amount_micro: 0,
    occurred_at: 1760000000001,
    server_signature:
      "2m6ozdkrF2C9VY5WMG4FoPgr5FDjsY6obhfCDaweL1TyvUQoEzoh63W-RAA1UKXTjc_webfU-iEx3o0Zpq-2Ag",
    canonical:
      '{"match_id":"aa00bb11-2233-4455-6677-8899aabbccdd:Multimap",' +
      '"player_id":"Player \\"One\\" \\\\ ünïcode 日本語 🚀",' +
      '"event_type":"map_finish","amount_micro":0,"occurred_at":1760000000001}',
  },
] as const;

test("backend canonical bytes match the C++ signer's canonical JSON", () => {
  for (const event of GOLDEN_EVENTS) {
    assert.equal(canonicalEventBytes(event).toString("utf8"), event.canonical);
  }
});

test("backend verifies C++ (ed25519-donna) signatures over the golden vectors", () => {
  const publicKey = publicKeyFromBase64Url(TEST_VECTOR_PUBLIC_KEY);
  for (const event of GOLDEN_EVENTS) {
    const ok = verifySignature(
      canonicalEventBytes(event),
      Buffer.from(event.server_signature, "base64url"),
      publicKey,
    );
    assert.equal(ok, true, `signature should verify for ${event.match_id}`);
  }
});

test("tampered golden vectors are rejected", () => {
  const publicKey = publicKeyFromBase64Url(TEST_VECTOR_PUBLIC_KEY);
  for (const event of GOLDEN_EVENTS) {
    const tampered = { ...event, amount_micro: event.amount_micro + 1 };
    const ok = verifySignature(
      canonicalEventBytes(tampered),
      Buffer.from(event.server_signature, "base64url"),
      publicKey,
    );
    assert.equal(ok, false, `tampered event must not verify for ${event.match_id}`);
  }
});
