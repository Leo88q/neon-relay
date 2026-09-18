/** Internal v2 ledger, not a payment/ownership verifier or public API.
 * Callers must authenticate player_id, verify mint/fees and paid results before
 * using this store. No method here marks an intent as paid or publishes a root. */
import { createHash } from "node:crypto";
import type { Db } from "./db.ts";
import { buildTree, proofFor } from "./merkle.ts";
import { economyLeafV2, keyHex, u64 } from "./economy_v2_codec.ts";

interface EpochRow {
  mint: string; epoch: string; state: "OPEN" | "SEALED"; pool_base: string;
  root: string | null; total_base: string | null; distribution: string | null;
}
interface Distribution { wallet: string; amount: string }
export interface EntryIntentV2 {
  mint: Buffer; epoch: bigint; playerId: string; wallet: Buffer;
  idempotencyKey: string; kind: 0 | 1; tier: string; amountBase: bigint;
}
function text(value: string, max: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("invalid identifier");
  }
  return value;
}
function mintHex(mint: Buffer): string {
  const hex = keyHex(mint);
  if (hex === "0".repeat(64)) throw new Error("zero mint");
  return hex;
}

export class EconomyV2Store {
  private readonly db: Db;
  private readonly maxIntentsPerPlayerEpoch: number;
  constructor(db: Db, maxIntentsPerPlayerEpoch = 1000) {
    if (!Number.isSafeInteger(maxIntentsPerPlayerEpoch) || maxIntentsPerPlayerEpoch < 1) throw new Error("invalid cap");
    this.db = db;
    this.maxIntentsPerPlayerEpoch = maxIntentsPerPlayerEpoch;
  }

  private transaction<T>(work: () => T): T {
    // Synchronous callback + IMMEDIATE serializes both cap and idempotency checks.
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = work(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  openEpoch(mint: Buffer, epoch: bigint, poolBase: bigint): void {
    this.db.run("INSERT INTO economy_v2_epochs(mint, epoch, pool_base) VALUES (?, ?, ?)",
      mintHex(mint), u64(epoch).toString(), u64(poolBase).toString());
  }

  /** UNIQUE(mint, player_id, idempotency_key); same key + different payload fails.
   * Exact retries return the original immutable reference, even after sealing.
   * A retry response is not evidence of payment or permission to join a race. */
  createIntent(input: EntryIntentV2): { reference: string; replay: boolean } {
    const mint = mintHex(input.mint), wallet = keyHex(input.wallet);
    const epoch = u64(input.epoch).toString(), amount = u64(input.amountBase).toString();
    const player = text(input.playerId, 128), id = text(input.idempotencyKey, 128), tier = text(input.tier, 64);
    if (input.kind !== 0 && input.kind !== 1) throw new Error("invalid entry kind");
    // Domain-prefixed JSON array has unambiguous lengths and a fixed field order.
    const reference = createHash("sha256").update("neonrelay:economy:v2:intent\0")
      .update(JSON.stringify([mint, epoch, player, wallet, id, input.kind, tier, amount])).digest("hex");
    return this.transaction(() => {
      const old = this.db.get<{ reference: string }>(
        "SELECT reference FROM economy_v2_intents WHERE mint = ? AND player_id = ? AND idempotency_key = ?", mint, player, id);
      if (old) {
        if (old.reference !== reference) throw new Error("idempotency conflict");
        return { reference, replay: true };
      }
      const row = this.db.get<EpochRow>("SELECT * FROM economy_v2_epochs WHERE mint = ? AND epoch = ?", mint, epoch);
      if (!row || row.state !== "OPEN") throw new Error("epoch not open");
      const count = this.db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM economy_v2_intents WHERE mint = ? AND epoch = ? AND player_id = ?", mint, epoch, player)!.n;
      if (count >= this.maxIntentsPerPlayerEpoch) throw new Error("player intent cap exceeded");
      this.db.run(`INSERT INTO economy_v2_intents
        (mint, epoch, player_id, idempotency_key, wallet, kind, tier, amount_base, reference)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, mint, epoch, player, id, wallet, input.kind, tier, amount, reference);
      return { reference, replay: false };
    });
  }

  /** Read immutable metadata for an authenticated player; no paid flag exists. */
  getIntent(mint: Buffer, playerId: string, idempotencyKey: string) {
    return this.db.get<{ mint: string; epoch: string; wallet: string; kind: 0 | 1;
      tier: string; amount_base: string; reference: string }>(
      `SELECT mint, epoch, wallet, kind, tier, amount_base, reference FROM economy_v2_intents
       WHERE mint = ? AND player_id = ? AND idempotency_key = ?`,
      mintHex(mint), text(playerId, 128), text(idempotencyKey, 128)) ?? null;
  }

  /** One-way backend seal. Caller supplies already-authorized payouts, not scores.
   * Pool is a budget in this database, NOT an RPC-verified vault balance. */
  sealEpoch(mint: Buffer, epoch: bigint, payouts: { wallet: Buffer; amount: bigint }[]) {
    const m = mintHex(mint), e = u64(epoch).toString();
    if (payouts.length < 1 || payouts.length > 10) throw new Error("expected 1..10 payouts");
    const distribution = payouts.map((p) => {
      if (u64(p.amount) === 0n) throw new Error("zero payout");
      return { wallet: keyHex(p.wallet), amount: p.amount.toString() };
    }).sort((a, b) => a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0);
    if (new Set(distribution.map((p) => p.wallet)).size !== distribution.length) throw new Error("duplicate wallet");
    const total = u64(distribution.reduce((sum, p) => sum + BigInt(p.amount), 0n));
    const tree = buildTree(distribution.map((p) => economyLeafV2(Buffer.from(p.wallet, "hex"), BigInt(p.amount), mint)));
    return this.transaction(() => {
      const row = this.db.get<EpochRow>("SELECT * FROM economy_v2_epochs WHERE mint = ? AND epoch = ?", m, e);
      if (!row || row.state !== "OPEN") throw new Error("epoch not open");
      if (total > BigInt(row.pool_base)) throw new Error("prizes exceed epoch budget");
      this.db.run(`UPDATE economy_v2_epochs SET state = 'SEALED', root = ?, total_base = ?, distribution = ?
        WHERE mint = ? AND epoch = ? AND state = 'OPEN'`, tree.root, total.toString(), JSON.stringify(distribution), m, e);
      return { mint: m, epoch: e, root: tree.root, totalBase: total.toString() };
    });
  }

  proof(mint: Buffer, epoch: bigint, wallet: Buffer) {
    const m = mintHex(mint), e = u64(epoch).toString(), w = keyHex(wallet);
    const row = this.db.get<EpochRow>("SELECT * FROM economy_v2_epochs WHERE mint = ? AND epoch = ?", m, e);
    if (!row || row.state !== "SEALED") return null;
    const distribution = JSON.parse(row.distribution!) as Distribution[];
    const index = distribution.findIndex((p) => p.wallet === w);
    if (index < 0) return null;
    const tree = buildTree(distribution.map((p) => economyLeafV2(Buffer.from(p.wallet, "hex"), BigInt(p.amount), mint)));
    if (tree.root !== row.root) throw new Error("stored distribution/root mismatch");
    return { version: 2, mint: m, epoch: e, wallet: w, amountBase: distribution[index]!.amount,
      index, root: tree.root, proof: proofFor(tree, index), published: false };
  }
}
