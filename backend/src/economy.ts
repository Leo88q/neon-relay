/**
 * Neon Relay economy service (stage 15).
 *
 * Derives EntryTicket PDAs of the on-chain economy program, checks ticket
 * status over Solana RPC and closes epochs into top-10 prize distributions
 * with Merkle roots. The backend holds NO chain keys: roots are stored for an
 * operator/admin publish step (docs/PLAY_ECONOMY.md §3-§4, DEVNET_RUNBOOK §4).
 *
 * Reference scheme (policy layer over the mint-agnostic program):
 *   reference = SHA256(kind u8 || epoch u64le || extra u64le || wallet32)
 * kind 0 = ranked epoch pass (fee_match), kind 1 = tournament (fee_tournament,
 * extra = tournament id). Per-ranked-match references arrive with the
 * match-intent channel (stage 17); the program already accepts them.
 */
import { createHash } from "node:crypto";
import { buildTree, leafHash, proofFor, type MerkleTree } from "./merkle.ts";
import { PRIZE_TABLE_BPS } from "./prize_table.ts";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Encode(buf: Buffer): string {
  let n = BigInt("0x" + (buf.length ? buf.toString("hex") : "0"));
  let out = "";
  while (n > 0n) {
    const r = Number(n % 58n);
    n /= 58n;
    out = ALPHABET[r] + out;
  }
  for (const b of buf) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out || "1";
}

export function base58Decode(s: string): Buffer {
  let n = 0n;
  for (const c of s) {
    const v = ALPHABET.indexOf(c);
    if (v < 0) throw new Error(`invalid base58 character: ${c}`);
    n = n * 58n + BigInt(v);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  const body = n === 0n ? Buffer.alloc(0) : Buffer.from(hex, "hex");
  let zeros = 0;
  for (const c of s) {
    if (c !== "1") break;
    zeros++;
  }
  return Buffer.concat([Buffer.alloc(zeros), body]);
}

// ---------------------------------------------------------------- ed25519 curve

const P = (1n << 255n) - 19n;

function modPow(base: bigint, exp: bigint, m: bigint): bigint {
  let b = ((base % m) + m) % m;
  let e = exp;
  let acc = 1n;
  while (e > 0n) {
    if (e & 1n) acc = (acc * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return acc;
}

const D = ((P - 121665n) * modPow(121666n, P - 2n, P)) % P;

/**
 * RFC 8032 point decompression: returns true iff the 32-byte encoding
 * represents a curve point. Used to reject on-curve candidates while
 * searching PDA bumps (PDAs must NOT be valid points).
 */
export function isOnCurveEncoded(enc: Buffer): boolean {
  if (enc.length !== 32) return false;
  const raw = BigInt("0x" + Buffer.from(enc).reverse().toString("hex"));
  const y = raw & ((1n << 255n) - 1n);
  if (y >= P) return false;
  const sign = (raw >> 255n) & 1n;
  const y2 = (y * y) % P;
  const u = (y2 - 1n + P) % P;
  const v = (D * y2 + 1n) % P;
  const v3 = (v * v % P) * v % P;
  const v7 = (v3 * v3 % P) * v % P;
  let x = (u * v3 % P) * modPow((u * v7) % P, (P - 5n) / 8n, P) % P;
  const vx2 = (v * x % P) * x % P;
  if (vx2 === u) {
    // ok
  } else if (vx2 === (P - u) % P) {
    x = (x * modPow(2n, (P - 1n) / 4n, P)) % P;
  } else {
    return false;
  }
  if (x === 0n && sign === 1n) return false;
  return true;
}

const PDA_MARKER = Buffer.from("ProgramDerivedAddress", "utf8");

export function findProgramAddress(
  seeds: Buffer[],
  programId: Buffer,
): { address: Buffer; bump: number } {
  for (let bump = 255; bump >= 0; bump--) {
    const h = createHash("sha256");
    for (const s of seeds) h.update(s);
    h.update(Buffer.from([bump]));
    h.update(programId);
    h.update(PDA_MARKER);
    const candidate = h.digest();
    if (!isOnCurveEncoded(candidate)) return { address: candidate, bump };
  }
  throw new Error("no valid PDA bump found");
}

// ---------------------------------------------------------------- references

export const ENTRY_SEED = Buffer.from("neonrelay_entry", "utf8");

export function entryReference(
  kind: number,
  epoch: number,
  walletRaw: Buffer,
  extra = 0,
): Buffer {
  if (walletRaw.length !== 32) throw new Error("wallet must be 32 raw bytes");
  const b = Buffer.alloc(1 + 8 + 8);
  b.writeUInt8(kind, 0);
  b.writeBigUInt64LE(BigInt(epoch), 1);
  b.writeBigUInt64LE(BigInt(extra), 9);
  return createHash("sha256").update(b).update(walletRaw).digest();
}

export function ticketAddress(
  reference: Buffer,
  walletRaw: Buffer,
  programIdRaw: Buffer,
): Buffer {
  return findProgramAddress([ENTRY_SEED, reference, walletRaw], programIdRaw).address;
}

// ---------------------------------------------------------------- ticket read

export interface TicketStatus {
  ticketed: boolean;
  kind?: number;
  amountMicro?: number;
  paidAt?: number;
}

/** Borsh layout after the 8-byte discriminator: player(32) ref(32) kind(u8)
 *  amount(u64le) paid_at(i64le) bump(u8). */
export const TICKET_DISCRIMINATOR = createHash("sha256").update("account:EntryTicket").digest().subarray(0, 8);
const TICKET_SIZE = 8 + 32 + 32 + 1 + 8 + 8 + 1;

export function parseTicketData(data: Buffer): TicketStatus {
  if (data.length !== TICKET_SIZE || !data.subarray(0, 8).equals(TICKET_DISCRIMINATOR)) return { ticketed: false };
  const kind = data.readUInt8(72);
  const amount = data.readBigUInt64LE(73);
  const paidAt = data.readBigInt64LE(81);
  // Legacy JSON API uses number. Reject, never silently round an on-chain u64.
  if (kind > 1 || amount === 0n || amount > BigInt(Number.MAX_SAFE_INTEGER) ||
      paidAt < 0n || paidAt > BigInt(Number.MAX_SAFE_INTEGER)) return { ticketed: false };
  return { ticketed: true, kind, amountMicro: Number(amount), paidAt: Number(paidAt) };
}

export type RpcCaller = (method: string, params: unknown[]) => Promise<unknown>;

export async function ticketStatus(
  rpc: RpcCaller,
  programIdB58: string,
  reference: Buffer,
  walletRaw: Buffer,
): Promise<TicketStatus> {
  const program = base58Decode(programIdB58);
  if (program.length !== 32 || reference.length !== 32 || walletRaw.length !== 32) {
    throw new Error("ticket address inputs must be 32 bytes");
  }
  const { address, bump } = findProgramAddress([ENTRY_SEED, reference, walletRaw], program);
  const res = (await rpc("getAccountInfo", [base58Encode(address), { encoding: "base64", commitment: "finalized" }])) as {
    value?: { owner?: unknown; executable?: unknown; data?: unknown };
  };
  const account = res?.value;
  if (!account || account.owner !== programIdB58 || account.executable !== false ||
      !Array.isArray(account.data) || account.data.length !== 2 || account.data[1] !== "base64" ||
      typeof account.data[0] !== "string") return { ticketed: false };
  // Strict canonical decoding also bounds memory allocation from untrusted RPC.
  const encoded = account.data[0];
  if (encoded.length !== Math.ceil(TICKET_SIZE / 3) * 4) return { ticketed: false };
  const data = Buffer.from(encoded, "base64");
  if (data.toString("base64") !== encoded) return { ticketed: false };
  const parsed = parseTicketData(data);
  if (!parsed.ticketed || !data.subarray(8, 40).equals(walletRaw) ||
      !data.subarray(40, 72).equals(reference) || data[89] !== bump) return { ticketed: false };
  return parsed;
}

// ---------------------------------------------------------------- epoch close

export interface PrizeLeaf {
  wallet: string; // base58
  publicKeyRaw: Buffer;
  amountMicro: number;
  place: number;
}

export interface EpochCloseResult {
  epoch: number;
  root: string;
  totalMicro: number;
  leaves: PrizeLeaf[];
  tree: MerkleTree;
}

/**
 * Leftover policy (Tranche A, docs/PLAY_ECONOMY.md §4): REDISTRIBUTION.
 *
 * When fewer than 10 ticketed winners exist, the pool is NOT split by the
 * raw table (which would strand the unoccupied shares in the vault with no
 * accounting). Instead the occupied places' bps are rescaled to 100%:
 *
 *   amount[i] = floor(pool * bps[i] / sum(bps[0..n]))
 *
 * with the integer-division dust (always < n units) distributed +1 to the
 * largest remainders, ties broken by rank. The distributed total therefore
 * always equals the pool; a full 10-winner close is byte-identical to the
 * legacy table split.
 *
 * Dust pools (pool < winner count) may round some tail places to zero after
 * the +1 pass; those winners receive no leaf (a zero leaf could never be
 * claimed on-chain) and the undistributed remainder stays in the vault as
 * accounted dust. Zero eligible winners produce no leaves at all: the route
 * refuses to close and the pool stays in the vault for the next epoch.
 */
export function redistributePool(poolMicro: number, places: number): number[] {
  if (!Number.isInteger(poolMicro) || poolMicro <= 0 || poolMicro > Number.MAX_SAFE_INTEGER) {
    throw new Error("poolMicro must be positive safe integer u64");
  }
  const tableSum = PRIZE_TABLE_BPS.reduce((a, b) => a + b, 0);
  if (tableSum !== 10000) throw new Error("prizeTable must sum to 10000");
  if (!Number.isInteger(places) || places <= 0 || places > PRIZE_TABLE_BPS.length) {
    throw new Error("places must be within 1..10");
  }
  const bps = PRIZE_TABLE_BPS.slice(0, places);
  const denom = BigInt(bps.reduce((a, b) => a + b, 0));
  const pool = BigInt(poolMicro);
  const amounts = bps.map((b) => Number((pool * BigInt(b)) / denom));
  const remainders = bps.map((b) => (pool * BigInt(b)) % denom);
  let leftover = poolMicro - amounts.reduce((a, b) => a + b, 0);
  const order = amounts.map((_, i) => i).sort((a, b) => {
    const ra = remainders[a] as bigint;
    const rb = remainders[b] as bigint;
    if (ra !== rb) return rb > ra ? 1 : -1;
    return a - b; // rank priority on ties
  });
  for (const i of order) {
    if (leftover <= 0) break;
    (amounts[i] as number) += 1;
    leftover -= 1;
  }
  return amounts;
}

/**
 * Top-10 prize close: rank wallets by accepted reward-event volume, keep only
 * wallets holding a ranked epoch pass (kind 0) or any tournament ticket in
 * the epoch, apply the redistributed prize table to the pool and build the
 * Merkle tree. Ticket checks go through the injected RPC caller (mocked in
 * tests). The pool itself must come from `readVaultPool` (vault balance minus
 * aggregate reservations) — never from an operator-supplied request field.
 */
export async function closeEpochPrizes(deps: {
  rankedTotals: { wallet: string; totalMicro: number }[]; // desc
  hasTicket: (walletRaw: Buffer) => Promise<boolean>;
  poolMicro: number;
  epoch: number;
}): Promise<EpochCloseResult> {
  // HIGH-05 fix: validate poolMicro u64 and prizeTable sum before distribution.
  if (!Number.isInteger(deps.poolMicro) || deps.poolMicro <= 0 || deps.poolMicro > Number.MAX_SAFE_INTEGER) {
    throw new Error("poolMicro must be positive safe integer u64");
  }
  const tableSum = PRIZE_TABLE_BPS.reduce((a,b)=>a+b,0);
  if (tableSum !== 10000) throw new Error("prizeTable must sum to 10000");
  if (!Number.isInteger(deps.epoch) || deps.epoch <= 0) throw new Error("epoch must be positive integer");
  const eligible: { wallet: string; raw: Buffer }[] = [];
  for (const row of deps.rankedTotals) {
    if (eligible.length >= PRIZE_TABLE_BPS.length) break;
    const raw = base58Decode(row.wallet);
    if (!(await deps.hasTicket(raw))) continue;
    eligible.push({ wallet: row.wallet, raw });
  }
  const amounts = eligible.length === 0 ? [] : redistributePool(deps.poolMicro, eligible.length);
  const leaves: PrizeLeaf[] = [];
  eligible.forEach((winner, i) => {
    const amount = amounts[i] as number;
    if (!Number.isSafeInteger(amount) || amount < 0) {
      throw new Error("internal prize rounding error");
    }
    if (amount === 0) return; // dust-pool tail: no leaf, remainder stays vaulted
    leaves.push({ wallet: winner.wallet, publicKeyRaw: winner.raw, amountMicro: amount, place: i + 1 });
  });
  const totalMicro = leaves.reduce((a, l) => a + l.amountMicro, 0);
  if (totalMicro > deps.poolMicro) throw new Error("prize total exceeds the pool");
  const tree = buildTree(leaves.map((l) => leafHash(l.publicKeyRaw, l.amountMicro)));
  return {
    epoch: deps.epoch,
    root: tree.root,
    totalMicro,
    leaves,
    tree,
  };
}

export function proofForWallet(result: EpochCloseResult, wallet: string): string[] | null {
  const index = result.leaves.findIndex((l) => l.wallet === wallet);
  if (index < 0) return null;
  return proofFor(result.tree, index);
}

// ------------------------------------------------------------------ vault pool
//
// Tranche A: the prize pool is derived from chain state, never from an
// operator request field. `readVaultPool` reads the v1 EconomyConfig account
// (vault address + aggregate `reserved`), then the vault token balance, and
// returns available = balance - reserved. The on-chain `publish_prizes`
// re-checks coverage at publication time, so an RPC race can only fail
// closed, never over-allocate.

export const ECONOMY_CONFIG_SEED = Buffer.from("neonrelay_economy_config", "utf8");

/** 8-byte discriminator + EconomyConfig fields (see economy lib.rs). */
export const ECONOMY_V1_CONFIG_SIZE = 204;

export const ECONOMY_V1_CONFIG_DISCRIMINATOR = createHash("sha256")
  .update("account:EconomyConfig").digest().subarray(0, 8);

export interface EconomyV1Config {
  mint: Buffer;
  treasury: Buffer;
  vault: Buffer;
  rakeBps: number;
  feeMatch: bigint;
  feeTournament: bigint;
  paused: boolean;
  reserved: bigint;
}

export function parseEconomyV1Config(data: Buffer): EconomyV1Config {
  if (data.length !== ECONOMY_V1_CONFIG_SIZE ||
      !data.subarray(0, 8).equals(ECONOMY_V1_CONFIG_DISCRIMINATOR)) {
    throw new VaultReadError("bad-config-account", "not a v1 EconomyConfig account");
  }
  return {
    mint: data.subarray(40, 72),
    treasury: data.subarray(72, 104),
    vault: data.subarray(104, 136),
    rakeBps: data.readUInt16LE(136),
    feeMatch: data.readBigUInt64LE(138),
    feeTournament: data.readBigUInt64LE(146),
    paused: data[154] === 1,
    reserved: data.readBigUInt64LE(156),
  };
}

export class VaultReadError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface VaultPool {
  /** Base58 config PDA the snapshot was read from. */
  config: string;
  /** Base58 vault token account. */
  vault: string;
  /** Vault raw balance (u64 decimal string). */
  balance: string;
  /** Aggregate on-chain reservations (u64 decimal string). */
  reserved: string;
  /** Spendable pool = balance - reserved, as a safe JS integer. */
  available: number;
}

/** Read the spendable prize pool from finalized chain state. */
export async function readVaultPool(
  rpc: RpcCaller,
  programIdB58: string,
  expectedMintB58: string | null,
): Promise<VaultPool> {
  const program = base58Decode(programIdB58);
  if (program.length !== 32) throw new VaultReadError("bad-config", "economy program id must be 32 bytes");
  const { address } = findProgramAddress([ECONOMY_CONFIG_SEED], program);
  let configAccount: { value?: { owner?: unknown; executable?: unknown; data?: unknown } };
  try {
    configAccount = (await rpc("getAccountInfo",
      [base58Encode(address), { encoding: "base64", commitment: "finalized" }])) as typeof configAccount;
  } catch (err) {
    throw new VaultReadError("rpc-unavailable", `config read failed: ${(err as Error).message}`);
  }
  const account = configAccount?.value;
  if (!account || account.owner !== programIdB58 || account.executable !== false ||
      !Array.isArray(account.data) || account.data.length !== 2 || account.data[1] !== "base64" ||
      typeof account.data[0] !== "string") {
    throw new VaultReadError("bad-config-account", "economy config account missing or invalid");
  }
  const encoded = account.data[0] as string;
  if (encoded.length !== Math.ceil(ECONOMY_V1_CONFIG_SIZE / 3) * 4) {
    throw new VaultReadError("bad-config-account", "economy config has an unexpected size");
  }
  const data = Buffer.from(encoded, "base64");
  if (data.toString("base64") !== encoded) {
    throw new VaultReadError("bad-config-account", "economy config encoding is not canonical");
  }
  const parsed = parseEconomyV1Config(data);
  if (expectedMintB58 && base58Encode(parsed.mint) !== expectedMintB58) {
    throw new VaultReadError("mint-mismatch", "on-chain config mint differs from the operator mint");
  }
  const vaultB58 = base58Encode(parsed.vault);
  let balanceReply: { value?: { amount?: unknown } };
  try {
    balanceReply = (await rpc("getTokenAccountBalance",
      [vaultB58, { commitment: "finalized" }])) as typeof balanceReply;
  } catch (err) {
    throw new VaultReadError("rpc-unavailable", `vault balance read failed: ${(err as Error).message}`);
  }
  const amountText = balanceReply?.value?.amount;
  if (typeof amountText !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(amountText)) {
    throw new VaultReadError("bad-vault-balance", "vault balance is not a canonical u64");
  }
  const balance = BigInt(amountText);
  if (parsed.reserved > balance) {
    throw new VaultReadError("vault-underfunded", "vault balance is below aggregate reservations");
  }
  const available = balance - parsed.reserved;
  if (available <= 0n) {
    throw new VaultReadError("empty-pool", "no spendable pool in the vault (balance fully reserved)");
  }
  if (available > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new VaultReadError("pool-too-large", "spendable pool exceeds the safe integer range");
  }
  return {
    config: base58Encode(address),
    vault: vaultB58,
    balance: balance.toString(),
    reserved: parsed.reserved.toString(),
    available: Number(available),
  };
}
