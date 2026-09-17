/**
 * Stage-15 economy tests: base58/curve/PDA primitives, ticket parsing over a
 * mock RPC, top-10 epoch close with unpaid-leader exclusion, and cross-package
 * parity of the prize table with onchain/src/constants.ts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  base58Decode, base58Encode, closeEpochPrizes, entryReference, findProgramAddress,
  isOnCurveEncoded, parseTicketData, proofForWallet, ticketAddress, ticketStatus,
} from "../src/economy.ts";
import { buildTree, leafHash, verifyProofIndexed } from "../src/merkle.ts";
import { PRIZE_TABLE_BPS } from "../src/prize_table.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ECONOMY_PROGRAM_ID = "FZcLDdUrs6i1HYFFK2NhqNrbVaP6KTvrqzhyoDGT6CV9";

test("base58 round-trips and encodes leading zeros as ones", () => {
  const raw = Buffer.alloc(32, 0xab);
  assert.equal(base58Decode(base58Encode(raw)).toString("hex"), raw.toString("hex"));
  assert.equal(base58Encode(Buffer.alloc(32)), "1".repeat(32));
  const pid = base58Decode(ECONOMY_PROGRAM_ID);
  assert.equal(pid.length, 32);
  assert.throws(() => base58Decode("0OIl")); // non-base58 chars
});

test("ed25519 curve test recognises the base point and rejects PDA candidates", () => {
  // compressed ed25519 base point (RFC 8032 generator)
  const basePoint = Buffer.from(
    "5866666666666666666666666666666666666666666666666666666666666666", "hex");
  assert.equal(isOnCurveEncoded(basePoint), true);
  const { address, bump } = findProgramAddress(
    [Buffer.from("neonrelay_entry"), Buffer.alloc(32, 7)], base58Decode(ECONOMY_PROGRAM_ID));
  assert.ok(bump >= 0 && bump <= 255);
  assert.equal(isOnCurveEncoded(address), false); // PDAs are off-curve by construction
  assert.equal(address.length, 32);
});

test("PDA derivation is deterministic and seed-sensitive", () => {
  const pid = base58Decode(ECONOMY_PROGRAM_ID);
  const a = findProgramAddress([Buffer.from("s1"), Buffer.alloc(32, 1)], pid);
  const b = findProgramAddress([Buffer.from("s1"), Buffer.alloc(32, 1)], pid);
  const c = findProgramAddress([Buffer.from("s2"), Buffer.alloc(32, 1)], pid);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a.address, c.address);
});

test("entry references are stable and injective across kind/epoch/extra/wallet", () => {
  const w = Buffer.alloc(32, 3);
  const r0 = entryReference(0, 5, w);
  assert.equal(r0.toString("hex"), entryReference(0, 5, w).toString("hex"));
  assert.notEqual(r0.toString("hex"), entryReference(1, 5, w).toString("hex"));
  assert.notEqual(r0.toString("hex"), entryReference(0, 6, w).toString("hex"));
  assert.notEqual(r0.toString("hex"), entryReference(0, 5, w, 9).toString("hex"));
  assert.notEqual(r0.toString("hex"), entryReference(0, 5, Buffer.alloc(32, 4)).toString("hex"));
  assert.equal(r0.length, 32);
});

test("ticket borsh parsing reads kind/amount/paidAt after the discriminator", () => {
  const data = Buffer.alloc(8 + 32 + 32 + 1 + 8 + 8 + 1);
  data.writeUInt8(1, 8 + 64); // kind = tournament
  data.writeBigUInt64LE(1234567n, 8 + 65);
  data.writeBigInt64LE(1700000000n, 8 + 73);
  const status = parseTicketData(data);
  assert.deepEqual(status, { ticketed: true, kind: 1, amountMicro: 1234567, paidAt: 1700000000 });
  assert.deepEqual(parseTicketData(Buffer.alloc(10)), { ticketed: false });
});

test("ticketStatus reads the on-chain ticket through the injected RPC", async () => {
  const w = Buffer.alloc(32, 7);
  const ref = entryReference(0, 1, w);
  const addr = base58Encode(ticketAddress(ref, w, base58Decode(ECONOMY_PROGRAM_ID)));
  const account = Buffer.alloc(8 + 32 + 32 + 1 + 8 + 8 + 1);
  account.writeUInt8(0, 8 + 64);
  account.writeBigUInt64LE(5000000n, 8 + 65);
  account.writeBigInt64LE(1700000123n, 8 + 73);
  const calls: string[] = [];
  const rpc = async (method: string, params: unknown[]) => {
    calls.push(`${method}:${(params[0] as string) === addr ? "own" : "other"}`);
    return method === "getAccountInfo" ? { value: { data: [account.toString("base64"), "base64"] } } : {};
  };
  const status = await ticketStatus(rpc, ECONOMY_PROGRAM_ID, ref, w);
  assert.deepEqual(status, { ticketed: true, kind: 0, amountMicro: 5000000, paidAt: 1700000123 });
  assert.deepEqual(calls, ["getAccountInfo:own"]);
  const empty = async () => ({ value: null });
  assert.deepEqual(await ticketStatus(empty, ECONOMY_PROGRAM_ID, ref, w), { ticketed: false });
});

test("epoch close pays the top-10 table and excludes an unpaid leader", async () => {
  const wallets = Array.from({ length: 12 }, (_, i) => {
    const raw = createHash("sha256").update(`w${i}`).digest();
    return { raw, wallet: base58Encode(raw), total: (12 - i) * 1000 };
  });
  const unpaid = wallets[0]; // rank 1 but no ticket -> excluded from prizes
  const paid = new Set(wallets.slice(1).map((w) => w.wallet));
  const result = await closeEpochPrizes({
    rankedTotals: wallets.map((w) => ({ wallet: w.wallet, totalMicro: w.total })),
    hasTicket: async (raw) => paid.has(base58Encode(raw)),
    poolMicro: 1_000_000,
    epoch: 7,
  });
  assert.equal(result.leaves.length, 10);
  assert.ok(result.leaves.every((l) => l.wallet !== unpaid.wallet));
  assert.equal(result.leaves[0]?.place, 1);
  const expected = PRIZE_TABLE_BPS.map((bps) => Number((1_000_000n * BigInt(bps)) / 10_000n));
  assert.deepEqual(result.leaves.map((l) => l.amountMicro), expected);
  assert.equal(result.totalMicro, expected.reduce((a, b) => a + b, 0));
  // proofs verify against the published root with the on-chain fold rule
  for (const leaf of result.leaves) {
    const proof = proofForWallet(result, leaf.wallet);
    assert.ok(proof);
    const index = result.leaves.findIndex((l) => l.wallet === leaf.wallet);
    assert.equal(
      verifyProofIndexed(leafHash(leaf.publicKeyRaw, leaf.amountMicro), index, proof as string[], result.root),
      true);
  }
  assert.equal(proofForWallet(result, unpaid.wallet), null);
  // sanity: tree root matches a direct rebuild
  assert.equal(buildTree(result.leaves.map((l) => leafHash(l.publicKeyRaw, l.amountMicro))).root, result.root);
});

test("backend prize table matches onchain PRIZE_TABLE_BPS exactly", () => {
  const src = readFileSync(join(here, "../../onchain/src/constants.ts"), "utf8");
  const m = src.match(/PRIZE_TABLE_BPS = \[([0-9, ]+)\]/);
  assert.ok(m);
  const onchain = (m?.[1] ?? "").split(",").map((x) => Number(x.trim())).filter((n) => !Number.isNaN(n));
  assert.deepEqual(onchain, [...PRIZE_TABLE_BPS]);
  assert.equal(PRIZE_TABLE_BPS.reduce((a, b) => a + b, 0), 10_000);
});

test("match-intent references follow the on-device reference scheme", () => {
  // Kotlin EconomyTxBuilder and the backend must derive identical references:
  // SHA256(kind u8 || epoch u64le || extra u64le || wallet32)
  const wallet = createHash("sha256").update("intent-wallet").digest();
  const b = Buffer.alloc(17);
  b.writeUInt8(0, 0);
  b.writeBigUInt64LE(3n, 1);
  b.writeBigUInt64LE(42n, 9);
  const manual = createHash("sha256").update(b).update(wallet).digest();
  assert.equal(entryReference(0, 3, wallet, 42).toString("hex"), manual.toString("hex"));
});
