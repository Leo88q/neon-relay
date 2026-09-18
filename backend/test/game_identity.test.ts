import test from "node:test";
import assert from "node:assert/strict";
import { authenticate, getJson, postJson, makeWallet, startTestApp } from "./helpers.ts";
async function setup() {
  const server = makeWallet(), wallet = makeWallet();
  const { app, base } = await startTestApp({ gameIdentityPublicKey: server.publicKeyBase64 });
  const auth = await authenticate(base, wallet);
  const token = auth.json.session_token;
  const issue = async () => (await postJson(base, "/v2/identity/challenge", { player_id: "player-1" }, token)).json;
  const proof = (challenge: any, signer = server) => ({ nonce: challenge.nonce, signature: signer.sign(Buffer.from(challenge.challenge, "base64url")).toString("base64url") });
  return { app, base, server, wallet, token, issue, proof };
}
test("verified identity is domain/purpose/session/wallet bound and one-use", async () => {
  const s = await setup();
  try {
    const challenge = await s.issue();
    const payload = JSON.parse(Buffer.from(challenge.challenge, "base64url").toString());
    assert.equal(payload.purpose, "neonrelay-game-identity");
    assert.equal(payload.domain, "test.neonrelay.example");
    assert.equal(payload.wallet, s.wallet.publicKeyBase64);
    assert.ok(payload.session_id); assert.ok(payload.wallet_binding_id);
    assert.ok(!JSON.stringify(payload).includes(s.token));
    const verified = await postJson(s.base, "/v2/identity/verify", s.proof(challenge), s.token);
    assert.equal(verified.status, 200); assert.equal(verified.json.verified, true);
    assert.equal(verified.json.admissionEnabled, false);
    assert.equal((await getJson(s.base, "/v2/identity", s.token)).json.verified, true);
    assert.equal((await getJson(s.base, "/v1/wallet", s.token)).json.player_id, "player-1");
    assert.equal((await postJson(s.base, "/v2/identity/verify", s.proof(challenge), s.token)).status, 409);
  } finally { await s.app.close(); }
});
test("wallet signatures and modified player/domain/purpose bytes cannot impersonate server", async () => {
  const s = await setup();
  try {
    const challenge = await s.issue();
    assert.equal((await postJson(s.base, "/v2/identity/verify", s.proof(challenge, s.wallet), s.token)).status, 403);
    for (const field of ["player_id", "domain", "purpose", "wallet"]) {
      const payload = JSON.parse(Buffer.from(challenge.challenge, "base64url").toString());
      payload[field] = "different";
      const signature = s.server.sign(Buffer.from(JSON.stringify(payload))).toString("base64url");
      assert.equal((await postJson(s.base, "/v2/identity/verify", { nonce: challenge.nonce, signature }, s.token)).status, 403);
    }
    assert.equal((await getJson(s.base, "/v2/identity", s.token)).json.verified, false);
    assert.equal((await postJson(s.base, "/v2/identity/verify", s.proof(challenge), s.token)).status, 200);
  } finally { await s.app.close(); }
});
test("even another session for the same wallet cannot redeem an identity challenge", async () => {
  const s = await setup();
  try {
    const challenge = await s.issue();
    const other = await authenticate(s.base, s.wallet);
    assert.equal((await postJson(s.base, "/v2/identity/verify", s.proof(challenge), other.json.session_token)).status, 403);
    assert.equal((await postJson(s.base, "/v2/identity/verify", s.proof(challenge), s.token)).status, 200);
    assert.equal((await getJson(s.base, "/v2/identity", other.json.session_token)).json.verified, false);
  } finally { await s.app.close(); }
});
test("self-link invalidates verification and cannot resurrect it by switching back", async () => {
  const s = await setup();
  try {
    const challenge = await s.issue();
    await postJson(s.base, "/v2/identity/verify", s.proof(challenge), s.token);
    await postJson(s.base, "/v1/wallet/link", { player_id: "other" }, s.token);
    await postJson(s.base, "/v1/wallet/link", { player_id: "player-1" }, s.token);
    assert.equal((await getJson(s.base, "/v2/identity", s.token)).json.verified, false);
    const pending = await s.issue();
    await postJson(s.base, "/v1/wallet/link", { player_id: "player-1" }, s.token);
    assert.equal((await postJson(s.base, "/v2/identity/verify", s.proof(pending), s.token)).status, 403);
    await postJson(s.base, "/v1/wallet/unlink", {}, s.token);
    assert.equal((await getJson(s.base, "/v2/identity", s.token)).status, 401);
  } finally { await s.app.close(); }
});
test("superseded/expired challenges, expired grants and key/domain changes fail closed", async () => {
  const s = await setup();
  try {
    const old = await s.issue(), current = await s.issue();
    assert.equal((await postJson(s.base, "/v2/identity/verify", s.proof(old), s.token)).status, 403);
    s.app.db.run("UPDATE game_identity_challenges SET expires_at=0 WHERE nonce=?", current.nonce);
    assert.equal((await postJson(s.base, "/v2/identity/verify", s.proof(current), s.token)).status, 409);
    const fresh = await s.issue();
    await postJson(s.base, "/v2/identity/verify", s.proof(fresh), s.token);
    s.app.config.gameIdentityPublicKey = makeWallet().publicKeyBase64;
    assert.equal((await getJson(s.base, "/v2/identity", s.token)).json.verified, false);
    s.app.config.gameIdentityPublicKey = s.server.publicKeyBase64;
    s.app.config.authDomain = "another.example";
    assert.equal((await getJson(s.base, "/v2/identity", s.token)).json.verified, false);
    s.app.config.authDomain = "test.neonrelay.example";
    s.app.db.run("UPDATE game_identity_grants SET expires_at=0");
    assert.equal((await getJson(s.base, "/v2/identity", s.token)).json.verified, false);
  } finally { await s.app.close(); }
});
test("identity routes require auth and a separately configured signer", async () => {
  const { app, base } = await startTestApp();
  try {
    assert.equal((await postJson(base, "/v2/identity/challenge", { player_id: "x" })).status, 401);
    const auth = await authenticate(base, makeWallet());
    assert.equal((await postJson(base, "/v2/identity/challenge", { player_id: "x" }, auth.json.session_token)).status, 503);
    assert.equal((await getJson(base, "/v2/identity", auth.json.session_token)).status, 503);
  } finally { await app.close(); }
});
test("identity proof encodings and request rate are bounded", async () => {
  const s = await setup();
  try {
    const c = await s.issue();
    const p = s.proof(c);
    assert.equal((await postJson(s.base, "/v2/identity/verify", { ...p, signature: p.signature + "=" }, s.token)).status, 400);
    for (let i = 0; i < 8; i++) {
      await postJson(s.base, "/v2/identity/verify", { nonce: "?", signature: "?" }, s.token);
    }
    assert.equal((await postJson(s.base, "/v2/identity/verify", p, s.token)).status, 429);
    assert.equal((await getJson(s.base, "/v2/identity", s.token)).json.verified, false);
  } finally { await s.app.close(); }
});
