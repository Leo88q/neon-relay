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
  TICKET_DISCRIMINATOR, base58Decode, base58Encode, closeEpochPrizes, entryReference, findProgramAddress,
  isOnCurveEncoded, parseTicketData, proofForWallet, ticketAddress, ticketStatus,
  redistributePool, readVaultPool, parseEconomyV1Config, VaultReadError,
  ECONOMY_CONFIG_SEED, ECONOMY_V1_CONFIG_DISCRIMINATOR, type RpcCaller,
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
  TICKET_DISCRIMINATOR.copy(data);
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
  TICKET_DISCRIMINATOR.copy(account);
  w.copy(account, 8);
  ref.copy(account, 40);
  account[89] = findProgramAddress([Buffer.from("neonrelay_entry"), ref, w], base58Decode(ECONOMY_PROGRAM_ID)).bump;
  account.writeUInt8(0, 8 + 64);
  account.writeBigUInt64LE(5000000n, 8 + 65);
  account.writeBigInt64LE(1700000123n, 8 + 73);
  const calls: string[] = [];
  const rpc = async (method: string, params: unknown[]) => {
    calls.push(`${method}:${(params[0] as string) === addr ? "own" : "other"}`);
    return method === "getAccountInfo" ? { value: { owner: ECONOMY_PROGRAM_ID, executable: false, data: [account.toString("base64"), "base64"] } } : {};
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

// ------------------------------------------------- Tranche A: redistribution

test("redistribution: a lone winner takes the whole pool", () => {
  assert.deepEqual(redistributePool(1_000_000, 1), [1_000_000]);
});

test("redistribution: three winners rescale their occupied shares to 100%", () => {
  // occupied bps [2500, 1800, 1400] sum 5700; pool 57000 divides exactly
  assert.deepEqual(redistributePool(57_000, 3), [25_000, 18_000, 14_000]);
});

test("redistribution: dust goes +1 to the largest remainders, rank breaks ties", () => {
  // pool 1e6 over [2500, 1800]: floors [581395, 418604], leftover 1,
  // remainders [1500, 2800] -> the +1 goes to place 2
  assert.deepEqual(redistributePool(1_000_000, 2), [581395, 418605]);
  const amounts = redistributePool(1_000_000, 7);
  assert.equal(amounts.length, 7);
  assert.equal(amounts.reduce((a, b) => a + b, 0), 1_000_000);
  // shares stay rank-ordered after the dust pass
  assert.ok(amounts.every((a, i) => i === 0 || (amounts[i - 1] as number) >= a));
});

test("redistribution: a full table is byte-identical to the legacy split", () => {
  const pool = 12_345_678;
  const expected = PRIZE_TABLE_BPS.map((bps) => Number((BigInt(pool) * BigInt(bps)) / 10_000n));
  // legacy code truncated; redistribution additionally spreads the dust so the
  // total always equals the pool
  const amounts = redistributePool(pool, 10);
  assert.equal(amounts.reduce((a, b) => a + b, 0), pool);
  assert.ok(amounts.every((a, i) => Math.abs(a - (expected[i] as number)) <= 1));
});

test("redistribution: dust-pool tails round to zero and are dropped from leaves", async () => {
  // pool 5 over 10 winners: top five take 1 each, the tail gets nothing
  assert.deepEqual(redistributePool(5, 10), [1, 1, 1, 1, 1, 0, 0, 0, 0, 0]);
  const wallets = Array.from({ length: 10 }, (_, i) => {
    const raw = createHash("sha256").update(`dust-${i}`).digest();
    return { wallet: base58Encode(raw), totalMicro: (10 - i) * 100 };
  });
  const result = await closeEpochPrizes({
    rankedTotals: wallets,
    hasTicket: async () => true,
    poolMicro: 5,
    epoch: 3,
  });
  assert.equal(result.leaves.length, 5);
  assert.equal(result.totalMicro, 5);
  assert.deepEqual(result.leaves.map((l) => l.place), [1, 2, 3, 4, 5]);
});

test("epoch close rescales around an unpaid leader instead of stranding shares", async () => {
  const wallets = Array.from({ length: 4 }, (_, i) => {
    const raw = createHash("sha256").update(`rs-${i}`).digest();
    return { raw, wallet: base58Encode(raw), total: (4 - i) * 1000 };
  });
  const paid = new Set(wallets.slice(1).map((w) => w.wallet)); // rank 1 unpaid
  const result = await closeEpochPrizes({
    rankedTotals: wallets.map((w) => ({ wallet: w.wallet, totalMicro: w.total })),
    hasTicket: async (raw) => paid.has(base58Encode(raw)),
    poolMicro: 57_000,
    epoch: 9,
  });
  assert.equal(result.leaves.length, 3);
  assert.deepEqual(result.leaves.map((l) => l.amountMicro), [25_000, 18_000, 14_000]);
  assert.equal(result.totalMicro, 57_000);
  for (const leaf of result.leaves) {
    const proof = proofForWallet(result, leaf.wallet);
    assert.ok(proof);
    const index = result.leaves.findIndex((l) => l.wallet === leaf.wallet);
    assert.equal(
      verifyProofIndexed(leafHash(leaf.publicKeyRaw, leaf.amountMicro), index, proof as string[], result.root),
      true);
  }
});

test("epoch close with no ticketed winners yields no leaves (pool stays vaulted)", async () => {
  const wallets = Array.from({ length: 3 }, (_, i) => {
    const raw = createHash("sha256").update(`none-${i}`).digest();
    return { wallet: base58Encode(raw), totalMicro: 100 };
  });
  const result = await closeEpochPrizes({
    rankedTotals: wallets,
    hasTicket: async () => false,
    poolMicro: 1_000_000,
    epoch: 11,
  });
  assert.equal(result.leaves.length, 0);
  assert.equal(result.totalMicro, 0);
  assert.equal(result.root, "0".repeat(64));
});

// ------------------------------------------------- Tranche A: vault-derived pool

function v1ConfigBytes(opts: { mint: Buffer; vault: Buffer; treasury: Buffer; reserved: bigint }): Buffer {
  const data = Buffer.alloc(204);
  ECONOMY_V1_CONFIG_DISCRIMINATOR.copy(data, 0);
  Buffer.alloc(32, 5).copy(data, 8); // authority
  opts.mint.copy(data, 40);
  opts.treasury.copy(data, 72);
  opts.vault.copy(data, 104);
  data.writeUInt16LE(1000, 136);
  data.writeBigUInt64LE(1_000_000n, 138);
  data.writeBigUInt64LE(5_000_000n, 146);
  data[154] = 0;
  data[155] = 255; // bump is not validated by the parser
  data.writeBigUInt64LE(opts.reserved, 156);
  return data;
}

function vaultRpcStub(opts: {
  program: string; config: Buffer; vault: string; balance: string;
}): RpcCaller {
  return async (method, params) => {
    if (method === "getAccountInfo") {
      return {
        value: {
          owner: opts.program, executable: false,
          data: [opts.config.toString("base64"), "base64"],
        },
      };
    }
    if (method === "getTokenAccountBalance") {
      assert.equal(params[0], opts.vault);
      return { value: { amount: opts.balance, decimals: 6, uiAmount: 1 } };
    }
    throw new Error(`unexpected rpc ${method}`);
  };
}

test("vault pool reads available = balance - reserved from finalized state", async () => {
  const program = base58Decode(ECONOMY_PROGRAM_ID);
  const mint = createHash("sha256").update("skr-mint").digest();
  const vault = createHash("sha256").update("vault").digest();
  const treasury = createHash("sha256").update("treasury").digest();
  const configAddr = base58Encode(findProgramAddress([ECONOMY_CONFIG_SEED], program).address);
  const pool = await readVaultPool(
    vaultRpcStub({
      program: ECONOMY_PROGRAM_ID,
      config: v1ConfigBytes({ mint, vault, treasury, reserved: 100_000n }),
      vault: base58Encode(vault),
      balance: "1100000",
    }),
    ECONOMY_PROGRAM_ID, base58Encode(mint));
  assert.equal(pool.config, configAddr);
  assert.equal(pool.vault, base58Encode(vault));
  assert.equal(pool.balance, "1100000");
  assert.equal(pool.reserved, "100000");
  assert.equal(pool.available, 1_000_000);
});

test("vault pool rejects mint mismatch, underfunding and empty pools", async () => {
  const mint = createHash("sha256").update("skr-mint").digest();
  const other = createHash("sha256").update("other-mint").digest();
  const vault = createHash("sha256").update("vault").digest();
  const treasury = createHash("sha256").update("treasury").digest();
  const stub = (reserved: bigint, balance: string) => vaultRpcStub({
    program: ECONOMY_PROGRAM_ID,
    config: v1ConfigBytes({ mint, vault, treasury, reserved }),
    vault: base58Encode(vault),
    balance,
  });
  await assert.rejects(readVaultPool(stub(0n, "100"), ECONOMY_PROGRAM_ID, base58Encode(other)),
    (err: Error) => err instanceof VaultReadError && err.code === "mint-mismatch");
  await assert.rejects(readVaultPool(stub(200n, "100"), ECONOMY_PROGRAM_ID, base58Encode(mint)),
    (err: Error) => err instanceof VaultReadError && err.code === "vault-underfunded");
  await assert.rejects(readVaultPool(stub(100n, "100"), ECONOMY_PROGRAM_ID, base58Encode(mint)),
    (err: Error) => err instanceof VaultReadError && err.code === "empty-pool");
});

test("vault pool fails closed on bad accounts and dead RPC", async () => {
  const mint = createHash("sha256").update("skr-mint").digest();
  const vault = createHash("sha256").update("vault").digest();
  const treasury = createHash("sha256").update("treasury").digest();
  const good = v1ConfigBytes({ mint, vault, treasury, reserved: 0n });
  const withConfig = (config: Buffer, owner = ECONOMY_PROGRAM_ID): RpcCaller =>
    async (method) => {
      if (method === "getAccountInfo") {
        return { value: { owner, executable: false, data: [config.toString("base64"), "base64"] } };
      }
      return { value: { amount: "100", decimals: 6 } };
    };
  const truncated = good.subarray(0, 100);
  await assert.rejects(readVaultPool(withConfig(truncated), ECONOMY_PROGRAM_ID, null),
    (err: Error) => err instanceof VaultReadError && err.code === "bad-config-account");
  const badDisc = Buffer.from(good);
  badDisc[0] ^= 0xff;
  await assert.rejects(readVaultPool(withConfig(badDisc), ECONOMY_PROGRAM_ID, null),
    (err: Error) => err instanceof VaultReadError && err.code === "bad-config-account");
  await assert.rejects(readVaultPool(withConfig(good, "11111111111111111111111111111111"), ECONOMY_PROGRAM_ID, null),
    (err: Error) => err instanceof VaultReadError && err.code === "bad-config-account");
  const dead: RpcCaller = async () => { throw new Error("connection refused"); };
  await assert.rejects(readVaultPool(dead, ECONOMY_PROGRAM_ID, null),
    (err: Error) => err instanceof VaultReadError && err.code === "rpc-unavailable");
  assert.throws(() => parseEconomyV1Config(Buffer.alloc(204)),
    (err: Error) => err instanceof VaultReadError && err.code === "bad-config-account");
});

test("redistributePool validates the pool and the paid places", () => {
  assert.throws(() => redistributePool(0, 5), /poolMicro must be positive/);
  assert.throws(() => redistributePool(1_000_000, 0), /places must be within 1\.\.10/);
  assert.throws(() => redistributePool(1_000_000, 11), /places must be within 1\.\.10/);
});

test("closeEpochPrizes rejects a non-positive pool before ranking", async () => {
  await assert.rejects(
    closeEpochPrizes({ rankedTotals: [], hasTicket: async () => true, poolMicro: -5, epoch: 1 }),
    /poolMicro must be positive/);
});

test("vault pool rejects a non-canonical config encoding", async () => {
  const mint = createHash("sha256").update("skr-mint").digest();
  const vault = createHash("sha256").update("vault").digest();
  const treasury = createHash("sha256").update("treasury").digest();
  const encoded = v1ConfigBytes({ mint, vault, treasury, reserved: 0n }).toString("base64");
  const tampered = encoded.slice(0, 100) + "\n" + encoded.slice(101);
  assert.equal(tampered.length, 272);
  const stub: RpcCaller = async (method) => {
    if (method === "getAccountInfo") {
      return {
        value: { owner: ECONOMY_PROGRAM_ID, executable: false, data: [tampered, "base64"] },
      };
    }
    return { value: { amount: "100", decimals: 6 } };
  };
  await assert.rejects(readVaultPool(stub, ECONOMY_PROGRAM_ID, null),
    (err: Error) => err instanceof VaultReadError && err.code === "bad-config-account");
});

test("vault pool maps a balance-read failure to rpc-unavailable", async () => {
  const mint = createHash("sha256").update("skr-mint").digest();
  const vault = createHash("sha256").update("vault").digest();
  const treasury = createHash("sha256").update("treasury").digest();
  const good = v1ConfigBytes({ mint, vault, treasury, reserved: 0n });
  const stub: RpcCaller = async (method) => {
    if (method === "getAccountInfo") {
      return {
        value: {
          owner: ECONOMY_PROGRAM_ID, executable: false, data: [good.toString("base64"), "base64"],
        },
      };
    }
    throw new Error("balance node down");
  };
  await assert.rejects(readVaultPool(stub, ECONOMY_PROGRAM_ID, null),
    (err: Error) => err instanceof VaultReadError && err.code === "rpc-unavailable");
});

test("vault pool rejects a non-canonical balance", async () => {
  const mint = createHash("sha256").update("skr-mint").digest();
  const vault = createHash("sha256").update("vault").digest();
  const treasury = createHash("sha256").update("treasury").digest();
  const stub = vaultRpcStub({
    program: ECONOMY_PROGRAM_ID,
    config: v1ConfigBytes({ mint, vault, treasury, reserved: 0n }),
    vault: base58Encode(vault),
    balance: "12ab",
  });
  await assert.rejects(readVaultPool(stub, ECONOMY_PROGRAM_ID, null),
    (err: Error) => err instanceof VaultReadError && err.code === "bad-vault-balance");
});

test("vault pool refuses balances above the safe integer range", async () => {
  const mint = createHash("sha256").update("skr-mint").digest();
  const vault = createHash("sha256").update("vault").digest();
  const treasury = createHash("sha256").update("treasury").digest();
  const stub = vaultRpcStub({
    program: ECONOMY_PROGRAM_ID,
    config: v1ConfigBytes({ mint, vault, treasury, reserved: 0n }),
    vault: base58Encode(vault),
    balance: "9007199254740993", // 2^53 + 1: canonical u64, unsafe for float math
  });
  await assert.rejects(readVaultPool(stub, ECONOMY_PROGRAM_ID, null),
    (err: Error) => err instanceof VaultReadError && err.code === "pool-too-large");
});
