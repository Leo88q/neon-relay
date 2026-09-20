import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { base58Encode } from "../src/economy.ts";
import { EconomyV2Store } from "../src/economy_v2_store.ts";
import { authenticate, getJson, postJson, makeWallet, startTestApp } from "./helpers.ts";
import { v2Fixture } from "./v2_rpc_fixture.ts";

async function setup() {
  const wallet = makeWallet();
  let fixture = v2Fixture(wallet.rawPublicKey);
  let failed = false;
  const rpc = createServer(async (req, res) => {
    try {
      let body = ""; for await (const chunk of req) body += chunk;
      const { method, params } = JSON.parse(body);
      if (failed) throw new Error("offline");
      const result = await fixture.rpc(method, params);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
    } catch { res.statusCode = 503; res.end("unavailable"); }
  });
  await new Promise<void>((resolve) => rpc.listen(0, "127.0.0.1", resolve));
  const port = (rpc.address() as { port: number }).port;
  const { app, base } = await startTestApp({ rpcUrl: `http://127.0.0.1:${port}`,
    economyProgramId: base58Encode(fixture.program), skrMint: base58Encode(fixture.mint) });
  const auth = await authenticate(base, wallet);
  assert.equal(auth.status, 200);
  const token = auth.json.session_token;
  return { app, base, token, wallet, fixture: () => fixture,
    fail: () => { failed = true; },
    seed: () => {
      const store = new EconomyV2Store(app.db);
      store.openEpoch(fixture.mint, 1n, 100000000n);
      const intent = store.createIntent({ mint: fixture.mint, wallet: wallet.rawPublicKey,
        epoch: 1n, playerId: "player-1", idempotencyKey: "entry-1", kind: 0,
        tier: "micro-sprint", amountBase: fixture.fees[0]! });
      fixture = v2Fixture(wallet.rawPublicKey, Buffer.from(intent.reference, "hex"));
    },
    close: async () => { await app.close(); await new Promise<void>((resolve) => rpc.close(() => resolve())); },
  };
}

test("v2 market requires auth/config and never enables payments", async () => {
  const s = await setup();
  try {
    assert.equal((await getJson(s.base, "/v2/economy/market?currency=SKR")).status, 401);
    assert.equal(s.fixture().callCount(), 0);
    for (const query of ["", "?currency=BAD", "?currency=SKR&currency=SKR"]) {
      assert.equal((await getJson(s.base, `/v2/economy/market${query}`, s.token)).status, 400);
    }
    assert.equal((await getJson(s.base, "/v2/economy/market?currency=POTATO", s.token)).status, 503);
    const result = await getJson(s.base, "/v2/economy/market?currency=SKR", s.token);
    assert.equal(result.status, 200); assert.equal(result.json.paymentsEnabled, false);
    s.fixture().vaultData[108] = 2;
    assert.equal((await getJson(s.base, "/v2/economy/market?currency=SKR", s.token)).json.error.code, "market-invalid");
    s.fail();
    assert.equal((await getJson(s.base, "/v2/economy/market?currency=SKR", s.token)).status, 502);
  } finally { await s.close(); }
});

test("ticket inspection loads the immutable intent and binds both player and wallet", async () => {
  const s = await setup();
  const path = "/v2/economy/ticket?currency=SKR&idempotency_key=entry-1";
  try {
    s.seed();
    assert.equal((await getJson(s.base, path, s.token)).status, 403);
    await postJson(s.base, "/v1/wallet/link", { player_id: "player-1" }, s.token);
    assert.equal((await getJson(s.base, path.replace("entry-1", "missing"), s.token)).status, 404);
    assert.equal((await getJson(s.base, path + "&idempotency_key=entry-1", s.token)).status, 400);
    const result = await getJson(s.base, path, s.token);
    assert.equal(result.status, 200); assert.equal(result.json.ticket.ticketed, true);
    assert.equal(result.json.admissionEnabled, false); assert.equal(result.json.market.paymentsEnabled, false);
    const other = await authenticate(s.base, makeWallet());
    await postJson(s.base, "/v1/wallet/link", { player_id: "player-1" }, other.json.session_token);
    assert.equal((await getJson(s.base, path, other.json.session_token)).json.error.code, "intent-wallet-mismatch");
    await postJson(s.base, "/v1/wallet/link", { player_id: "another-player" }, s.token);
    assert.equal((await getJson(s.base, path, s.token)).status, 404);
    await postJson(s.base, "/v1/wallet/unlink", {}, s.token);
    assert.equal((await getJson(s.base, path, s.token)).status, 401);
  } finally { await s.close(); }
});

test("v2 RPC inspection is rate limited before network reads", async () => {
  const s = await setup();
  try {
    for (let i = 0; i < 10; i++) await getJson(s.base, "/v2/economy/market?currency=BAD", s.token);
    assert.equal((await getJson(s.base, "/v2/economy/market?currency=SKR", s.token)).status, 429);
    assert.equal(s.fixture().callCount(), 0);
  } finally { await s.close(); }
});
