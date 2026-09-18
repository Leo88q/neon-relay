/** Real backend dispatch + native TLS worker. Child stdin is test-only secret delivery. */
import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createApp } from "../backend/src/server.ts";
import { registerGameAccount } from "../backend/src/game_pairing.ts";
import { testConfig, makeWallet, authenticate, postJson, getJson } from "../backend/test/helpers.ts";
const [binary, certFile, keyFile] = process.argv.slice(2);
// Same PUBLIC TEST seed as native harness; never a deployment identity key.
const key = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, 0x11)]), format: "der", type: "pkcs8" });
const signer = createPublicKey(key).export({ type: "spki", format: "der" }).subarray(-32).toString("base64url");
const app = createApp(testConfig({ gameIdentityPublicKey: signer, sessionTtlMs: 300_000 }));
// Use the production app's actual request listener. No duplicate route implementation.
const tls = createServer({ cert: readFileSync(certFile!), key: readFileSync(keyFile!) },
  (req, res) => app.server.emit("request", req, res));
await new Promise<void>((resolve) => tls.listen(0, "127.0.0.1", resolve));
const base = `https://127.0.0.1:${(tls.address() as { port: number }).port}`;
const wallet = makeWallet();
registerGameAccount(app.db, "registered-account", wallet.publicKeyBase64);
try {
  const auth = await authenticate(base, wallet);
  assert.equal(auth.status, 200);
  const bearer = auth.json.session_token;
  for (const mode of ["accept", "sealed", "wrong-nonce", "disabled"]) {
    const child = spawn(binary!, ["--backend", base, mode === "sealed" ? "sealed" : mode === "accept" ? "accept" : "reject"], { stdio: ["pipe", "pipe", "pipe"] });
    let transcript = "", stderr = "";
    child.stdout.on("data", (chunk) => { transcript += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const exit = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const deadline = setTimeout(() => child.kill("SIGKILL"), 25000);
    let pairingToken = "";
    const line = async (prefix: string): Promise<string> => {
      for (;;) {
        const item = await lines.next();
        assert.equal(item.done, false, `native child stopped before ${prefix}; ${stderr.slice(-1500)}`);
        if (item.value.startsWith(prefix)) return item.value.slice(prefix.length);
      }
    };
    try {
      const nonce = await line("NONCE ");
      assert.match(nonce, /^[0-9a-f]{64}$/);
      if (mode === "sealed") {
        const offer = await line("OFFER ");
        const signature = await line("OFFER_SIGNATURE ");
        assert.equal(JSON.parse(offer).connection_nonce, nonce);
        const sealed = await postJson(base, "/v2/game/pair-sealed", { offer, signature, consent: true }, bearer);
        assert.equal(sealed.status, 200);
        assert.equal(sealed.json.pairing_token, undefined);
        assert.equal(sealed.json.admissionEnabled, false);
        child.stdin.write([sealed.json.sender_key, sealed.json.iv, sealed.json.ciphertext, sealed.json.tag].join("\n") + "\n");
      } else {
        const pair = await postJson(base, "/v2/game/pair", {
          connection_nonce: mode === "wrong-nonce" ? "ff".repeat(32) : nonce, consent: true,
        }, bearer);
        assert.equal(pair.status, 200);
        pairingToken = pair.json.pairing_token;
        if (mode === "disabled") app.db.run("UPDATE game_accounts SET enabled=0");
        child.stdin.write(pairingToken + "\n");
      }
      if (mode === "accept" || mode === "sealed") {
        assert.equal(await line("PAIRED "), "registered-account");
        const challenge = await postJson(base, "/v2/identity/challenge", { player_id: "registered-account" }, bearer);
        assert.equal(challenge.status, 200);
        const raw = Buffer.from(challenge.json.challenge, "base64url").toString();
        const payload = JSON.parse(raw);
        child.stdin.write([payload.nonce, payload.issued_at, payload.expires_at, raw].join("\n") + "\n");
        const signature = await line("SIGNATURE ");
        const verified = await postJson(base, "/v2/identity/verify", { nonce: payload.nonce, signature }, bearer);
        assert.equal(verified.status, 200);
        assert.equal(verified.json.verified, true);
        assert.equal(verified.json.admissionEnabled, false);
        assert.equal((await getJson(base, "/v2/identity", bearer)).json.player_id, "registered-account");
        await line("REPLAY_REJECTED");
      } else {
        await line("REJECTED");
      }
      child.stdin.end();
      assert.equal(await exit, 0, stderr.slice(-1500));
      if (pairingToken) assert.ok(!transcript.includes(pairingToken) && !stderr.includes(pairingToken), "pairing token leaked");
      assert.ok(!transcript.includes(bearer) && !stderr.includes(bearer), "wallet bearer leaked");
    } finally {
      clearTimeout(deadline);
      child.stdin.destroy();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exit;
    }
  }
  console.log("PASS: wallet auth -> registered pairing -> native HTTPS worker/Poll -> native identity signature -> production backend verification; replay, wrong nonce, disable and log privacy");
} finally {
  await new Promise<void>((resolve) => tls.close(() => resolve()));
  await app.close();
}
