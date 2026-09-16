import test from "node:test";
import assert from "node:assert/strict";
import { getJson, postJson, startTestApp, makeWallet, authenticate } from "./helpers.ts";
import type { Config } from "../src/config.ts";

/** Always closes the app, even when an assertion throws mid-test. */
async function withApp<T>(
  overrides: Partial<Config>,
  fn: (base: string) => Promise<T>,
): Promise<T> {
  const { app, base } = await startTestApp(overrides);
  try {
    return await fn(base);
  } finally {
    await app.close();
  }
}

test("health reports migrations", () => withApp({}, async (base) => {
  const res = await getJson(base, "/v1/health");
  assert.equal(res.status, 200);
  assert.equal(res.json.status, "ok");
  assert.ok(res.json.migrations >= 1);
}));

test("unknown routes are 404, never a stub", () => withApp({}, async (base) => {
  const res = await getJson(base, "/v1/rewards/balance");
  assert.equal(res.status, 404);
  assert.equal(res.json.error.code, "not-found");
}));

test("full happy path: challenge, sign, verify, session, link, unlink", () =>
  withApp({}, async (base) => {
    const wallet = makeWallet();
    const auth = await authenticate(base, wallet);
    assert.equal(auth.status, 200);
    assert.ok(auth.json.session_token);
    assert.ok(auth.json.wallet_binding_id);
    assert.equal(auth.json.account.public_key, wallet.publicKeyBase64);
    assert.equal(auth.json.account.label, "test wallet");

    const token = auth.json.session_token as string;
    const me = await getJson(base, "/v1/wallet", token);
    assert.equal(me.status, 200);
    assert.equal(me.json.player_id, null);

    const linked = await postJson(base, "/v1/wallet/link", { player_id: "player-42" }, token);
    assert.equal(linked.status, 200);
    assert.equal(linked.json.player_id, "player-42");

    const meAgain = await getJson(base, "/v1/wallet", token);
    assert.equal(meAgain.json.player_id, "player-42");

    const unlinked = await postJson(base, "/v1/wallet/unlink", {}, token);
    assert.equal(unlinked.status, 200);
    const after = await getJson(base, "/v1/wallet", token);
    assert.equal(after.status, 401);
    // unlink revokes the binding *and* its sessions; the session check fires first
    assert.equal(after.json.error.code, "session-revoked");
  }));

test("replaying the same signed challenge is rejected", () => withApp({}, async (base) => {
  const wallet = makeWallet();
  const challenge = await postJson(base, "/v1/auth/challenge", {});
  const bytes = Buffer.from(challenge.json.challenge as string, "base64url");
  const body = {
    challenge: bytes.toString("base64url"),
    signature: wallet.sign(bytes).toString("base64url"),
    public_key: wallet.publicKeyBase64,
  };
  const first = await postJson(base, "/v1/auth/verify-wallet", body);
  assert.equal(first.status, 200);
  const replay = await postJson(base, "/v1/auth/verify-wallet", body);
  assert.equal(replay.status, 409);
  assert.equal(replay.json.error.code, "nonce-replayed");
}));

test("a signature from another wallet is rejected", () => withApp({}, async (base) => {
  const wallet = makeWallet();
  const other = makeWallet();
  const challenge = await postJson(base, "/v1/auth/challenge", {});
  const bytes = Buffer.from(challenge.json.challenge as string, "base64url");
  const badSig = await postJson(base, "/v1/auth/verify-wallet", {
    challenge: bytes.toString("base64url"),
    signature: other.sign(bytes).toString("base64url"),
    public_key: wallet.publicKeyBase64,
  });
  assert.equal(badSig.status, 401);
  assert.equal(badSig.json.error.code, "bad-signature");
}));

test("malformed public keys are a 400", () => withApp({}, async (base) => {
  const wallet = makeWallet();
  const challenge = await postJson(base, "/v1/auth/challenge", {});
  const bytes = Buffer.from(challenge.json.challenge as string, "base64url");
  const badKey = await postJson(base, "/v1/auth/verify-wallet", {
    challenge: bytes.toString("base64url"),
    signature: wallet.sign(bytes).toString("base64url"),
    public_key: "not-a-key",
  });
  assert.equal(badKey.status, 400);
  assert.equal(badKey.json.error.code, "bad-public-key");
}));

test("a challenge issued for another domain is rejected", async () => {
  const victim = await startTestApp({});
  const foreign = await startTestApp({ authDomain: "evil.example" });
  try {
    const wallet = makeWallet();
    const foreignChallenge = await postJson(foreign.base, "/v1/auth/challenge", {});
    const foreignBytes = Buffer.from(foreignChallenge.json.challenge as string, "base64url");
    const crossDomain = await postJson(victim.base, "/v1/auth/verify-wallet", {
      challenge: foreignBytes.toString("base64url"),
      signature: wallet.sign(foreignBytes).toString("base64url"),
      public_key: wallet.publicKeyBase64,
    });
    assert.equal(crossDomain.status, 422);
    assert.equal(crossDomain.json.error.code, "wrong-domain");
  } finally {
    await victim.app.close();
    await foreign.app.close();
  }
});

test("expired challenges are rejected", async () => {
  const { app, base } = await startTestApp({ challengeTtlMs: 1 });
  try {
    const wallet = makeWallet();
    const challenge = await postJson(base, "/v1/auth/challenge", {});
    await new Promise((r) => setTimeout(r, 10));
    const bytes = Buffer.from(challenge.json.challenge as string, "base64url");
    const expired = await postJson(base, "/v1/auth/verify-wallet", {
      challenge: bytes.toString("base64url"),
      signature: wallet.sign(bytes).toString("base64url"),
      public_key: wallet.publicKeyBase64,
    });
    assert.equal(expired.status, 410);
    assert.equal(expired.json.error.code, "challenge-expired");
  } finally {
    await app.close();
  }
});

test("tampered challenge bytes fail the canonical-form check", () => withApp({}, async (base) => {
  const wallet = makeWallet();
  const challenge = await postJson(base, "/v1/auth/challenge", {});
  const bytes = Buffer.from(challenge.json.challenge as string, "base64url");
  const parsed = JSON.parse(bytes.toString("utf8"));
  // same fields, different key order: valid JSON, but not the canonical byte
  // string the wallet must have signed
  const tampered = Buffer.from(JSON.stringify({
    nonce: parsed.nonce,
    v: parsed.v,
    purpose: parsed.purpose,
    domain: parsed.domain,
    issued_at: parsed.issued_at,
    expires_at: parsed.expires_at,
  }), "utf8");
  const res = await postJson(base, "/v1/auth/verify-wallet", {
    challenge: tampered.toString("base64url"),
    signature: wallet.sign(tampered).toString("base64url"),
    public_key: wallet.publicKeyBase64,
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.error.code, "bad-challenge");
}));

test("sessions require a bearer token", () => withApp({}, async (base) => {
  const anon = await getJson(base, "/v1/wallet");
  assert.equal(anon.status, 401);
  assert.equal(anon.json.error.code, "session-missing");
  const bogus = await getJson(base, "/v1/wallet", "nope");
  assert.equal(bogus.status, 401);
}));

test("a second verification for the same wallet reuses the binding", () =>
  withApp({}, async (base) => {
    const wallet = makeWallet();
    const first = await authenticate(base, wallet);
    const second = await authenticate(base, wallet);
    assert.equal(first.json.wallet_binding_id, second.json.wallet_binding_id);
    assert.notEqual(first.json.session_token, second.json.session_token);
  }));
