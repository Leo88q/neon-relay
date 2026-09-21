/**
 * Tranche-B on-chain reconciliation: read published epoch/prize accounts over
 * RPC and compare them against the backend ledger.
 *
 *   rewards EpochState  — PDA [b"neonrelay_epoch", epoch_id u64be]
 *   economy PrizeEpoch  — PDA [b"neonrelay_prizes", epoch u64le] (v1 top-10)
 *
 * Every comparison is persisted into `reconcile_snapshots` (append-only), so
 * a later audit can replay what the backend believed versus what the chain
 * held. Treasury balances are snapshotted separately; movements are derived
 * from consecutive snapshots, never asserted from a single row.
 */
import { createHash } from "node:crypto";
import {
  base58Decode, base58Encode, findProgramAddress, parseEconomyV1Config,
  type RpcCaller,
} from "./economy.ts";
import type { Db } from "./db.ts";

export class ReconcileError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const REWARDS_EPOCH_SEED = Buffer.from("neonrelay_epoch", "utf8");
const PRIZES_SEED = Buffer.from("neonrelay_prizes", "utf8");
const ECONOMY_CONFIG_SEED = Buffer.from("neonrelay_economy_config", "utf8");

// EpochState: id u64 + root [u8;32] + published_at i64 + bump u8 + leaf_count u32
const REWARDS_EPOCH_SIZE = 8 + 8 + 32 + 8 + 1 + 4;
const REWARDS_EPOCH_DISCRIMINATOR = createHash("sha256")
  .update("account:EpochState").digest().subarray(0, 8);

// PrizeEpoch (v1): epoch u64 + root + total u64 + leaf_count u32 + published_at i64 + bump
const PRIZE_EPOCH_V1_SIZE = 8 + 8 + 32 + 8 + 4 + 8 + 1;
const PRIZE_EPOCH_V1_DISCRIMINATOR = createHash("sha256")
  .update("account:PrizeEpoch").digest().subarray(0, 8);

export const ECONOMY_V1_CONFIG_SIZE = 204;

function u64be(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ReconcileError("bad-epoch", "epoch id must be a non-negative safe integer");
  }
  const out = Buffer.alloc(8);
  out.writeBigUInt64BE(BigInt(value));
  return out;
}

function u64le(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ReconcileError("bad-epoch", "epoch id must be a non-negative safe integer");
  }
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(BigInt(value));
  return out;
}

export function rewardsEpochAddress(epochId: number, programRaw: Buffer): Buffer {
  return findProgramAddress([REWARDS_EPOCH_SEED, u64be(epochId)], programRaw).address;
}

export function prizeEpochAddressV1(epoch: number, programRaw: Buffer): Buffer {
  return findProgramAddress([PRIZES_SEED, u64le(epoch)], programRaw).address;
}

export interface RewardsEpochOnchain {
  id: string;
  root: string;
  leafCount: number;
  publishedAt: string;
}

export function parseRewardsEpoch(data: Buffer): RewardsEpochOnchain {
  if (data.length !== REWARDS_EPOCH_SIZE ||
      !data.subarray(0, 8).equals(REWARDS_EPOCH_DISCRIMINATOR)) {
    throw new ReconcileError("bad-account", "not a rewards EpochState account");
  }
  return {
    id: data.readBigUInt64LE(8).toString(),
    root: data.subarray(16, 48).toString("hex"),
    publishedAt: data.readBigInt64LE(48).toString(),
    leafCount: data.readUInt32LE(57),
  };
}

export interface PrizeEpochOnchain {
  epoch: string;
  root: string;
  total: string;
  leafCount: number;
  publishedAt: string;
}

export function parsePrizeEpochV1(data: Buffer): PrizeEpochOnchain {
  if (data.length !== PRIZE_EPOCH_V1_SIZE ||
      !data.subarray(0, 8).equals(PRIZE_EPOCH_V1_DISCRIMINATOR)) {
    throw new ReconcileError("bad-account", "not a v1 PrizeEpoch account");
  }
  return {
    epoch: data.readBigUInt64LE(8).toString(),
    root: data.subarray(16, 48).toString("hex"),
    total: data.readBigUInt64LE(48).toString(),
    leafCount: data.readUInt32LE(56),
    publishedAt: data.readBigInt64LE(60).toString(),
  };
}

async function readAnchorAccount(
  rpc: RpcCaller, programB58: string, addressB58: string, size: number,
): Promise<Buffer | null> {
  let reply: { value?: { owner?: unknown; executable?: unknown; data?: unknown } | null };
  try {
    reply = (await rpc("getAccountInfo",
      [addressB58, { encoding: "base64", commitment: "finalized" }])) as typeof reply;
  } catch (err) {
    throw new ReconcileError("rpc-unavailable", `account read failed: ${(err as Error).message}`);
  }
  const account = reply?.value;
  if (account === null || account === undefined) return null;
  if (account.owner !== programB58 || account.executable !== false ||
      !Array.isArray(account.data) || account.data.length !== 2 || account.data[1] !== "base64" ||
      typeof account.data[0] !== "string") {
    throw new ReconcileError("bad-account", "account owner/encoding mismatch");
  }
  const encoded = account.data[0] as string;
  if (encoded.length !== Math.ceil(size / 3) * 4) {
    throw new ReconcileError("bad-account", "account has an unexpected size");
  }
  const data = Buffer.from(encoded, "base64");
  if (data.toString("base64") !== encoded) {
    throw new ReconcileError("bad-account", "account encoding is not canonical");
  }
  return data;
}

function programRawOf(programB58: string): Buffer {
  const raw = base58Decode(programB58);
  if (raw.length !== 32) throw new ReconcileError("bad-config", "program id must be 32 bytes");
  return raw;
}

export async function readRewardsEpochOnchain(
  rpc: RpcCaller, programB58: string, epochId: number,
): Promise<RewardsEpochOnchain | null> {
  const address = rewardsEpochAddress(epochId, programRawOf(programB58));
  const data = await readAnchorAccount(rpc, programB58, base58Encode(address), REWARDS_EPOCH_SIZE);
  return data === null ? null : parseRewardsEpoch(data);
}

export async function readPrizeEpochOnchain(
  rpc: RpcCaller, programB58: string, epoch: number,
): Promise<PrizeEpochOnchain | null> {
  const address = prizeEpochAddressV1(epoch, programRawOf(programB58));
  const data = await readAnchorAccount(rpc, programB58, base58Encode(address), PRIZE_EPOCH_V1_SIZE);
  return data === null ? null : parsePrizeEpochV1(data);
}

export interface RewardsEpochBackend {
  id: number;
  state: string;
  merkle_root: string | null;
  total_micro: number;
  leaf_count: number;
}

export interface Comparison {
  status: string;
  mismatches: string[];
  backend: unknown;
  onchain: unknown;
  details: Record<string, string>;
}

export function compareRewardsEpoch(
  backend: RewardsEpochBackend | undefined,
  onchain: RewardsEpochOnchain | null,
): Comparison {
  if (!backend && !onchain) {
    return { status: "missing-both", mismatches: [], backend: null, onchain: null, details: {} };
  }
  if (!backend) {
    return {
      status: "missing-backend", mismatches: ["backend-row"],
      backend: null, onchain, details: { note: "chain holds an epoch the backend never sealed" },
    };
  }
  if (backend.state !== "sealed") {
    return onchain === null
      ? { status: "not-sealed", mismatches: [], backend, onchain: null, details: {} }
      : {
          status: "unexpected-onchain", mismatches: ["backend-state"],
          backend, onchain, details: { note: "chain holds a root for an unsealed backend epoch" },
        };
  }
  if (!onchain) {
    return { status: "missing-onchain", mismatches: ["root"], backend, onchain: null, details: {} };
  }
  const mismatches: string[] = [];
  if (onchain.root !== (backend.merkle_root ?? "")) mismatches.push("root");
  if (onchain.leafCount !== backend.leaf_count) mismatches.push("leaf-count");
  if (onchain.id !== String(backend.id)) mismatches.push("epoch-id");
  return {
    status: mismatches.length === 0 ? "match" : `mismatch:${mismatches.join(",")}`,
    mismatches,
    backend,
    onchain,
    details: {},
  };
}

export interface PrizeEpochBackend {
  epoch: number;
  root: string;
  total_micro: number;
  distribution: string;
}

export function comparePrizeEpoch(
  backend: PrizeEpochBackend | undefined,
  onchain: PrizeEpochOnchain | null,
): Comparison {
  if (!backend && !onchain) {
    return { status: "missing-both", mismatches: [], backend: null, onchain: null, details: {} };
  }
  if (!backend) {
    return {
      status: "missing-backend", mismatches: ["backend-row"],
      backend: null, onchain, details: { note: "chain holds prizes the backend never closed" },
    };
  }
  if (!onchain) {
    return { status: "missing-onchain", mismatches: ["root"], backend, onchain: null, details: {} };
  }
  const mismatches: string[] = [];
  const details: Record<string, string> = {};
  if (onchain.root !== backend.root) mismatches.push("root");
  let leafCount = -1;
  try {
    leafCount = (JSON.parse(backend.distribution) as unknown[]).length;
  } catch {
    mismatches.push("distribution-unparseable");
  }
  if (leafCount >= 0 && onchain.leafCount !== leafCount) mismatches.push("leaf-count");
  if (onchain.epoch !== String(backend.epoch)) mismatches.push("epoch-id");
  // v1 claims decrement the on-chain total, so on-chain may only lag the
  // backend figure (claimed = backend - on-chain >= 0); leading is tampering.
  const backendTotal = BigInt(backend.total_micro);
  const chainTotal = BigInt(onchain.total);
  if (chainTotal > backendTotal) {
    mismatches.push("total");
  } else {
    details.claimed_micro = (backendTotal - chainTotal).toString();
  }
  return {
    status: mismatches.length === 0 ? "match" : `mismatch:${mismatches.join(",")}`,
    mismatches,
    backend: { ...backend, distribution: `(${leafCount} leaves)` },
    onchain,
    details,
  };
}

export function recordReconcile(db: Db, entry: {
  kind: string; ref: string; status: string; backend?: unknown; onchain?: unknown; details?: unknown;
}, now: number = Date.now()): number {
  return db.runInsert(
    "INSERT INTO reconcile_snapshots (created_at, kind, ref, status, backend, onchain, details) VALUES (?, ?, ?, ?, ?, ?, ?)",
    now, entry.kind, entry.ref, entry.status,
    entry.backend === undefined ? null : JSON.stringify(entry.backend),
    entry.onchain === undefined ? null : JSON.stringify(entry.onchain),
    entry.details === undefined ? null : JSON.stringify(entry.details));
}

export async function reconcileRewardsEpoch(
  db: Db, rpc: RpcCaller, programB58: string, epochId: number,
): Promise<Comparison & { snapshot_id: number }> {
  const backend = db.get<RewardsEpochBackend>("SELECT * FROM reward_epochs WHERE id = ?", epochId);
  const onchain = await readRewardsEpochOnchain(rpc, programB58, epochId);
  const comparison = compareRewardsEpoch(backend, onchain);
  const snapshotId = recordReconcile(db, {
    kind: "rewards-epoch", ref: String(epochId), status: comparison.status,
    backend: comparison.backend, onchain: comparison.onchain, details: comparison.details,
  });
  return { ...comparison, snapshot_id: snapshotId };
}

export async function reconcilePrizeEpoch(
  db: Db, rpc: RpcCaller, programB58: string, epoch: number,
): Promise<Comparison & { snapshot_id: number }> {
  const backend = db.get<PrizeEpochBackend>("SELECT * FROM economy_epochs WHERE epoch = ?", epoch);
  const onchain = await readPrizeEpochOnchain(rpc, programB58, epoch);
  const comparison = comparePrizeEpoch(backend, onchain);
  const snapshotId = recordReconcile(db, {
    kind: "prize-epoch", ref: String(epoch), status: comparison.status,
    backend: comparison.backend, onchain: comparison.onchain, details: comparison.details,
  });
  return { ...comparison, snapshot_id: snapshotId };
}

// ------------------------------------------------------------------- treasury

export interface TreasuryState {
  program: string;
  mint: string;
  vault: string;
  treasury: string;
  vaultBalance: string;
  treasuryBalance: string;
  reserved: string;
}

async function tokenBalanceOf(rpc: RpcCaller, addressB58: string, what: string): Promise<string> {
  let reply: { value?: { amount?: unknown } };
  try {
    reply = (await rpc("getTokenAccountBalance",
      [addressB58, { commitment: "finalized" }])) as typeof reply;
  } catch (err) {
    throw new ReconcileError("rpc-unavailable", `${what} balance read failed: ${(err as Error).message}`);
  }
  const amount = reply?.value?.amount;
  if (typeof amount !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(amount)) {
    throw new ReconcileError("bad-balance", `${what} balance is not a canonical u64`);
  }
  return amount;
}

/** Snapshot the v1 economy vault/treasury from finalized chain state. */
export async function readTreasuryState(
  rpc: RpcCaller, programB58: string, expectedMintB58: string | null,
): Promise<TreasuryState> {
  const program = programRawOf(programB58);
  const configAddress = base58Encode(findProgramAddress([ECONOMY_CONFIG_SEED], program).address);
  const data = await readAnchorAccount(rpc, programB58, configAddress, ECONOMY_V1_CONFIG_SIZE);
  if (data === null) throw new ReconcileError("bad-account", "economy config account does not exist");
  const config = parseEconomyV1Config(data);
  const mint = base58Encode(config.mint);
  if (expectedMintB58 && mint !== expectedMintB58) {
    throw new ReconcileError("mint-mismatch", "on-chain config mint differs from the operator mint");
  }
  const vault = base58Encode(config.vault);
  const treasury = base58Encode(config.treasury);
  return {
    program: programB58,
    mint,
    vault,
    treasury,
    vaultBalance: await tokenBalanceOf(rpc, vault, "vault"),
    treasuryBalance: await tokenBalanceOf(rpc, treasury, "treasury"),
    reserved: config.reserved.toString(),
  };
}

export interface TreasuryRecord extends TreasuryState {
  id: number;
  created_at: number;
  vaultDelta: string | null;
  treasuryDelta: string | null;
  reservedDelta: string | null;
}

export function recordTreasury(db: Db, state: TreasuryState, now: number = Date.now()): TreasuryRecord {
  const previous = db.get<{ vault_balance: string; treasury_balance: string; reserved: string }>(
    "SELECT vault_balance, treasury_balance, reserved FROM treasury_snapshots WHERE program = ? AND mint = ? ORDER BY id DESC LIMIT 1",
    state.program, state.mint);
  const id = db.runInsert(
    `INSERT INTO treasury_snapshots
       (created_at, program, mint, vault, treasury, vault_balance, treasury_balance, reserved)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    now, state.program, state.mint, state.vault, state.treasury,
    state.vaultBalance, state.treasuryBalance, state.reserved);
  const delta = (nowText: string, before?: string): string | null =>
    before === undefined ? null : (BigInt(nowText) - BigInt(before)).toString();
  return {
    ...state,
    id,
    created_at: now,
    vaultDelta: delta(state.vaultBalance, previous?.vault_balance),
    treasuryDelta: delta(state.treasuryBalance, previous?.treasury_balance),
    reservedDelta: delta(state.reserved, previous?.reserved),
  };
}
