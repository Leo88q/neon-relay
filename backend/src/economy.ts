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
 * Top-10 prize close: rank wallets by accepted reward-event volume, keep only
 * wallets holding a ranked epoch pass (kind 0) or any tournament ticket in
 * the epoch, apply PRIZE_TABLE_BPS to the pool and build the Merkle tree.
 * Ticket checks go through the injected RPC caller (mocked in tests).
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
  const leaves: PrizeLeaf[] = [];
  for (const row of deps.rankedTotals) {
    if (leaves.length >= PRIZE_TABLE_BPS.length) break;
    const raw = base58Decode(row.wallet);
    if (!(await deps.hasTicket(raw))) continue;
    const bps = PRIZE_TABLE_BPS[leaves.length];
    const amount = Number((BigInt(deps.poolMicro) * BigInt(bps)) / 10_000n);
    if (amount <= 0) continue;
    leaves.push({ wallet: row.wallet, publicKeyRaw: raw, amountMicro: amount, place: leaves.length + 1 });
  }
  const tree = buildTree(leaves.map((l) => leafHash(l.publicKeyRaw, l.amountMicro)));
  return {
    epoch: deps.epoch,
    root: tree.root,
    totalMicro: leaves.reduce((a, l) => a + l.amountMicro, 0),
    leaves,
    tree,
  };
}

export function proofForWallet(result: EpochCloseResult, wallet: string): string[] | null {
  const index = result.leaves.findIndex((l) => l.wallet === wallet);
  if (index < 0) return null;
  return proofFor(result.tree, index);
}

/** Minimal JSON-RPC caller for Solana RPC (injectable in tests). */
export function httpRpc(url: string): RpcCaller {
  return async (method, params) => {
    const res = await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!res.ok) throw new Error(`rpc http ${res.status}`);
    const json = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (json.error) throw new Error(`rpc error: ${json.error.message ?? "unknown"}`);
    return json.result;
  };
}
