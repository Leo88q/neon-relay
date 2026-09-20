/** The fake trusted context is confined to this test; production needs an account adapter. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { authenticate, makeWallet, postJson, getJson, startTestApp } from "../backend/test/helpers.ts";
const signer = process.env.NEONRELAY_IDENTITY_TEST_PUBLIC_KEY!;
const { app, base } = await startTestApp({ gameIdentityPublicKey: signer });
try {
  const wallet = makeWallet();
  // Operator-seeded Unicode fixture exercises protocol byte parity; never a public registration.
  app.db.run("INSERT INTO game_accounts(player_id,wallet) VALUES (?,?)", 'account-игрок-"7"', wallet.publicKeyBase64);
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
  const proto = (mode: string, input: string, extra: string[] = []) => spawnSync(process.env.NEONRELAY_PAIRING_PROTOCOL_TEST_BIN!,
    [mode, ...extra], { input, encoding: "utf8" });
  const connectionNonce = "cd".repeat(32);
  const pair = await postJson(base, "/v2/game/pair", { connection_nonce: connectionNonce, consent: true }, token);
  assert.equal(pair.status, 200);
  const request = proto("request", [p.domain, connectionNonce, pair.json.pairing_token].join("\n") + "\n", [process.env.NEONRELAY_IDENTITY_TEST_SEED_FILE!]);
  assert.equal(request.status, 0, request.stderr);
  const redeemed = await postJson(base, "/v2/game/redeem", JSON.parse(request.stdout));
  assert.equal(redeemed.status, 200);
  const reply = JSON.stringify(redeemed.json);
  const now = String(Date.now());
  const parsed = proto("parse", reply, [now]);
  assert.equal(parsed.status, 0); assert.equal(parsed.stdout, p.player_id);
  for (const bad of ["", "null", "[]", "{".repeat(4097),
    reply.replace('"domain":', '"domain":"duplicate","domain":'),
    JSON.stringify({ ...redeemed.json, unknown: 1 }),
    ...[ { wallet: "bad" }, { admissionEnabled: true }, { explicit_link_confirmed: false },
      { authentication_expires_at: 0 }, { authentication_expires_at: 1.5 },
      { connection_nonce: "invalid" }, { session_id: null } ].map((patch) => JSON.stringify({ ...redeemed.json, ...patch })),
  ]) assert.equal(proto("parse", bad, [now]).status, 3, "reject incompatible backend response");
  for (const origin of ["https://backend.example", "https://backend.example:8443"]) assert.equal(proto("origin", origin).status, 0);
  for (const origin of ["http://backend.example", "https://user@backend.example", "https://backend.example/path", "https://backend.example?x", "https://backend.example#x", "https://backend.example:0", "https://backend.example:65536", "https://backend.example\n", "https://"]) {
    assert.equal(proto("origin", origin).status, 3);
  }
  const envelope = { v: 1, sender_key: "ab".repeat(32), iv: "cd".repeat(12), ciphertext: "ef".repeat(43), tag: "01".repeat(16), expires_at: Date.now() + 60000, admissionEnabled: false };
  const envelopeJson = JSON.stringify(envelope);
  assert.equal(proto("envelope", envelopeJson, [now]).status, 0);
  for (const bad of ["", "[]", "{}", "x".repeat(769),
    envelopeJson.replace('"v":1', '"v":1,"v":1'),
    ...[{ v: 2 }, { v: "1" }, { tag: "01".repeat(15) }, { sender_key: "AB".repeat(32) },
      { iv: "00".repeat(13) }, { ciphertext: "ef".repeat(44) }, { expires_at: Number(now) },
      { expires_at: 9007199254740992 }, { expires_at: 1.5 }, { admissionEnabled: true },
      { admissionEnabled: 0 }, { extra: "unexpected" }, { tag: null }, { iv: [] },
    ].map((patch) => JSON.stringify({ ...envelope, ...patch }))]) {
    assert.equal(proto("envelope", bad, [now]).status, 3, "reject malformed sealed envelope");
  }
  console.log("PASS: C++ pairing proof -> backend redemption -> strict C++ reply parser; origin/schema rejection cases");
  console.log("PASS: guarded C++ identity signing -> backend HTTP verification, 16 rejection cases and replay");
} finally { await app.close(); }
