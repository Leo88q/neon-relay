import test from "node:test";
import assert from "node:assert/strict";
import { authenticate, makeWallet, postJson, startTestApp } from "./helpers.ts";
import { registerGameAccount, pairingProofBytes } from "../src/game_pairing.ts";
import { sha256Hex } from "../src/crypto.ts";
const nonce = "ab".repeat(32);
async function setup(register = true) {
  const server = makeWallet(), wallet = makeWallet();
  const { app, base } = await startTestApp({ gameIdentityPublicKey: server.publicKeyBase64 });
  const auth = await authenticate(base, wallet);
  const bearer = auth.json.session_token;
  if (register) registerGameAccount(app.db, "account-1", wallet.publicKeyBase64);
  const issue = () => postJson(base, "/v2/game/pair", { connection_nonce: nonce, consent: true }, bearer);
  const proof = (token: string, n = nonce, signer = server) => ({ pairing_token: token, connection_nonce: n,
    signature: signer.sign(pairingProofBytes(app.config.authDomain, sha256Hex(token), n)).toString("base64url") });
  return { app, base, bearer, server, wallet, issue, proof };
}
test("pairing uses registry identity, stores only token hash and redeems once", async () => {
  const s = await setup();
  try {
    await postJson(s.base, "/v1/wallet/link", { player_id: "forged-player" }, s.bearer);
    const p = await s.issue(); assert.equal(p.status, 200); assert.equal(p.json.player_id, "account-1");
    const row = s.app.db.get<any>("SELECT * FROM game_pairings")!;
    assert.equal(row.token_hash, sha256Hex(p.json.pairing_token));
    assert.ok(!JSON.stringify(row).includes(p.json.pairing_token));
    const r = await postJson(s.base, "/v2/game/redeem", s.proof(p.json.pairing_token));
    assert.equal(r.status, 200); assert.equal(r.json.player_id, "account-1");
    assert.equal(r.json.wallet, s.wallet.publicKeyBase64); assert.equal(r.json.connection_nonce, nonce);
    assert.equal(r.json.explicit_link_confirmed, true); assert.equal(r.json.admissionEnabled, false);
    assert.ok(!JSON.stringify(r.json).includes(s.bearer));
    assert.equal((await postJson(s.base, "/v2/game/redeem", s.proof(p.json.pairing_token))).status, 409);
    // Registered context can now authorize only its matching identity challenge.
    const c = await postJson(s.base, "/v2/identity/challenge", { player_id: r.json.player_id }, s.bearer);
    const payload = JSON.parse(Buffer.from(c.json.challenge, "base64url").toString());
    for (const field of ["wallet", "player_id", "session_id", "wallet_binding_id", "domain"]) assert.equal(payload[field], r.json[field]);
    const signature = s.server.sign(Buffer.from(c.json.challenge, "base64url")).toString("base64url");
    assert.equal((await postJson(s.base, "/v2/identity/verify", { nonce: c.json.nonce, signature }, s.bearer)).status, 200);
  } finally { await s.app.close(); }
});
test("self-declared links do not provision accounts; wallet registry is immutable", async () => {
  const s = await setup(false);
  try {
    await postJson(s.base, "/v1/wallet/link", { player_id: "account-1" }, s.bearer);
    assert.equal((await s.issue()).status, 403);
    registerGameAccount(s.app.db, "account-1", s.wallet.publicKeyBase64);
    assert.throws(() => registerGameAccount(s.app.db, "account-2", s.wallet.publicKeyBase64));
    assert.throws(() => registerGameAccount(s.app.db, "account-1", makeWallet().publicKeyBase64));
    assert.throws(() => s.app.db.run("UPDATE game_accounts SET player_id='other'"));
    assert.throws(() => s.app.db.run("DELETE FROM game_accounts"));
    assert.throws(() => s.app.db.run("INSERT OR REPLACE INTO game_accounts(player_id,wallet) VALUES (?,?)", "account-1", s.wallet.publicKeyBase64));
    assert.equal((await s.issue()).status, 200);
  } finally { await s.app.close(); }
});
test("wrong signer, altered nonce and another token cannot redeem pairing", async () => {
  const s = await setup();
  try {
    const p = await s.issue(), token = p.json.pairing_token;
    assert.equal((await postJson(s.base, "/v2/game/redeem", s.proof(token, nonce, s.wallet))).status, 403);
    assert.equal((await postJson(s.base, "/v2/game/redeem", { ...s.proof(token), connection_nonce: "cd".repeat(32) })).status, 403);
    assert.equal((await postJson(s.base, "/v2/game/redeem", s.proof(token, "cd".repeat(32)))).status, 409);
    assert.equal((await postJson(s.base, "/v2/game/redeem", s.proof(makeWallet().publicKeyBase64))).status, 409);
    assert.equal((await postJson(s.base, "/v2/game/redeem", s.proof(token))).status, 200);
  } finally { await s.app.close(); }
});
test("expiry, disabled accounts, revoked sessions and relinks invalidate pairing", async () => {
  for (const invalidate of [
    (s: any) => s.app.db.run("UPDATE game_pairings SET expires_at=0"),
    (s: any) => s.app.db.run("UPDATE game_accounts SET enabled=0"),
    (s: any) => s.app.db.run("UPDATE sessions SET revoked_at=1"),
    (s: any) => s.app.db.run("UPDATE wallet_bindings SET player_id='other'"),
  ]) {
    const s = await setup();
    try {
      const p = await s.issue(); invalidate(s);
      const r = await postJson(s.base, "/v2/game/redeem", s.proof(p.json.pairing_token));
      assert.ok(r.status === 403 || r.status === 409);
    } finally { await s.app.close(); }
  }
});
test("new issuance supersedes pending token and concurrent redemption has one winner", async () => {
  const s = await setup();
  try {
    const old = await s.issue(), fresh = await s.issue();
    assert.equal((await postJson(s.base, "/v2/game/redeem", s.proof(old.json.pairing_token))).status, 409);
    const results = await Promise.all([1, 2].map(() => postJson(s.base, "/v2/game/redeem", s.proof(fresh.json.pairing_token))));
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  } finally { await s.app.close(); }
});
test("pairing requires wallet authentication, explicit consent and canonical nonce", async () => {
  const s = await setup();
  try {
    assert.equal((await postJson(s.base, "/v2/game/pair", { connection_nonce: nonce, consent: true })).status, 401);
    for (const body of [{ connection_nonce: nonce }, { connection_nonce: nonce, consent: "true" }, { connection_nonce: "?", consent: true }]) {
      assert.equal((await postJson(s.base, "/v2/game/pair", body, s.bearer)).status, 400);
    }
    s.app.config.gameIdentityPublicKey = null;
    assert.equal((await s.issue()).status, 503);
  } finally { await s.app.close(); }
});
test("identity attestation cannot bypass registry with a new challenge after disabling account", async () => {
  const s = await setup();
  try {
    assert.equal((await postJson(s.base, "/v2/identity/challenge", { player_id: "unregistered" }, s.bearer)).status, 403);
    s.app.db.run("UPDATE game_accounts SET enabled=0");
    assert.equal((await postJson(s.base, "/v2/identity/challenge", { player_id: "account-1" }, s.bearer)).status, 403);
    s.app.db.run("UPDATE game_accounts SET enabled=1");
    const c = await postJson(s.base, "/v2/identity/challenge", { player_id: "account-1" }, s.bearer);
    const signature = s.server.sign(Buffer.from(c.json.challenge, "base64url")).toString("base64url");
    s.app.db.run("UPDATE game_accounts SET enabled=0");
    assert.equal((await postJson(s.base, "/v2/identity/verify", { nonce: c.json.nonce, signature }, s.bearer)).status, 403);
  } finally { await s.app.close(); }
});
test("registry provisioning rejects malformed players and keys", async () => {
  const s = await setup(false);
  try {
    const good = s.wallet.publicKeyBase64;
    assert.throws(() => registerGameAccount(s.app.db, "bad id!!", good), /stable ASCII/);
    assert.throws(() => registerGameAccount(s.app.db, "good-id", "not-a-key"), /stable ASCII/);
  } finally { await s.app.close(); }
});
test("redeem rejects malformed proof encodings before lookup", async () => {
  const s = await setup();
  try {
    const res = await postJson(s.base, "/v2/game/redeem", {
      pairing_token: "a".repeat(43), connection_nonce: "zz", signature: "sig",
    });
    assert.equal(res.status, 400);
    assert.equal(res.json.error.code, "pairing-invalid-proof");
  } finally { await s.app.close(); }
});
