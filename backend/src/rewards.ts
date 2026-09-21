/**
 * Server-authoritative reward ledger (stage 7).
 *
 * Ingestion (`ingestEvents`) accepts only events signed by a game server key
 * configured via NEONRELAY_SERVER_SIGNING_PUBLIC_KEY; every event is
 * deduplicated by an idempotency hash, checked against per-match/daily/weekly
 * caps, and assigned to the epoch open at ingestion time. Sealing an epoch
 * computes a Merkle root over per-binding sums; claim intents carry the proof
 * the on-chain program (stage 9) will verify.
 *
 * Statuses:
 *   event: accepted | duplicate | rejected_signature | rejected_caps |
 *          rejected_validation | rejected_epoch_sealed
 *   epoch: open | sealed
 *   intent: created | submitted | confirmed | failed | expired
 */
import type { Config } from "./config.ts";
import {
  CryptoError, publicKeyFromBase64Url, sha256Hex, verifySignature,
} from "./crypto.ts";
import type { Db } from "./db.ts";
import {
  buildTree, leafHash, proofFor, verifyProofIndexed, type MerkleTree,
} from "./merkle.ts";
import type { SessionRow } from "./sessions.ts";
import type { BindingRow, WalletStore } from "./wallets.ts";

export type EventStatus =
  | "accepted" | "duplicate" | "rejected_signature"
  | "rejected_caps" | "rejected_validation" | "rejected_epoch_sealed";

export interface IncomingEvent {
  match_id: string;
  player_id: string;
  wallet_binding_id?: string | null;
  event_type: string;
  amount_micro: number;
  occurred_at: number;
  server_signature: string;
}

export interface IngestResult {
  idempotency_hash: string;
  status: EventStatus;
  reason?: string;
  reward_epoch?: number;
}

export interface EpochRow {
  id: number;
  state: "open" | "sealed";
  started_at: number;
  ended_at: number;
  sealed_at: number | null;
  merkle_root: string | null;
  total_micro: number;
  leaf_count: number;
}

export interface LeafRow {
  epoch_id: number;
  wallet_binding_id: string;
  public_key: string;
  amount_micro: number;
  leaf_index: number;
  leaf_hash: string;
}

export interface IntentRow {
  id: string;
  wallet_binding_id: string;
  epoch_id: number;
  amount_micro: number;
  leaf_hash: string;
  merkle_proof: string;
  status: string;
  transaction_id: string | null;
  created_at: number;
  updated_at: number;
}

/** Canonical signed bytes of an event: fixed key order, no whitespace. */
export function canonicalEventBytes(event: {
  match_id: string; player_id: string; event_type: string;
  amount_micro: number; occurred_at: number;
}): Buffer {
  return Buffer.from(JSON.stringify({
    match_id: event.match_id,
    player_id: event.player_id,
    event_type: event.event_type,
    amount_micro: event.amount_micro,
    occurred_at: event.occurred_at,
  }), "utf8");
}

export function idempotencyHash(event: {
  match_id: string; player_id: string; event_type: string;
  amount_micro: number; occurred_at: number;
}): string {
  return sha256Hex(canonicalEventBytes(event));
}

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

/** UTC day/week window start for a timestamp. */
export function windowStart(now: number, spanMs: number): number {
  return Math.floor(now / spanMs) * spanMs;
}

export class RewardsError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class RewardService {
  private readonly db: Db;
  private readonly config: Config;
  private readonly wallets: WalletStore;

  constructor(db: Db, config: Config, wallets: WalletStore) {
    this.db = db;
    this.config = config;
    this.wallets = wallets;
  }

  // ---------------------------------------------------------------- epochs

  currentEpoch(now: number = Date.now()): EpochRow {
    const index = Math.floor(now / this.config.epochMs);
    const existing = this.db.get<EpochRow>("SELECT * FROM reward_epochs WHERE id = ?", index);
    if (existing) return existing;
    this.db.run(
      "INSERT INTO reward_epochs (id, state, started_at, ended_at) VALUES (?, 'open', ?, ?)",
      index, index * this.config.epochMs, (index + 1) * this.config.epochMs);
    return this.db.get<EpochRow>("SELECT * FROM reward_epochs WHERE id = ?", index) as EpochRow;
  }

  listEpochs(): EpochRow[] {
    return this.db.all<EpochRow>("SELECT * FROM reward_epochs ORDER BY id DESC");
  }

  // ---------------------------------------------------------------- ingest

  ingestEvents(events: IncomingEvent[], now: number = Date.now()): IngestResult[] {
    if (!this.config.serverSigningPublicKey) {
      throw new RewardsError(503, "signing-key-unconfigured",
        "NEONRELAY_SERVER_SIGNING_PUBLIC_KEY is not set; reward ingestion is disabled");
    }
    let serverKey;
    try {
      serverKey = publicKeyFromBase64Url(this.config.serverSigningPublicKey);
    } catch (err) {
      throw new RewardsError(500, "signing-key-invalid",
        `configured server signing key is invalid: ${(err as Error).message}`);
    }
    const epoch = this.currentEpoch(now);
    const results: IngestResult[] = [];
    for (const event of events) {
      results.push(this.ingestOne(event, serverKey, epoch, now));
    }
    return results;
  }

  private ingestOne(event: IncomingEvent, serverKey: ReturnType<typeof publicKeyFromBase64Url>,
    epoch: EpochRow, now: number): IngestResult {
    const hash = idempotencyHash(event);
    const prior = this.db.get<{ status: string; reward_epoch: number }>(
      "SELECT status, reward_epoch FROM reward_events WHERE idempotency_hash = ?", hash);
    if (prior && prior.status !== "rejected_signature" && prior.status !== "rejected_validation") {
      return { idempotency_hash: hash, status: "duplicate",
        reason: `already ingested as ${prior.status}`, reward_epoch: prior.reward_epoch };
    }
    if (prior && (prior.status === "rejected_signature" || prior.status === "rejected_validation")) {
      this.db.run("DELETE FROM reward_events WHERE idempotency_hash = ?", hash);
    }
    const problem = validateEvent(event);
    if (problem) {
      this.record(event, hash, epoch.id, "rejected_validation", problem, now);
      return { idempotency_hash: hash, status: "rejected_validation", reason: problem };
    }
    const message = canonicalEventBytes(event);
    const signature = Buffer.from(event.server_signature, "base64url");
    if (!verifySignature(message, signature, serverKey)) {
      this.record(event, hash, epoch.id, "rejected_signature",
        "server signature does not match the configured signing key", now);
      return { idempotency_hash: hash, status: "rejected_signature",
        reason: "bad server signature" };
    }
    if (epoch.state !== "open") {
      this.record(event, hash, epoch.id, "rejected_epoch_sealed", "epoch already sealed", now);
      return { idempotency_hash: hash, status: "rejected_epoch_sealed" };
    }
    // Authenticate wallet binding against player_id to prevent redirection attacks (CRIT-01)
    const authoritativeBinding = this.wallets.findActiveByPlayerId(event.player_id);
    let resolvedBindingId = authoritativeBinding?.id ?? null;
    if (event.wallet_binding_id) {
      const explicitBinding = this.wallets.findBinding(event.wallet_binding_id);
      if (!explicitBinding || explicitBinding.revoked_at !== null ||
          (explicitBinding.player_id !== null && explicitBinding.player_id !== event.player_id)) {
        this.record(event, hash, epoch.id, "rejected_validation",
          "wallet binding does not belong to player", now, null);
        return { idempotency_hash: hash, status: "rejected_validation",
          reason: "wallet binding does not belong to player" };
      }
      const activeBinding = this.wallets.findActiveByPlayerId(event.player_id);
      if (activeBinding && activeBinding.id !== event.wallet_binding_id) {
        this.record(event, hash, epoch.id, "rejected_validation",
          "wallet binding does not match player's active wallet", now, null);
        return { idempotency_hash: hash, status: "rejected_validation",
          reason: "wallet binding does not match player's active wallet" };
      }
      resolvedBindingId = event.wallet_binding_id;
    } else {
      const activeBinding = this.wallets.findActiveByPlayerId(event.player_id);
      if (activeBinding) {
        resolvedBindingId = activeBinding.id;
      }
    }
    const capProblem = this.capViolation({ ...event, wallet_binding_id: resolvedBindingId ?? undefined }, now);
    if (capProblem) {
      this.record(event, hash, epoch.id, "rejected_caps", capProblem, now, resolvedBindingId);
      return { idempotency_hash: hash, status: "rejected_caps", reason: capProblem };
    }
    this.record(event, hash, epoch.id, "accepted", null, now, resolvedBindingId);
    return { idempotency_hash: hash, status: "accepted", reward_epoch: epoch.id };
  }

  private record(event: IncomingEvent, hash: string, epochId: number, status: EventStatus,
    reason: string | null, now: number, effectiveBindingId?: string | null): void {
    // Fail-closed audit: validation-rejected events are still recorded, but a
    // malformed field must never crash the insert (NOT NULL columns, CHECKs).
    const text = (value: unknown): string => typeof value === "string" ? value : "";
    const int = (value: unknown): number =>
      typeof value === "number" && Number.isInteger(value) ? value : 0;
    const finalBinding = effectiveBindingId !== undefined
      ? effectiveBindingId
      : (typeof event.wallet_binding_id === "string" ? event.wallet_binding_id : null);
    this.db.run(
      `INSERT INTO reward_events
         (id, idempotency_hash, match_id, player_id, wallet_binding_id, reward_epoch,
          event_type, amount_micro, occurred_at, ingested_at, server_signature, status, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      crypto.randomUUID(), hash, text(event.match_id), text(event.player_id),
      finalBinding,
      epochId, text(event.event_type), int(event.amount_micro),
      int(event.occurred_at), now, text(event.server_signature), status, reason);
  }

  /** Caps are dual-enforced (HIGH-04 fix): per player_id AND per wallet_binding_id.
   *  Prevents bypass by changing nickname: if wallet linked, wallet cap is the
   *  stable identity; we enforce BOTH so neither dimension can be abused. */
  private capViolation(event: IncomingEvent, now: number): string | null {
    if (event.amount_micro > this.config.capPerMatchMicro) {
      return `amount exceeds per-match cap (${this.config.capPerMatchMicro} micro)`;
    }
    // per-match caps — check both player and wallet dimensions
    const matchSumPlayer = this.db.get<{ s: number }>(
      `SELECT COALESCE(SUM(amount_micro), 0) AS s FROM reward_events
        WHERE match_id = ? AND player_id = ? AND status = 'accepted'`,
      event.match_id, event.player_id);
    if ((matchSumPlayer?.s ?? 0) + event.amount_micro > this.config.capPerMatchMicro) {
      return "per-match cap exceeded";
    }
    if (event.wallet_binding_id) {
      const matchSumWallet = this.db.get<{ s: number }>(
        `SELECT COALESCE(SUM(amount_micro), 0) AS s FROM reward_events
          WHERE match_id = ? AND wallet_binding_id = ? AND status = 'accepted'`,
        event.match_id, event.wallet_binding_id);
      if ((matchSumWallet?.s ?? 0) + event.amount_micro > this.config.capPerMatchMicro) {
        return "per-match cap exceeded (wallet)";
      }
    }
    const dayStart = windowStart(now, DAY_MS);
    // daily caps — player AND wallet (if linked)
    const daySumPlayer = this.db.get<{ s: number }>(
      `SELECT COALESCE(SUM(amount_micro), 0) AS s FROM reward_events
        WHERE player_id = ? AND status = 'accepted' AND ingested_at >= ?`,
      event.player_id, dayStart);
    if ((daySumPlayer?.s ?? 0) + event.amount_micro > this.config.capDailyMicro) {
      return "daily cap exceeded";
    }
    if (event.wallet_binding_id) {
      const daySumWallet = this.db.get<{ s: number }>(
        `SELECT COALESCE(SUM(amount_micro), 0) AS s FROM reward_events
          WHERE wallet_binding_id = ? AND status = 'accepted' AND ingested_at >= ?`,
        event.wallet_binding_id, dayStart);
      if ((daySumWallet?.s ?? 0) + event.amount_micro > this.config.capDailyMicro) {
        return "daily cap exceeded (wallet)";
      }
    }
    const weekStart = windowStart(now, WEEK_MS);
    const weekSumPlayer = this.db.get<{ s: number }>(
      `SELECT COALESCE(SUM(amount_micro), 0) AS s FROM reward_events
        WHERE player_id = ? AND status = 'accepted' AND ingested_at >= ?`,
      event.player_id, weekStart);
    if ((weekSumPlayer?.s ?? 0) + event.amount_micro > this.config.capWeeklyMicro) {
      return "weekly cap exceeded";
    }
    if (event.wallet_binding_id) {
      const weekSumWallet = this.db.get<{ s: number }>(
        `SELECT COALESCE(SUM(amount_micro), 0) AS s FROM reward_events
          WHERE wallet_binding_id = ? AND status = 'accepted' AND ingested_at >= ?`,
        event.wallet_binding_id, weekStart);
      if ((weekSumWallet?.s ?? 0) + event.amount_micro > this.config.capWeeklyMicro) {
        return "weekly cap exceeded (wallet)";
      }
    }
    return null;
  }

  // ---------------------------------------------------------------- queries

  balance(binding: BindingRow): {
    available_micro: number; pending_micro: number; claimed_micro: number;
  } {
    const accepted = this.db.get<{ s: number }>(
      `SELECT COALESCE(SUM(amount_micro), 0) AS s FROM reward_events
        WHERE wallet_binding_id = ? AND status = 'accepted'`, binding.id);
    const sealed = this.db.get<{ s: number }>(
      `SELECT COALESCE(SUM(e.amount_micro), 0) AS s FROM reward_events e
        JOIN reward_epochs ep ON ep.id = e.reward_epoch
        WHERE e.wallet_binding_id = ? AND e.status = 'accepted' AND ep.state = 'sealed'`,
      binding.id);
    const claimed = this.db.get<{ s: number }>(
      `SELECT COALESCE(SUM(amount_micro), 0) AS s FROM claim_intents
        WHERE wallet_binding_id = ? AND status IN ('submitted', 'confirmed')`, binding.id);
    const total = accepted?.s ?? 0;
    const inSealed = sealed?.s ?? 0;
    const claimedMicro = claimed?.s ?? 0;
    return {
      available_micro: Math.max(0, inSealed - claimedMicro),
      pending_micro: Math.max(0, total - inSealed),
      claimed_micro: claimedMicro,
    };
  }

  eligibility(playerId: string | null, binding: BindingRow, now: number = Date.now()) {
    const dayStart = windowStart(now, DAY_MS);
    const weekStart = windowStart(now, WEEK_MS);
    const key = playerId ?? binding.id;
    const day = this.db.get<{ s: number }>(
      `SELECT COALESCE(SUM(amount_micro), 0) AS s FROM reward_events
        WHERE player_id = ? AND status = 'accepted' AND ingested_at >= ?`, key, dayStart);
    const week = this.db.get<{ s: number }>(
      `SELECT COALESCE(SUM(amount_micro), 0) AS s FROM reward_events
        WHERE player_id = ? AND status = 'accepted' AND ingested_at >= ?`, key, weekStart);
    const dailyUsed = day?.s ?? 0;
    const weeklyUsed = week?.s ?? 0;
    return {
      player_id: playerId,
      wallet_binding_id: binding.id,
      caps: {
        per_match_micro: this.config.capPerMatchMicro,
        daily_micro: this.config.capDailyMicro,
        weekly_micro: this.config.capWeeklyMicro,
      },
      used: { daily_micro: dailyUsed, weekly_micro: weeklyUsed },
      remaining: {
        daily_micro: Math.max(0, this.config.capDailyMicro - dailyUsed),
        weekly_micro: Math.max(0, this.config.capWeeklyMicro - weeklyUsed),
      },
      resets: { daily_at: dayStart + DAY_MS, weekly_at: weekStart + WEEK_MS },
      can_earn: dailyUsed < this.config.capDailyMicro &&
        weeklyUsed < this.config.capWeeklyMicro,
    };
  }

  // ---------------------------------------------------------------- sealing

  sealEpoch(epochId: number, now: number = Date.now()): EpochRow {
    const epoch = this.db.get<EpochRow>("SELECT * FROM reward_epochs WHERE id = ?", epochId);
    if (!epoch) throw new RewardsError(404, "epoch-not-found", `no epoch ${epochId}`);
    if (epoch.state === "sealed") {
      throw new RewardsError(409, "epoch-already-sealed", `epoch ${epochId} is already sealed`);
    }
    const sums = this.db.all<{ wallet_binding_id: string; s: number }>(
      `SELECT COALESCE(e.wallet_binding_id, b.id) AS wallet_binding_id, SUM(e.amount_micro) AS s
       FROM reward_events e
       LEFT JOIN wallet_bindings b ON b.player_id = e.player_id AND b.revoked_at IS NULL
       WHERE e.reward_epoch = ? AND e.status = 'accepted'
         AND (e.wallet_binding_id IS NOT NULL OR b.id IS NOT NULL)
       GROUP BY COALESCE(e.wallet_binding_id, b.id)
       ORDER BY COALESCE(e.wallet_binding_id, b.id)`, epochId);
    const leaves: { bindingId: string; publicKey: string; leaf: string; amount: number }[] = [];
    for (const row of sums) {
      const binding = this.wallets.findBinding(row.wallet_binding_id);
      if (!binding) continue;
      leaves.push({
        bindingId: row.wallet_binding_id,
        publicKey: binding.public_key,
        amount: row.s,
        leaf: leafHash(Buffer.from(binding.public_key, "base64url"), row.s),
      });
    }
    const tree = buildTree(leaves.map((l) => l.leaf));
    this.db.raw.exec("BEGIN");
    try {
      leaves.forEach((leaf, index) => {
        this.db.run(
          `INSERT INTO reward_leaves
             (epoch_id, wallet_binding_id, public_key, amount_micro, leaf_index, leaf_hash)
           VALUES (?, ?, ?, ?, ?, ?)`,
          epochId, leaf.bindingId, leaf.publicKey, leaf.amount, index, leaf.leaf);
      });
      this.db.run(
        `UPDATE reward_epochs SET state = 'sealed', sealed_at = ?, merkle_root = ?,
           total_micro = ?, leaf_count = ? WHERE id = ?`,
        now, tree.root, leaves.reduce((a, l) => a + l.amount, 0), leaves.length, epochId);
      this.db.raw.exec("COMMIT");
    } catch (err) {
      this.db.raw.exec("ROLLBACK");
      throw err;
    }
    return this.db.get<EpochRow>("SELECT * FROM reward_epochs WHERE id = ?", epochId) as EpochRow;
  }

  treeForSealedEpoch(epochId: number): { tree: MerkleTree; leaves: LeafRow[] } {
    const leaves = this.db.all<LeafRow>(
      "SELECT * FROM reward_leaves WHERE epoch_id = ? ORDER BY leaf_index", epochId);
    return { tree: buildTree(leaves.map((l) => l.leaf_hash)), leaves };
  }

  // ---------------------------------------------------------------- claims

  claimIntent(binding: BindingRow, epochId: number,
    now: number = Date.now()): IntentRow & { leaf_index: number } {
    const epoch = this.db.get<EpochRow>("SELECT * FROM reward_epochs WHERE id = ?", epochId);
    if (!epoch) throw new RewardsError(404, "epoch-not-found", `no epoch ${epochId}`);
    if (epoch.state !== "sealed" || !epoch.merkle_root) {
      throw new RewardsError(409, "epoch-not-sealed",
        `epoch ${epochId} is not sealed yet; rewards become claimable after sealing`);
    }
    const existing = this.db.get<IntentRow>(
      "SELECT * FROM claim_intents WHERE wallet_binding_id = ? AND epoch_id = ?",
      binding.id, epochId);
    if (existing) {
      const priorLeaf = this.db.get<LeafRow>(
        "SELECT * FROM reward_leaves WHERE epoch_id = ? AND wallet_binding_id = ?",
        epochId, binding.id);
      if (!priorLeaf) {
        throw new RewardsError(500, "proof-mismatch",
          "intent exists but its epoch leaf is missing");
      }
      return { ...existing, leaf_index: priorLeaf.leaf_index };
    }
    const { tree, leaves } = this.treeForSealedEpoch(epochId);
    const index = leaves.findIndex((l) => l.wallet_binding_id === binding.id);
    if (index < 0) {
      throw new RewardsError(404, "no-rewards-in-epoch",
        `binding ${binding.id} has no accepted rewards in epoch ${epochId}`);
    }
    const leaf = leaves[index] as LeafRow;
    const proof = proofFor(tree, index);
    if (!verifyProofIndexed(leaf.leaf_hash, index, proof, tree.root)) {
      throw new RewardsError(500, "proof-mismatch", "internal merkle proof verification failed");
    }
    const id = crypto.randomUUID();
    this.db.run(
      `INSERT INTO claim_intents
         (id, wallet_binding_id, epoch_id, amount_micro, leaf_hash, merkle_proof, status,
          transaction_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'created', NULL, ?, ?)`,
      id, binding.id, epochId, leaf.amount_micro, leaf.leaf_hash,
      JSON.stringify(proof), now, now);
    const created = this.db.get<IntentRow>("SELECT * FROM claim_intents WHERE id = ?",
      id) as IntentRow;
    return { ...created, leaf_index: leaf.leaf_index };
  }

  claimConfirmation(binding: BindingRow, intentId: string, transactionId: string,
    status: "submitted" | "confirmed" | "failed",
    now: number = Date.now()): IntentRow {
    const intent = this.db.get<IntentRow>(
      "SELECT * FROM claim_intents WHERE id = ? AND wallet_binding_id = ?",
      intentId, binding.id);
    if (!intent) throw new RewardsError(404, "intent-not-found", `no intent ${intentId}`);
    if (intent.status === "confirmed") {
      throw new RewardsError(409, "intent-already-confirmed", "intent is already confirmed");
    }
    this.db.run(
      "UPDATE claim_intents SET status = ?, transaction_id = ?, updated_at = ? WHERE id = ?",
      status, transactionId, now, intentId);
    return this.db.get<IntentRow>("SELECT * FROM claim_intents WHERE id = ?", intentId) as IntentRow;
  }

  intentsFor(binding: BindingRow): IntentRow[] {
    return this.db.all<IntentRow>(
      "SELECT * FROM claim_intents WHERE wallet_binding_id = ? ORDER BY created_at",
      binding.id);
  }

  /** Recompute a sealed root from stored leaves — audit helper. */
  auditRoot(epochId: number): string {
    const { tree } = this.treeForSealedEpoch(epochId);
    return tree.root;
  }
}

function validateEvent(event: IncomingEvent): string | null {
  if (typeof event.match_id !== "string" || event.match_id.length === 0 ||
    event.match_id.length > 128) return "match_id invalid";
  if (typeof event.player_id !== "string" || event.player_id.length === 0 ||
    event.player_id.length > 128) return "player_id invalid";
  if (typeof event.event_type !== "string" || event.event_type.length === 0 ||
    event.event_type.length > 64) return "event_type invalid";
  if (!Number.isInteger(event.amount_micro) || event.amount_micro < 0 ||
    event.amount_micro > 1_000_000_000_000) return "amount_micro invalid";
  if (!Number.isInteger(event.occurred_at) || event.occurred_at <= 0) {
    return "occurred_at invalid";
  }
  if (typeof event.server_signature !== "string" || event.server_signature.length === 0) {
    return "server_signature missing";
  }
  return null;
}
