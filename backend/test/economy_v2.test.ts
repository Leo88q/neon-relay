import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, cpSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db, migrate, MIGRATIONS_DIR } from "../src/db.ts";
import { EconomyV2Store, type EntryIntentV2 } from "../src/economy_v2_store.ts";
import { economyLeafV2, verifyEconomyProofV2, configPdaV2, ticketPdaV2, prizesPdaV2, claimPdaV2, U64_MAX } from "../src/economy_v2_codec.ts";
import { buildTree, leafHash, proofFor } from "../src/merkle.ts";

const mintA = Buffer.alloc(32, 9), mintB = Buffer.alloc(32, 10), wallet = Buffer.alloc(32, 7);
function intent(overrides: Partial<EntryIntentV2> = {}): EntryIntentV2 {
  return { mint: mintA, epoch: 1n, playerId: "player-1", wallet, idempotencyKey: "entry-1", kind: 0, tier: "micro-sprint", amountBase: 50n, ...overrides };
}
function store(cap = 2) {
  const db = new Db(":memory:"); migrate(db);
  const service = new EconomyV2Store(db, cap);
  service.openEpoch(mintA, 1n, 1000n); service.openEpoch(mintB, 1n, 1000n);
  return { db, service };
}

test("v2 migration is repeatable and leaves legacy single-mint rows untouched", () => {
  const db = new Db(":memory:");
  const oldDir = mkdtempSync(join(tmpdir(), "neon-v1-migrations-"));
  try {
    for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name < "0005")) cpSync(join(MIGRATIONS_DIR, file), join(oldDir, file));
    migrate(db, oldDir);
    db.run("INSERT INTO economy_epochs VALUES (?, ?, ?, ?, ?)", 1, "old-root", 50, "[]", 1);
    db.run("INSERT INTO economy_matches(wallet_binding_id, epoch, reference, created_at) VALUES (?, ?, ?, ?)", "legacy", 1, "old-reference", 1);
    assert.deepEqual(migrate(db), ["0005_economy_v2.sql", "0006_game_identity.sql"]);
    assert.deepEqual(migrate(db), []);
    assert.equal(db.get<{ reference: string }>("SELECT reference FROM economy_matches")!.reference, "old-reference");
    assert.equal(db.get<{ root: string }>("SELECT root FROM economy_epochs WHERE epoch = 1")!.root, "old-root");
    assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM economy_v2_epochs")!.n, 0);
  } finally { db.close(); rmSync(oldDir, { recursive: true, force: true }); }
});

test("v2 leaf golden vectors bind mint and preserve exact u64 values", () => {
  const vectors = JSON.parse(readFileSync(new URL("../../onchain/test/fixtures/economy_v2.json", import.meta.url), "utf8"));
  for (const v of vectors) assert.equal(economyLeafV2(Buffer.from(v.wallet, "hex"), BigInt(v.amountBase), Buffer.from(v.mint, "hex")), v.leaf);
  assert.notEqual(economyLeafV2(wallet, 50n, mintA), economyLeafV2(wallet, 50n, mintB));
  assert.notEqual(economyLeafV2(wallet, 50n, mintA), leafHash(wallet, 50));
  for (const value of [-1n, U64_MAX + 1n, 1 as unknown as bigint]) assert.throws(() => economyLeafV2(wallet, value, mintA));
  assert.throws(() => economyLeafV2(Buffer.alloc(31), 1n, mintA));
  assert.throws(() => economyLeafV2(wallet, 1n, Buffer.alloc(33)));
});

test("all v2 PDA identities are mint-qualified and deterministic", () => {
  const program = Buffer.alloc(32, 3), ref = Buffer.alloc(32, 4);
  const derive = (mint: Buffer) => [configPdaV2(mint, program), ticketPdaV2(mint, ref, wallet, program),
    prizesPdaV2(mint, 1n, program), claimPdaV2(mint, 1n, wallet, program)];
  const a = derive(mintA), b = derive(mintB);
  assert.deepEqual(a, derive(mintA));
  assert.equal(new Set([...a, ...b].map((p) => p.address.toString("hex"))).size, 8);
  assert.notDeepEqual(prizesPdaV2(mintA, 1n, program), prizesPdaV2(mintA, 2n, program));
  assert.throws(() => prizesPdaV2(mintA, -1n, program));
});

test("proof verifier rejects cross-mint, malformed hashes, index aliases and depth overflow", () => {
  const leaves = [economyLeafV2(wallet, 50n, mintA), economyLeafV2(Buffer.alloc(32, 8), 70n, mintA)];
  const tree = buildTree(leaves), proof = proofFor(tree, 0);
  assert.equal(verifyEconomyProofV2(leaves[0]!, 0, proof, tree.root), true);
  assert.equal(verifyEconomyProofV2(economyLeafV2(wallet, 50n, mintB), 0, proof, tree.root), false);
  for (const index of [-1, 0.5, NaN, 2, 0x100000000]) assert.equal(verifyEconomyProofV2(leaves[0]!, index, proof, tree.root), false);
  assert.equal(verifyEconomyProofV2(leaves[0]!, 0, Array(33).fill(leaves[1]), tree.root), false);
  assert.equal(verifyEconomyProofV2(leaves[0]!, 0, ["bad"], tree.root), false);
  assert.equal(verifyEconomyProofV2(leaves[0]!, 0, [], leaves[0]!), true);
  assert.equal(verifyEconomyProofV2(leaves[0]!, 1, [], leaves[0]!), false);
});

test("same epoch and idempotency key are independent across mints", () => {
  const { db, service } = store();
  try {
    const a = service.createIntent(intent());
    const b = service.createIntent(intent({ mint: mintB }));
    assert.notEqual(a.reference, b.reference);
    assert.equal(a.replay, false);
    assert.deepEqual(service.createIntent(intent()), { reference: a.reference, replay: true });
    for (const change of [{ wallet: Buffer.alloc(32, 8) }, { amountBase: 51n }, { epoch: 2n }, { tier: "grand-prix" }, { kind: 1 as const }]) {
      assert.throws(() => service.createIntent(intent(change)), /idempotency conflict/);
    }
    assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM economy_v2_intents")!.n, 2);
  } finally { db.close(); }
});

test("cap is per player/mint/epoch, not per wallet; retries do not spend cap", () => {
  const { db, service } = store(1);
  try {
    service.createIntent(intent());
    service.createIntent(intent());
    assert.throws(() => service.createIntent(intent({ wallet: Buffer.alloc(32, 8), idempotencyKey: "entry-2" })), /cap/);
    service.createIntent(intent({ mint: mintB }));
    service.createIntent(intent({ playerId: "player-2" }));
    service.openEpoch(mintA, 2n, 1000n);
    service.createIntent(intent({ epoch: 2n, idempotencyKey: "entry-2" }));
  } finally { db.close(); }
});

test("sealing is one-way, conserves budget and proofs cannot cross mints", () => {
  const { db, service } = store();
  try {
    service.createIntent(intent());
    const payouts = [{ wallet, amount: 100n }, { wallet: Buffer.alloc(32, 8), amount: 50n }];
    const a = service.sealEpoch(mintA, 1n, payouts);
    const b = service.sealEpoch(mintB, 1n, payouts.reverse());
    assert.notEqual(a.root, b.root);
    assert.equal(a.totalBase, "150");
    assert.throws(() => service.sealEpoch(mintA, 1n, payouts), /not open/);
    assert.throws(() => service.createIntent(intent({ idempotencyKey: "entry-2" })), /not open/);
    assert.equal(service.createIntent(intent()).replay, true);
    const p = service.proof(mintA, 1n, wallet)!;
    assert.equal(p.published, false);
    assert.equal(verifyEconomyProofV2(economyLeafV2(wallet, BigInt(p.amountBase), mintA), p.index, p.proof, p.root), true);
    assert.equal(verifyEconomyProofV2(economyLeafV2(wallet, BigInt(p.amountBase), mintB), p.index, p.proof, p.root), false);
    assert.equal(service.proof(mintA, 1n, Buffer.alloc(32, 99)), null);
    assert.equal(service.proof(mintA, 2n, wallet), null);
  } finally { db.close(); }
});

test("failed seals roll back and do not freeze an open epoch", () => {
  const { db, service } = store();
  try {
    for (const payouts of [[], [{ wallet, amount: 1001n }], [{ wallet, amount: 0n }],
      [{ wallet, amount: 50n }, { wallet, amount: 51n }],
      [{ wallet, amount: U64_MAX }, { wallet: Buffer.alloc(32, 8), amount: 1n }]]) {
      assert.throws(() => service.sealEpoch(mintA, 1n, payouts));
    }
    service.createIntent(intent());
    service.sealEpoch(mintA, 1n, [{ wallet, amount: 100n }]);
  } finally { db.close(); }
});

test("database prevents reopen, reseal, deletes and intent mutation", () => {
  const { db, service } = store();
  try {
    service.createIntent(intent());
    service.sealEpoch(mintA, 1n, [{ wallet, amount: 100n }]);
    for (const sql of ["UPDATE economy_v2_epochs SET state = 'OPEN'", "UPDATE economy_v2_epochs SET root = 'changed'",
      "DELETE FROM economy_v2_epochs", "UPDATE economy_v2_intents SET player_id = 'other'", "DELETE FROM economy_v2_intents"]) {
      assert.throws(() => db.exec(sql));
    }
  } finally { db.close(); }
});

test("unsigned u64 storage is exact and invalid numeric text is refused", () => {
  const { db, service } = store();
  try {
    service.openEpoch(mintA, U64_MAX, U64_MAX);
    service.sealEpoch(mintA, U64_MAX, [{ wallet, amount: U64_MAX }]);
    assert.equal(service.proof(mintA, U64_MAX, wallet)!.amountBase, U64_MAX.toString());
    for (const epoch of ["-1", "01", "1.5", "", "1e2", (U64_MAX + 1n).toString()]) {
      assert.throws(() => db.run("INSERT INTO economy_v2_epochs(mint, epoch, pool_base) VALUES (?, ?, ?)", mintA.toString("hex"), epoch, "1"));
    }
  } finally { db.close(); }
});


test("SQL REPLACE cannot bypass immutable epochs or intent uniqueness", () => {
  const { db, service } = store();
  try {
    service.createIntent(intent());
    assert.throws(() => db.exec("INSERT OR REPLACE INTO economy_v2_intents SELECT * FROM economy_v2_intents"));
    service.sealEpoch(mintA, 1n, [{ wallet, amount: 100n }]);
    assert.throws(() => db.run("INSERT OR REPLACE INTO economy_v2_epochs(mint, epoch, pool_base) VALUES (?, ?, ?)", mintA.toString("hex"), "1", "1"));
    assert.equal(service.proof(mintA, 1n, wallet)!.amountBase, "100");
  } finally { db.close(); }
});

test("independent database connections share cap and idempotency state", () => {
  const dir = mkdtempSync(join(tmpdir(), "neon-v2-store-"));
  const first = new Db(join(dir, "ledger.sqlite")); migrate(first);
  const second = new Db(join(dir, "ledger.sqlite")); migrate(second);
  try {
    const a = new EconomyV2Store(first, 1), b = new EconomyV2Store(second, 1);
    a.openEpoch(mintA, 1n, 1000n);
    const result = a.createIntent(intent());
    assert.deepEqual(b.createIntent(intent()), { reference: result.reference, replay: true });
    assert.throws(() => b.createIntent(intent({ idempotencyKey: "second" })), /cap/);
    b.sealEpoch(mintA, 1n, [{ wallet, amount: 100n }]);
    assert.equal(a.proof(mintA, 1n, wallet)!.amountBase, "100");
  } finally { first.close(); second.close(); rmSync(dir, { recursive: true, force: true }); }
});
