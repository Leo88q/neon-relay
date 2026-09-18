/** The fake trusted context is confined to this test; production needs an account adapter. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { authenticate, makeWallet, postJson, getJson, startTestApp } from "../backend/test/helpers.ts";
const signer = process.env.NEONRELAY_IDENTITY_TEST_PUBLIC_KEY!;
const { app, base } = await startTestApp({ gameIdentityPublicKey: signer });
try {
  const wallet = makeWallet();
  const auth = await authenticate(base, wallet);
  assert.equal(auth.status, 200);
  const token = auth.json.session_token;
  const challenge = await postJson(base, "/v2/identity/challenge", { player_id: 'account-игрок-"7"' }, token);
  assert.equal(challenge.status, 200);
  const raw = Buffer.from(challenge.json.challenge, "base64url").toString();
  const p = JSON.parse(raw);
  const fields = [p.domain, p.player_id, p.wallet, p.session_id, p.wallet_binding_id, p.nonce,
    String(p.issued_at), String(p.expires_at), String(p.issued_at), String(p.expires_at), "yes", raw];
  const invoke = (input: string[]) => spawnSync(process.env.NEONRELAY_IDENTITY_TEST_BIN!,
    [process.env.NEONRELAY_IDENTITY_TEST_SEED_FILE!], { input: input.join("\n") + "\n", encoding: "utf8" });
  const result = invoke(fields);
  assert.equal(result.status, 0, result.stderr);
  const signature = result.stdout.trim();
  assert.match(signature, /^[A-Za-z0-9_-]{86}$/);
  // Independently change trusted context, time, consent and raw payload.
  for (const [index, value] of [[0, "evil.example"], [1, "nickname"], [2, makeWallet().publicKeyBase64],
    [3, "00000000-0000-0000-0000-000000000000"], [4, "00000000-0000-0000-0000-000000000000"],
    [5, "?"], [6, String(p.issued_at + 1)], [7, String(p.expires_at + 1)],
    [8, String(p.expires_at)], [9, String(p.issued_at)], [10, "no"], [11, raw + " "]] as [number, string][]) {
    const changed = [...fields]; changed[index] = value;
    assert.equal(invoke(changed).status, 3, `must reject altered context field ${index}`);
  }
  for (const field of ["purpose", "signer", "player_id", "domain"]) {
    const changed = [...fields]; changed[11] = JSON.stringify({ ...p, [field]: "forged" });
    assert.equal(invoke(changed).status, 3, `must reject payload ${field}`);
  }
  const verified = await postJson(base, "/v2/identity/verify", { nonce: p.nonce, signature }, token);
  assert.equal(verified.status, 200);
  assert.equal(verified.json.verified, true);
  assert.equal(verified.json.admissionEnabled, false);
  assert.equal((await getJson(base, "/v2/identity", token)).json.player_id, p.player_id);
  assert.equal((await postJson(base, "/v2/identity/verify", { nonce: p.nonce, signature }, token)).status, 409);
  console.log("PASS: guarded C++ identity signing -> backend HTTP verification, 16 rejection cases and replay");
} finally { await app.close(); }
