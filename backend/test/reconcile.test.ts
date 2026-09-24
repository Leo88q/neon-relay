/**
 * Tranche-B reconciliation tests: PDA layouts, account parsers, comparison
 * matrix, snapshot persistence, treasury deltas and the HTTP routes (served
 * by a stub RPC + alert-webhook server).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  authenticate, getJson, makeTestServer, makeWallet, postJson, startTestApp,
} from "./helpers.ts";
import { Db, migrate } from "../src/db.ts";
import {
  base58Decode, base58Encode, findProgramAddress, isOnCurveEncoded,
} from "../src/economy.ts";
import type { RpcCaller } from "../src/economy.ts";
import {
  ReconcileError, comparePrizeEpoch, compareRewardsEpoch, parsePrizeEpochV1,
  parseRewardsEpoch, prizeEpochAddressV1, readRewardsEpochOnchain, readTreasuryState,
  reconcilePrizeEpoch, reconcileRewardsEpoch, recordReconcile, recordTreasury, rewardsEpochAddress,
} from "../src/reconcile.ts";
import { ECONOMY_V1_CONFIG_DISCRIMINATOR } from "../src/economy.ts";

const REWARDS_PROGRAM = "2RaaXKUutemHtSZUsmnEv41ytWMkaXD6rcoziHGLRtmj";
const ECONOMY_PROGRAM = "FZcLDdUrs6i1HYFFK2NhqNrbVaP6KTvrqzhyoDGT6CV9";
const OPERATOR = "op-recon";
const SUPERADMIN = "sup-recon";

const epochDisc = createHash("sha256").update("account:EpochState").digest().subarray(0, 8);
const prizeDisc = createHash("sha256").update("account:PrizeEpoch").digest().subarray(0, 8);

function rewardsEpochBytes(
  id: number, root: string, leafCount: number, total: bigint = 100n, remaining: bigint = total,
): Buffer {
  const data = Buffer.alloc(77);
  epochDisc.copy(data, 0);
  data.writeBigUInt64LE(BigInt(id), 8);
  Buffer.from(root, "hex").copy(data, 16);
  data.writeBigInt64LE(1_700_000_000n, 48);
  data[56] = 255;
  data.writeUInt32LE(leafCount, 57);
  data.writeBigUInt64LE(total, 61);
  data.writeBigUInt64LE(remaining, 69);
  return data;
}

function prizeEpochBytes(epoch: number, root: string, total: bigint, leafCount: number): Buffer {
  const data = Buffer.alloc(69);
  prizeDisc.copy(data, 0);
  data.writeBigUInt64LE(BigInt(epoch), 8);
  Buffer.from(root, "hex").copy(data, 16);
  data.writeBigUInt64LE(total, 48);
  data.writeUInt32LE(leafCount, 56);
  data.writeBigInt64LE(1_700_000_000n, 60);
  data[68] = 254;
  return data;
}

function mockRpc(accounts: Map<string, Buffer | null>, program: string): RpcCaller {
  return async (method, params) => {
    assert.equal(method, "getAccountInfo");
    const data = accounts.get(params[0] as string);
    if (data === undefined || data === null) return { value: null };
    return {
      value: { owner: program, executable: false, data: [data.toString("base64"), "base64"] },
    };
  };
}

test("epoch PDAs are deterministic, off-curve and endian-sensitive", () => {
  const program = base58Decode(REWARDS_PROGRAM);
  const a = rewardsEpochAddress(7, program);
  assert.deepEqual(a, rewardsEpochAddress(7, program));
  assert.equal(a.length, 32);
  assert.equal(isOnCurveEncoded(a), false);
  // rewards uses u64be, economy v1 uses u64le: same epoch, different PDA
  const b = prizeEpochAddressV1(7, base58Decode(ECONOMY_PROGRAM));
  assert.notDeepEqual(a.toString("hex"), b.toString("hex"));
  // endian pin: manual seed hash must reproduce the helper (bump search aside)
  const be = Buffer.alloc(8);
  be.writeBigUInt64BE(7n);
  const { address } = findProgramAddress([Buffer.from("neonrelay_epoch"), be], program);
  assert.deepEqual(address, a);
});

test("account parsers accept exact layouts and reject impostors", () => {
  const root = createHash("sha256").update("root").digest("hex");
  assert.deepEqual(parseRewardsEpoch(rewardsEpochBytes(9, root, 3, 900n, 700n)),
    { id: "9", root, publishedAt: "1700000000", leafCount: 3, total: "900", remaining: "700" });
  assert.deepEqual(parsePrizeEpochV1(prizeEpochBytes(4, root, 500n, 2)),
    { epoch: "4", root, total: "500", leafCount: 2, publishedAt: "1700000000" });
  assert.throws(() => parseRewardsEpoch(Buffer.alloc(77)),
    (e: Error) => e instanceof ReconcileError && e.code === "bad-account");
  assert.throws(() => parseRewardsEpoch(rewardsEpochBytes(1, root, 1).subarray(0, 76)),
    (e: Error) => e instanceof ReconcileError && e.code === "bad-account");
  assert.throws(() => parsePrizeEpochV1(Buffer.alloc(69)),
    (e: Error) => e instanceof ReconcileError && e.code === "bad-account");
  // cross-type: a prize account is not a rewards epoch
  assert.throws(() => parseRewardsEpoch(prizeEpochBytes(1, root, 1n, 1).subarray(0, 61)),
    (e: Error) => e instanceof ReconcileError);
});

test("rewards comparison matrix", () => {
  const sealed = { id: 44, state: "sealed", merkle_root: "ab".repeat(32), total_micro: 100, leaf_count: 2 };
  const onchain = {
    id: "44", root: "ab".repeat(32), leafCount: 2, total: "100", remaining: "100", publishedAt: "1",
  };
  assert.equal(compareRewardsEpoch(undefined, null).status, "missing-both");
  assert.equal(compareRewardsEpoch(undefined, onchain).status, "missing-backend");
  assert.equal(compareRewardsEpoch({ ...sealed, state: "open" }, null).status, "not-sealed");
  assert.equal(compareRewardsEpoch({ ...sealed, state: "open" }, onchain).status, "unexpected-onchain");
  assert.equal(compareRewardsEpoch(sealed, null).status, "missing-onchain");
  assert.equal(compareRewardsEpoch(sealed, onchain).status, "match");
  const badRoot = compareRewardsEpoch(sealed, { ...onchain, root: "ff".repeat(32) });
  assert.equal(badRoot.status, "mismatch:root");
  const badCount = compareRewardsEpoch(sealed, { ...onchain, leafCount: 5 });
  assert.equal(badCount.status, "mismatch:leaf-count");
  const badTotal = compareRewardsEpoch(sealed, { ...onchain, total: "99" });
  assert.equal(badTotal.status, "mismatch:total");
  assert.throws(() => parseRewardsEpoch(rewardsEpochBytes(9, "aa".repeat(32), 1, 10n, 11n)),
    (e: Error) => e instanceof ReconcileError && e.code === "bad-account");
});

test("prize comparison tolerates claimed lag but never a leading total", () => {
  const dist = JSON.stringify([
    { wallet: "w1", amount_micro: 60, place: 1 },
    { wallet: "w2", amount_micro: 40, place: 2 },
  ]);
  const backend = { epoch: 7, root: "cd".repeat(32), total_micro: 100, distribution: dist };
  const onchain = { epoch: "7", root: "cd".repeat(32), total: "100", leafCount: 2, publishedAt: "1" };
  assert.equal(comparePrizeEpoch(backend, onchain).status, "match");
  // 30 claimed on-chain: backend 100 vs chain 70 is expected, reported as detail
  const lagging = comparePrizeEpoch(backend, { ...onchain, total: "70" });
  assert.equal(lagging.status, "match");
  assert.equal((lagging.details as Record<string, string>).claimed_micro, "30");
  // chain leading the backend is impossible without tampering
  assert.equal(comparePrizeEpoch(backend, { ...onchain, total: "101" }).status, "mismatch:total");
  assert.equal(
    comparePrizeEpoch(backend, { ...onchain, root: "00".repeat(32) }).status, "mismatch:root");
  assert.equal(comparePrizeEpoch(backend, { ...onchain, leafCount: 3 }).status, "mismatch:leaf-count");
  assert.equal(comparePrizeEpoch(backend, null).status, "missing-onchain");
  assert.equal(comparePrizeEpoch(undefined, onchain).status, "missing-backend");
});

test("rewards reconcile persists snapshots for match and missing legs", async () => {
  const db = new Db(":memory:");
  try {
    migrate(db);
    const root = createHash("sha256").update("sealed-root").digest("hex");
    db.run(
      "INSERT INTO reward_epochs (id, state, started_at, ended_at, sealed_at, merkle_root, total_micro, leaf_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      44, "sealed", 1, 2, 3, root, 100, 2);
    const program = base58Decode(REWARDS_PROGRAM);
    const addr = base58Encode(rewardsEpochAddress(44, program));
    const rpc = mockRpc(new Map([[addr, rewardsEpochBytes(44, root, 2)]]), REWARDS_PROGRAM);
    const matched = await reconcileRewardsEpoch(db, rpc, REWARDS_PROGRAM, 44);
    assert.equal(matched.status, "match");
    assert.ok(matched.snapshot_id > 0);
    const missing = await reconcileRewardsEpoch(db, mockRpc(new Map(), REWARDS_PROGRAM), REWARDS_PROGRAM, 44);
    assert.equal(missing.status, "missing-onchain");
    const rows = db.all<{ status: string }>(
      "SELECT status FROM reconcile_snapshots WHERE kind = 'rewards-epoch' ORDER BY id");
    assert.deepEqual(rows.map((r) => r.status), ["match", "missing-onchain"]);
    // append-only
    assert.throws(() => db.run("DELETE FROM reconcile_snapshots WHERE id = 1"));
    assert.throws(() => db.run("UPDATE reconcile_snapshots SET status = 'x' WHERE id = 1"));
  } finally {
    db.close();
  }
});

test("prize reconcile and treasury deltas", async () => {
  const db = new Db(":memory:");
  try {
    migrate(db);
    const root = createHash("sha256").update("prize-root").digest("hex");
    db.run(
      "INSERT INTO economy_epochs (epoch, root, total_micro, distribution, created_at) VALUES (?, ?, ?, ?, ?)",
      7, root, 100, JSON.stringify([{ wallet: "w1", amount_micro: 100, place: 1 }]), 1);
    const program = base58Decode(ECONOMY_PROGRAM);
    const addr = base58Encode(prizeEpochAddressV1(7, program));
    const rpc = mockRpc(new Map([[addr, prizeEpochBytes(7, root, 100n, 1)]]), ECONOMY_PROGRAM);
    const matched = await reconcilePrizeEpoch(db, rpc, ECONOMY_PROGRAM, 7);
    assert.equal(matched.status, "match");

    const first = recordTreasury(db, {
      program: ECONOMY_PROGRAM, mint: "m1", vault: "v1", treasury: "t1",
      vaultBalance: "1000", treasuryBalance: "100", reserved: "200",
    });
    assert.equal(first.vaultDelta, null);
    const second = recordTreasury(db, {
      program: ECONOMY_PROGRAM, mint: "m1", vault: "v1", treasury: "t1",
      vaultBalance: "900", treasuryBalance: "150", reserved: "200",
    });
    assert.equal(second.vaultDelta, "-100");
    assert.equal(second.treasuryDelta, "50");
    assert.equal(second.reservedDelta, "0");
    assert.throws(() => db.run("DELETE FROM treasury_snapshots WHERE id = 1"));
  } finally {
    db.close();
  }
});

test("treasury read parses config and both balances", async () => {
  const mint = createHash("sha256").update("t-mint").digest();
  const vault = createHash("sha256").update("t-vault").digest();
  const treasury = createHash("sha256").update("t-treasury").digest();
  const config = Buffer.alloc(204);
  ECONOMY_V1_CONFIG_DISCRIMINATOR.copy(config, 0);
  mint.copy(config, 40);
  treasury.copy(config, 72);
  vault.copy(config, 104);
  config.writeBigUInt64LE(25n, 156);
  const program = base58Decode(ECONOMY_PROGRAM);
  const configAddr = base58Encode(findProgramAddress(
    [Buffer.from("neonrelay_economy_config")], program).address);
  const balances = new Map([
    [base58Encode(vault), "1000"],
    [base58Encode(treasury), "120"],
  ]);
  const rpc: RpcCaller = async (method, params) => {
    if (method === "getAccountInfo") {
      assert.equal(params[0], configAddr);
      return { value: { owner: ECONOMY_PROGRAM, executable: false, data: [config.toString("base64"), "base64"] } };
    }
    assert.equal(method, "getTokenAccountBalance");
    return { value: { amount: balances.get(params[0] as string), decimals: 6 } };
  };
  const state = await readTreasuryState(rpc, ECONOMY_PROGRAM, base58Encode(mint));
  assert.equal(state.vaultBalance, "1000");
  assert.equal(state.treasuryBalance, "120");
  assert.equal(state.reserved, "25");
  await assert.rejects(readTreasuryState(rpc, ECONOMY_PROGRAM, base58Encode(vault)),
    (e: Error) => e instanceof ReconcileError && (e as ReconcileError).code === "mint-mismatch");
});

// ------------------------------------------------------------------ HTTP layer

interface StubState {
  accounts: Map<string, { owner: string; data: Buffer | null }>;
  balances: Map<string, string>;
  alerts: unknown[];
}

function startStub(state: StubState): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      if (req.url === "/alerts" && req.method === "POST") {
        state.alerts.push(JSON.parse(body));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      const msg = JSON.parse(body) as { id: number; method: string; params: unknown[] };
      let result: unknown = null;
      if (msg.method === "getAccountInfo") {
        const entry = state.accounts.get(msg.params[0] as string);
        result = entry === undefined || entry.data === null
          ? { value: null }
          : { value: { owner: entry.owner, executable: false, data: [entry.data.toString("base64"), "base64"] } };
      } else if (msg.method === "getTokenAccountBalance") {
        result = { value: { amount: state.balances.get(msg.params[0] as string) ?? "0", decimals: 6 } };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

test("prize reconcile route matches, snapshots and alerts on mismatch", async () => {
  const state: StubState = { accounts: new Map(), balances: new Map(), alerts: [] };
  const stub = await startStub(state);
  const { app, base } = await startTestApp({
    operatorToken: OPERATOR, superadminToken: SUPERADMIN,
    economyProgramId: ECONOMY_PROGRAM, rpcUrl: stub.url,
    alertWebhookUrl: `${stub.url}/alerts`,
  });
  try {
    const root = createHash("sha256").update("http-prize").digest("hex");
    app.db.run(
      "INSERT INTO economy_epochs (epoch, root, total_micro, distribution, created_at) VALUES (?, ?, ?, ?, ?)",
      7, root, 100, JSON.stringify([{ wallet: "w1", amount_micro: 100, place: 1 }]), 1);
    const addr = base58Encode(prizeEpochAddressV1(7, base58Decode(ECONOMY_PROGRAM)));
    state.accounts.set(addr, { owner: ECONOMY_PROGRAM, data: prizeEpochBytes(7, root, 100n, 1) });

    const matched = await getJson(base, "/v1/admin/reconcile/prizes?epoch=7", OPERATOR);
    assert.equal(matched.status, 200);
    assert.equal(matched.json.status, "match");
    assert.deepEqual(matched.json.alert, { alerted: false });

    // A tampered on-chain root mismatches and fires the webhook with alert=1.
    state.accounts.set(addr, { owner: ECONOMY_PROGRAM, data: prizeEpochBytes(7, "ff".repeat(32), 100n, 1) });
    const mismatched = await getJson(base, "/v1/admin/reconcile/prizes?epoch=7&alert=1", OPERATOR);
    assert.equal(mismatched.json.status, "mismatch:root");
    assert.equal((mismatched.json.alert as { alerted: boolean }).alerted, true);
    assert.equal(state.alerts.length, 1);
    assert.match((state.alerts[0] as { text: string }).text, /prize epoch 7: mismatch:root/);

    const history = await getJson(base, "/v1/admin/reconcile/snapshots?kind=prize-epoch", OPERATOR);
    assert.equal(history.json.pagination.total, 2);
    const badKind = await getJson(base, "/v1/admin/reconcile/snapshots?kind=nope", OPERATOR);
    assert.equal(badKind.status, 400);
  } finally {
    await app.close();
    await stub.close();
  }
});

test("rewards reconcile route needs config and validates epoch", async () => {
  const { app, base } = await startTestApp({ operatorToken: OPERATOR, superadminToken: SUPERADMIN });
  try {
    const unconfigured = await getJson(base, "/v1/admin/reconcile/rewards?epoch_id=1", OPERATOR);
    assert.equal(unconfigured.status, 503);
    assert.equal(unconfigured.json.error.code, "rewards-not-configured");
  } finally {
    await app.close();
  }
  const stub = await startStub({ accounts: new Map(), balances: new Map(), alerts: [] });
  const app2 = await startTestApp({
    operatorToken: OPERATOR, superadminToken: SUPERADMIN,
    rewardsProgramId: REWARDS_PROGRAM, rpcUrl: stub.url,
  });
  try {
    const bad = await getJson(app2.base, "/v1/admin/reconcile/rewards?epoch_id=-1", OPERATOR);
    assert.equal(bad.status, 400);
    const root = createHash("sha256").update("http-rewards").digest("hex");
    app2.app.db.run(
      "INSERT INTO reward_epochs (id, state, started_at, ended_at, sealed_at, merkle_root, total_micro, leaf_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      12, "sealed", 1, 2, 3, root, 50, 1);
    // No chain account served: clean missing-onchain, no alert without the flag.
    const missing = await getJson(app2.base, "/v1/admin/reconcile/rewards?epoch_id=12", OPERATOR);
    assert.equal(missing.json.status, "missing-onchain");
  } finally {
    await app2.app.close();
    await stub.close();
  }
});

test("stuck route surfaces stale intents, proposals and unreconciled closes", async () => {
  const state: StubState = { accounts: new Map(), balances: new Map(), alerts: [] };
  const stub = await startStub(state);
  const server = makeTestServer();
  const { app, base } = await startTestApp({
    serverSigningPublicKey: server.publicKeyBase64,
    epochMs: 3_600_000,
    operatorToken: OPERATOR, superadminToken: SUPERADMIN,
    alertWebhookUrl: `${stub.url}/alerts`,
  });
  try {
    const wallet = makeWallet();
    const auth = await authenticate(base, wallet);
    const token = auth.json.session_token as string;
    await postJson(base, "/v1/wallet/link", { player_id: "stuck-p1" }, token);
    await postJson(base, "/v1/rewards/events", {
      events: [server.signEvent({
        match_id: "m1", player_id: "stuck-p1",
        wallet_binding_id: auth.json.wallet_binding_id as string,
        event_type: "match_win", amount_micro: 100, occurred_at: Date.now(),
      })],
    });
    const epochs = await getJson(base, "/v1/rewards/epochs");
    const epochId = epochs.json[0].id as number;
    const proposed = await postJson(base, "/v1/admin/proposals",
      { type: "seal-reward-epoch", params: { epoch_id: epochId } }, OPERATOR);
    await postJson(base, "/v1/admin/proposals/approve",
      { proposal_id: proposed.json.id }, SUPERADMIN);
    const intent = await postJson(base, "/v1/rewards/claim-intent", { epoch_id: epochId }, token);
    await postJson(base, "/v1/rewards/claim-confirmation", {
      intent_id: intent.json.intent_id, transaction_id: "tx-stuck", status: "submitted",
    }, token);
    // Age the intent 9h back; leave the economy epoch unreconciled.
    app.db.run("UPDATE claim_intents SET updated_at = ? WHERE id = ?",
      Date.now() - 9 * 3_600_000, intent.json.intent_id as string);
    app.db.run(
      "INSERT INTO economy_epochs (epoch, root, total_micro, distribution, created_at) VALUES (?, ?, ?, ?, ?)",
      99, "ee".repeat(32), 10, "[]", Date.now());
    // A stale open proposal, inserted directly with an aged clock (the one-way
    // trigger forbids backdating through UPDATE, as it should).
    const staleId = "00000000-0000-4000-8000-000000000099";
    app.db.run(
      "INSERT INTO admin_proposals (id, type, params, proposed_by_role, proposed_by_hash, created_at, expires_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'open')",
      staleId, "seal-reward-epoch", JSON.stringify({ epoch_id: epochId + 5000 }),
      "operator", "ab".repeat(32), Date.now() - 9 * 3_600_000, Date.now() + 15 * 3_600_000);

    const stuck = await getJson(base, "/v1/admin/stuck?threshold_hours=6&alert=1", OPERATOR);
    assert.equal(stuck.status, 200);
    assert.equal(stuck.json.intents.length, 1);
    assert.equal(stuck.json.intents[0].id, intent.json.intent_id);
    assert.equal(stuck.json.proposals.length, 1);
    assert.deepEqual(stuck.json.unreconciled_prize_epochs, [99]);
    assert.equal((stuck.json.alert as { alerted: boolean }).alerted, true);
    assert.equal(state.alerts.length, 1);
    assert.match((state.alerts[0] as { text: string }).text, /claim intents stuck in submitted/);

    const fresh = await getJson(base, "/v1/admin/stuck?threshold_hours=24", OPERATOR);
    assert.deepEqual(fresh.json.intents, []);
    assert.deepEqual(fresh.json.proposals, []);
    assert.deepEqual(fresh.json.alert, { alerted: false });
    const bad = await getJson(base, "/v1/admin/stuck?threshold_hours=0", OPERATOR);
    assert.equal(bad.status, 400);
  } finally {
    await app.close();
    await stub.close();
  }
});

test("epoch PDA helpers reject non-u64 epochs", () => {
  const program = base58Decode(REWARDS_PROGRAM);
  assert.throws(() => rewardsEpochAddress(-1, program),
    (e: Error) => e instanceof ReconcileError && e.code === "bad-epoch");
  assert.throws(() => prizeEpochAddressV1(1.5, program),
    (e: Error) => e instanceof ReconcileError && e.code === "bad-epoch");
  // 2^53 itself is exactly representable (safe); 2^53+2 is the first unsafe int.
  assert.throws(() => prizeEpochAddressV1(9007199254740994, program),
    (e: Error) => e instanceof ReconcileError && e.code === "bad-epoch");
});

test("reward epoch reads map an RPC failure to rpc-unavailable", async () => {
  const rpc: RpcCaller = async () => { throw new Error("boom"); };
  await assert.rejects(readRewardsEpochOnchain(rpc, REWARDS_PROGRAM, 9),
    (e: Error) => e instanceof ReconcileError && e.code === "rpc-unavailable");
});

test("reward epoch reads reject accounts owned by another program", async () => {
  const root = createHash("sha256").update("root").digest("hex");
  const program = base58Decode(REWARDS_PROGRAM);
  const address = base58Encode(rewardsEpochAddress(9, program));
  const rpc = mockRpc(new Map([[address, rewardsEpochBytes(9, root, 3)]]), ECONOMY_PROGRAM);
  await assert.rejects(readRewardsEpochOnchain(rpc, REWARDS_PROGRAM, 9),
    (e: Error) => e instanceof ReconcileError && e.code === "bad-account");
});

test("reward epoch reads reject accounts with an unexpected size", async () => {
  const program = base58Decode(REWARDS_PROGRAM);
  const address = base58Encode(rewardsEpochAddress(9, program));
  const rpc = mockRpc(new Map([[address, Buffer.alloc(10)]]), REWARDS_PROGRAM);
  await assert.rejects(readRewardsEpochOnchain(rpc, REWARDS_PROGRAM, 9),
    (e: Error) => e instanceof ReconcileError && e.code === "bad-account");
});

test("reward epoch reads reject non-canonical account encoding", async () => {
  const root = createHash("sha256").update("root").digest("hex");
  const encoded = rewardsEpochBytes(9, root, 3).toString("base64");
  assert.equal(encoded.length, 104);
  const tampered = encoded.slice(0, 40) + "\n" + encoded.slice(41);
  const rpc: RpcCaller = async (method) => {
    assert.equal(method, "getAccountInfo");
    return { value: { owner: REWARDS_PROGRAM, executable: false, data: [tampered, "base64"] } };
  };
  await assert.rejects(readRewardsEpochOnchain(rpc, REWARDS_PROGRAM, 9),
    (e: Error) => e instanceof ReconcileError && e.code === "bad-account");
});

test("treasury reads map a balance failure to rpc-unavailable", async () => {
  const mint = createHash("sha256").update("t-mint").digest();
  const vault = createHash("sha256").update("t-vault").digest();
  const treasury = createHash("sha256").update("t-treasury").digest();
  const config = Buffer.alloc(204);
  ECONOMY_V1_CONFIG_DISCRIMINATOR.copy(config, 0);
  mint.copy(config, 40);
  treasury.copy(config, 72);
  vault.copy(config, 104);
  config.writeBigUInt64LE(25n, 156);
  const program = base58Decode(ECONOMY_PROGRAM);
  const configAddr = base58Encode(findProgramAddress(
    [Buffer.from("neonrelay_economy_config")], program).address);
  const rpc: RpcCaller = async (method, params) => {
    if (method === "getAccountInfo") {
      assert.equal(params[0], configAddr);
      return {
        value: { owner: ECONOMY_PROGRAM, executable: false, data: [config.toString("base64"), "base64"] },
      };
    }
    throw new Error("balance node down");
  };
  await assert.rejects(readTreasuryState(rpc, ECONOMY_PROGRAM, base58Encode(mint)),
    (e: Error) => e instanceof ReconcileError && e.code === "rpc-unavailable");
});

test("treasury reads reject a non-canonical balance", async () => {
  const mint = createHash("sha256").update("t-mint").digest();
  const vault = createHash("sha256").update("t-vault").digest();
  const treasury = createHash("sha256").update("t-treasury").digest();
  const config = Buffer.alloc(204);
  ECONOMY_V1_CONFIG_DISCRIMINATOR.copy(config, 0);
  mint.copy(config, 40);
  treasury.copy(config, 72);
  vault.copy(config, 104);
  config.writeBigUInt64LE(25n, 156);
  const rpc: RpcCaller = async (method) => {
    if (method === "getAccountInfo") {
      return {
        value: { owner: ECONOMY_PROGRAM, executable: false, data: [config.toString("base64"), "base64"] },
      };
    }
    return { value: { amount: "xyz", decimals: 6 } };
  };
  await assert.rejects(readTreasuryState(rpc, ECONOMY_PROGRAM, base58Encode(mint)),
    (e: Error) => e instanceof ReconcileError && e.code === "bad-balance");
});

test("prize comparison reports a both-sides-missing case", () => {
  assert.equal(comparePrizeEpoch(undefined, null).status, "missing-both");
});

test("prize comparison flags an unparseable backend distribution", () => {
  const backend = { epoch: 7, root: "cd".repeat(32), total_micro: 100, distribution: "{broken" };
  const onchain = { epoch: "7", root: "cd".repeat(32), total: "100", leafCount: 2, publishedAt: "1" };
  const result = comparePrizeEpoch(backend, onchain);
  assert.equal(result.status, "mismatch:distribution-unparseable");
  assert.ok(result.mismatches.includes("distribution-unparseable"));
});

test("rewards reconcile route maps a dead RPC to 502", async () => {
  const { app, base } = await startTestApp({
    operatorToken: OPERATOR, rewardsProgramId: REWARDS_PROGRAM, rpcUrl: "http://127.0.0.1:9",
  });
  try {
    const res = await getJson(base, "/v1/admin/reconcile/rewards?epoch_id=1", OPERATOR);
    assert.equal(res.status, 502);
    assert.equal(res.json.error.code, "rpc-unavailable");
  } finally {
    await app.close();
  }
});

test("prizes reconcile route maps a dead RPC to 502", async () => {
  const { app, base } = await startTestApp({
    operatorToken: OPERATOR, economyProgramId: ECONOMY_PROGRAM, rpcUrl: "http://127.0.0.1:9",
  });
  try {
    const res = await getJson(base, "/v1/admin/reconcile/prizes?epoch=1", OPERATOR);
    assert.equal(res.status, 502);
    assert.equal(res.json.error.code, "rpc-unavailable");
  } finally {
    await app.close();
  }
});

test("treasury snapshot route maps a dead RPC to 502", async () => {
  const { app, base } = await startTestApp({
    operatorToken: OPERATOR, economyProgramId: ECONOMY_PROGRAM, rpcUrl: "http://127.0.0.1:9",
  });
  try {
    const res = await postJson(base, "/v1/admin/treasury/snapshot", {}, OPERATOR);
    assert.equal(res.status, 502);
    assert.equal(res.json.error.code, "rpc-unavailable");
  } finally {
    await app.close();
  }
});

test("treasury snapshot route records chain state and lists it with deltas", async () => {
  const mint = createHash("sha256").update("t-mint").digest();
  const vault = createHash("sha256").update("t-vault").digest();
  const treasury = createHash("sha256").update("t-treasury").digest();
  const config = Buffer.alloc(204);
  ECONOMY_V1_CONFIG_DISCRIMINATOR.copy(config, 0);
  mint.copy(config, 40);
  treasury.copy(config, 72);
  vault.copy(config, 104);
  config.writeBigUInt64LE(25n, 156);
  const program = base58Decode(ECONOMY_PROGRAM);
  const configAddr = base58Encode(findProgramAddress(
    [Buffer.from("neonrelay_economy_config")], program).address);
  const state: StubState = {
    accounts: new Map([[configAddr, { owner: ECONOMY_PROGRAM, data: config }]]),
    balances: new Map([[base58Encode(vault), "1000"], [base58Encode(treasury), "120"]]),
    alerts: [],
  };
  const stub = await startStub(state);
  const { app, base } = await startTestApp({
    operatorToken: OPERATOR, economyProgramId: ECONOMY_PROGRAM, rpcUrl: stub.url,
  });
  try {
    const snap = await postJson(base, "/v1/admin/treasury/snapshot", {}, OPERATOR);
    assert.equal(snap.status, 200);
    assert.equal(snap.json.vaultBalance, "1000");
    assert.equal(snap.json.treasuryBalance, "120");
    assert.equal(snap.json.reserved, "25");
    const listed = await getJson(base, "/v1/admin/treasury", OPERATOR);
    assert.equal(listed.status, 200);
    assert.equal(listed.json.snapshots.length, 1);
    assert.equal(listed.json.snapshots[0].vault_balance, "1000");
    assert.equal(listed.json.snapshots[0].vault_delta, null);
  } finally {
    await app.close();
    await stub.close();
  }
});

test("reconcile snapshots route lists and filters by kind", async () => {
  const { app, base } = await startTestApp({ operatorToken: OPERATOR });
  try {
    recordReconcile(app.db, { kind: "rewards-epoch", ref: "1", status: "match" });
    recordReconcile(app.db, { kind: "prize-epoch", ref: "2", status: "match" });
    const all = await getJson(base, "/v1/admin/reconcile/snapshots", OPERATOR);
    assert.equal(all.status, 200);
    assert.equal(all.json.snapshots.length, 2);
    assert.equal(all.json.pagination.total, 2);
    const filtered = await getJson(base, "/v1/admin/reconcile/snapshots?kind=prize-epoch", OPERATOR);
    assert.equal(filtered.json.snapshots.length, 1);
    assert.equal(filtered.json.snapshots[0].kind, "prize-epoch");
  } finally {
    await app.close();
  }
});

test("reconcile snapshots route rejects unknown kinds", async () => {
  const { app, base } = await startTestApp({ operatorToken: OPERATOR });
  try {
    const res = await getJson(base, "/v1/admin/reconcile/snapshots?kind=nope", OPERATOR);
    assert.equal(res.status, 400);
  } finally {
    await app.close();
  }
});

test("treasury listing computes deltas against the previous page", async () => {
  const mint = createHash("sha256").update("t-mint").digest();
  const vault = createHash("sha256").update("t-vault").digest();
  const treasury = createHash("sha256").update("t-treasury").digest();
  const config = Buffer.alloc(204);
  ECONOMY_V1_CONFIG_DISCRIMINATOR.copy(config, 0);
  mint.copy(config, 40);
  treasury.copy(config, 72);
  vault.copy(config, 104);
  config.writeBigUInt64LE(25n, 156);
  const program = base58Decode(ECONOMY_PROGRAM);
  const configAddr = base58Encode(findProgramAddress(
    [Buffer.from("neonrelay_economy_config")], program).address);
  const state: StubState = {
    accounts: new Map([[configAddr, { owner: ECONOMY_PROGRAM, data: config }]]),
    balances: new Map([[base58Encode(vault), "1000"], [base58Encode(treasury), "120"]]),
    alerts: [],
  };
  const stub = await startStub(state);
  const { app, base } = await startTestApp({
    operatorToken: OPERATOR, economyProgramId: ECONOMY_PROGRAM, rpcUrl: stub.url,
  });
  try {
    for (const balance of ["1000", "1200", "1500"]) {
      state.balances.set(base58Encode(vault), balance);
      const snap = await postJson(base, "/v1/admin/treasury/snapshot", {}, OPERATOR);
      assert.equal(snap.status, 200);
    }
    // Second page, one row: the middle snapshot with its delta vs the oldest.
    const page = await getJson(base, "/v1/admin/treasury?limit=1&offset=1", OPERATOR);
    assert.equal(page.json.snapshots.length, 1);
    assert.equal(page.json.snapshots[0].vault_balance, "1200");
    assert.equal(page.json.snapshots[0].vault_delta, "200");
    assert.equal(page.json.pagination.total, 3);
  } finally {
    await app.close();
    await stub.close();
  }
});
