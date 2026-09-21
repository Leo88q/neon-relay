import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createPublicKey, diffieHellman, hkdfSync, createHash, createDecipheriv } from "node:crypto";
import { authenticate, makeWallet, startTestApp, postJson } from "./helpers.ts";
import { registerGameAccount, pairingProofBytes } from "../src/game_pairing.ts";
import { sha256Hex } from "../src/crypto.ts";
async function setup() {
  const signer = makeWallet(), wallet = makeWallet(), ephemeral = generateKeyPairSync("x25519");
  const { app, base } = await startTestApp({ gameIdentityPublicKey: signer.publicKeyBase64 });
  registerGameAccount(app.db, "registered-account", wallet.publicKeyBase64);
  const token = (await authenticate(base, wallet)).json.session_token;
  const now = Date.now();
  const payload = { v: 1, purpose: "neonrelay-game-pairing-seal", domain: app.config.authDomain,
    connection_nonce: "ab".repeat(32), server_ephemeral_key: ephemeral.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex"),
    issued_at: now, expires_at: now + 120000 };
  const request = (p = payload) => { const offer = JSON.stringify(p); return { offer, signature: signer.sign(Buffer.from(offer)).toString("base64url"), consent: true }; };
  return { signer, wallet, ephemeral, app, base, token, payload, request };
}
test("sealed pairing encrypts the real one-use token and binds exact offer as AAD", async () => {
  const s = await setup();
  try {
    const body = s.request();
    const result = await postJson(s.base, "/v2/game/pair-sealed", body, s.token);
    assert.equal(result.status, 200);
    assert.equal(result.json.admissionEnabled, false);
    assert.equal(result.json.pairing_token, undefined);
    const peer = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), Buffer.from(result.json.sender_key, "hex")]), format: "der", type: "spki" });
    const shared = diffieHellman({ privateKey: s.ephemeral.privateKey, publicKey: peer });
    const key = Buffer.from(hkdfSync("sha256", shared, createHash("sha256").update(body.offer).digest(), Buffer.from("neonrelay:game-pairing-seal:v1"), 32));
    const decrypt = (aad: string, tag: string) => {
      const c = createDecipheriv("aes-256-gcm", key, Buffer.from(result.json.iv, "hex"));
      c.setAAD(Buffer.from(aad)); c.setAuthTag(Buffer.from(tag, "hex"));
      return Buffer.concat([c.update(Buffer.from(result.json.ciphertext, "hex")), c.final()]).toString();
    };
    assert.throws(() => decrypt(body.offer + " ", result.json.tag));
    assert.throws(() => decrypt(body.offer, "00".repeat(16)));
    const plain = decrypt(body.offer, result.json.tag);
    assert.match(plain, /^[A-Za-z0-9_-]{43}$/);
    const stored = s.app.db.get<any>("SELECT * FROM game_pairings")!;
    assert.equal(stored.token_hash, sha256Hex(plain));
    assert.ok(stored.expires_at <= s.payload.expires_at);
    assert.ok(!JSON.stringify(result.json).includes(plain));
    const signature = s.signer.sign(pairingProofBytes(s.app.config.authDomain, sha256Hex(plain), s.payload.connection_nonce)).toString("base64url");
    assert.equal((await postJson(s.base, "/v2/game/redeem", { pairing_token: plain, connection_nonce: s.payload.connection_nonce, signature })).status, 200);
  } finally { await s.app.close(); }
});
test("untrusted offers, wrong domain/purpose, expiry, extra keys and low-order X25519 fail closed", async () => {
  const s = await setup();
  try {
    for (const patch of [{ domain: "evil.example" }, { purpose: "other" }, { expires_at: 0 },
      { issued_at: Date.now() + 100000 }, { server_ephemeral_key: "00".repeat(32) }, { extra: 1 }]) {
      const response = await postJson(s.base, "/v2/game/pair-sealed", s.request({ ...s.payload, ...patch }), s.token);
      assert.equal(response.status, 400);
    }
    const body = s.request();
    body.signature = s.wallet.sign(Buffer.from(body.offer)).toString("base64url");
    assert.equal((await postJson(s.base, "/v2/game/pair-sealed", body, s.token)).status, 400);
    assert.equal(s.app.db.get<any>("SELECT count(*) AS n FROM game_pairings")!.n, 0);
  } finally { await s.app.close(); }
});
test("sealed issuance retains session, registry and explicit-consent requirements", async () => {
  const s = await setup();
  try {
    assert.equal((await postJson(s.base, "/v2/game/pair-sealed", s.request())).status, 401);
    assert.equal((await postJson(s.base, "/v2/game/pair-sealed", { ...s.request(), consent: false }, s.token)).status, 400);
    s.app.db.run("UPDATE game_accounts SET enabled=0");
    assert.equal((await postJson(s.base, "/v2/game/pair-sealed", s.request(), s.token)).status, 403);
  } finally { await s.app.close(); }
});
test("sealed pairing is disabled without an identity key", async () => {
  const wallet = makeWallet();
  const { app, base } = await startTestApp({});
  try {
    const token = (await authenticate(base, wallet)).json.session_token;
    const res = await postJson(base, "/v2/game/pair-sealed",
      { offer: "x", signature: "s".repeat(86), consent: true }, token);
    assert.equal(res.status, 503);
    assert.equal(res.json.error.code, "identity-not-configured");
  } finally { await app.close(); }
});
