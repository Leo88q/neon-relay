/**
 * Executable model of the Neon Relay economy program (v1 + v2).
 *
 * `helpers/rust_accounts.ts` parses and evaluates the *declared* Anchor
 * constraints; this file adds the parts that live in the handler bodies — the
 * pause gate, the `require_safe_token_account` fail-closed token policy, the
 * checked fee/reservation arithmetic, the Merkle proof rules, the authority
 * timelock and the seven-day sweep delay — plus SPL transfer simulation.
 *
 * Every numeric rule here is a literal transcription of the Rust function with
 * the same name in `programs/neonrelay-economy/src/lib.rs`; the checklist suite
 * differentially fuzzes the two so the transcription cannot drift silently.
 */
import { createHash } from "node:crypto";
import {
  addAccount, anchorAccount, applyCloses, ataAddress, evalAccounts, getStruct, k, keyOfBase58, pda,
  parseAccountsStructs, plainWallet, programSource, rentExempt, requireSafeTokenAccount,
  tokenAccount, useConstants, useInitSpace, FailureError, SYSTEM, TOKEN_PROGRAM,
  type AccountsStruct, type EvalResult, type Failure, type Key, type World,
} from "./rust_accounts.ts";

export const SOURCE = programSource("neonrelay-economy");
export const STRUCTS: AccountsStruct[] = parseAccountsStructs(SOURCE);
export const SEED_CONSTANTS = useConstants(SOURCE);
export const INIT_SPACE = useInitSpace(SOURCE);

// --------------------------------------------------------------- program rules

const C = {
  MAX_RAKE_BPS: 2000,
  MAX_RAKE_STEP_BPS: 250,
  MAX_ENTRY_FEE: 2_000n * 1_000_000_000n,
  RAKE_DENOM: 10_000n,
  ENTRY_KIND_MATCH: 0,
  ENTRY_KIND_TOURNAMENT: 1,
  MAX_PROOF_LEN: 32,
  MIN_AUTHORITY_DELAY_SLOTS: 432_000n,
  PRIZE_SWEEP_DELAY_SECONDS: 7n * 24n * 60n * 60n,
  V2_LEAF_COUNT_MAX: 10,
  V2_TIERS: [50n, 100n, 500n, 2000n],
};
export const RULES = C;

const U64_MAX = (1n << 64n) - 1n;

export class ProgramError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.code = code;
    this.name = "ProgramError";
  }
}

function checked(value: bigint | undefined | null, code = "Overflow"): bigint {
  if (value === undefined || value === null) throw new ProgramError(code);
  if (value < 0n || value > U64_MAX) throw new ProgramError(code);
  return value;
}

/** `tier_fees_v2`: 50/100/500/2000 whole tokens, scaled by the mint decimals. */
export function tierFeesV2(decimals: number): bigint[] {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new ProgramError("Overflow");
  let scale = 1n;
  for (let i = 0; i < decimals; i++) {
    scale *= 10n;
    if (scale > U64_MAX) throw new ProgramError("Overflow");
  }
  return C.V2_TIERS.map((tokens) => checked(tokens * scale));
}

/** `split_fee_v2`: floor(amount * bps / 10_000) in u128, then checked back. */
export function splitFeeV2(fee: bigint, rakeBps: number): { rake: bigint; prize: bigint } {
  if (fee <= 0n) throw new ProgramError("InvalidFee");
  if (rakeBps > C.MAX_RAKE_BPS) throw new ProgramError("InvalidRake");
  const product = fee * BigInt(rakeBps);
  if (product > (1n << 128n) - 1n) throw new ProgramError("Overflow");
  const rake = product / C.RAKE_DENOM;
  if (rake > U64_MAX) throw new ProgramError("Overflow");
  return { rake, prize: checked(fee - rake) };
}

/** `reserve_prizes_v2`: aggregate reservation can never exceed the vault. */
export function reservePrizesV2(balance: bigint, reserved: bigint, total: bigint): bigint {
  if (total <= 0n) throw new ProgramError("InvalidTotal");
  const free = balance - reserved;
  if (free < 0n) throw new ProgramError("VaultUnderfunded");
  if (total > free) throw new ProgramError("VaultUnderfunded");
  return checked(reserved + total);
}

/** `proof_depth`: exact padded depth, rejecting malformed leaf counts. */
export function proofDepth(leafCount: number): number {
  if (!Number.isInteger(leafCount) || leafCount <= 0) throw new ProgramError("InvalidLeafCount");
  if (leafCount > 0x8000_0000) throw new ProgramError("InvalidLeafCount"); // next_power_of_two overflow
  let rounded = 1;
  while (rounded < leafCount) rounded *= 2;
  const depth = Math.log2(rounded);
  if (depth > C.MAX_PROOF_LEN) throw new ProgramError("InvalidLeafCount");
  return depth;
}

export function sha256(...parts: (Buffer | string)[]): Buffer {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(typeof part === "string" ? Buffer.from(part, "hex") : part);
  return hash.digest();
}

/** `merkle_leaf_v2` = SHA256(wallet || amount_be || mint). */
export function merkleLeafV2(wallet: Buffer, amount: bigint, mint: Buffer): string {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(amount);
  return sha256(wallet, bytes, mint).toString("hex");
}

/** `merkle_leaf` (v1) = SHA256(wallet || amount_be). */
export function merkleLeaf(wallet: Buffer, amount: bigint): string {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(amount);
  return sha256(wallet, bytes).toString("hex");
}

/** `verify_proof_indexed`: even index ⇒ current on the left. */
export function verifyProofIndexed(leaf: string, leafIndex: number, proof: string[], root: string): boolean {
  let current = leaf;
  let index = leafIndex;
  for (const sibling of proof) {
    current = (index & 1) === 0
      ? sha256(current, sibling).toString("hex")
      : sha256(sibling, current).toString("hex");
    index >>= 1;
  }
  return current === root;
}

/** `verify_proof_v2`: bounded length and no unused high index bits. */
export function verifyProofV2(leaf: string, index: number, proof: string[], root: string): boolean {
  if (proof.length > C.MAX_PROOF_LEN) return false;
  if (proof.length < 32 && BigInt(index) >= (1n << BigInt(proof.length))) return false;
  return verifyProofIndexed(leaf, index, proof, root);
}

// --------------------------------------------------------------- world helpers

export interface Keys {
  programId: Key;
  mint: Key;
  authority: Key;
  treasury: Key;
  vault: Key;
  config: Key;
  configBump: number;
  player: Key;
  playerAta: Key;
  authorityTreasuryAta: Key;
  vaultAta: Key;
  /** The v1 config PDA (seeds = [CONFIG_SEED]) that bootstraps `initialize_v2`. */
  legacyConfig?: Key;
  legacyConfigBump?: number;
}

export interface MarketOptions {
  decimals?: number;
  rakeBps?: number;
  paused?: boolean;
  reserved?: bigint;
  vaultBalance?: bigint;
  treasuryBalance?: bigint;
  playerBalance?: bigint;
  authority?: Key;
  mint?: Key;
  player?: Key;
  /** Include a v1 legacy config so `initialize_v2` can be exercised. */
  legacy?: boolean;
}

export interface Market {
  world: World;
  keys: Keys;
  fees: bigint[];
}

/** Build a fully initialised v2 market world (post-`initialize_v2` state). */
export function v2Market(options: MarketOptions = {}): Market {
  const decimals = options.decimals ?? 6;
  const programId = keyOfBase58("FZcLDdUrs6i1HYFFK2NhqNrbVaP6KTvrqzhyoDGT6CV9");
  const mint = options.mint ?? k("mint");
  const authority = options.authority ?? k("authority");
  const player = options.player ?? k("player");
  const seed = Buffer.from(SEED_CONSTANTS.get("CONFIG_V2_SEED") ?? "neonrelay_economy_v2", "utf8");
  const configPda = pda([seed, Buffer.from(mint, "hex")], programId);
  const vaultAta = ataAddress(configPda.address, mint);
  const authorityTreasuryAta = ataAddress(authority, mint);
  const playerAta = ataAddress(player, mint);
  const fees = tierFeesV2(decimals);

  const world = makeWorldWithProgram(programId);
  plainWallet(world, authority);
  plainWallet(world, player);
  addAccount(world, {
    key: mint, owner: keyOfBase58(TOKEN_PROGRAM), lamports: 1_461_600,
    mintAuthority: null, freezeAuthority: null, decimals,
  });
  anchorAccount(world, configPda.address, {
    __type: "EconomyConfigV2",
    authority, mint, treasury_ata: authorityTreasuryAta, vault_ata: vaultAta,
    fees, rake_bps: options.rakeBps ?? 1000, reserved: options.reserved ?? 0n,
    paused: options.paused ?? false, bump: configPda.bump,
  }, rentExempt(8 + (INIT_SPACE.get("EconomyConfigV2") ?? 172)));
  tokenAccount(world, vaultAta, { mint, owner: configPda.address, amount: options.vaultBalance ?? 0n });
  tokenAccount(world, authorityTreasuryAta, { mint, owner: authority, amount: options.treasuryBalance ?? 0n });
  tokenAccount(world, playerAta, { mint, owner: player, amount: options.playerBalance ?? 1_000_000n });

  const legacySeed = Buffer.from(SEED_CONSTANTS.get("CONFIG_SEED") ?? "neonrelay_economy_config", "utf8");
  const legacyPda = pda([legacySeed], programId);
  if (options.legacy) {
    anchorAccount(world, legacyPda.address, {
      __type: "EconomyConfig", authority, mint, treasury_ata: authorityTreasuryAta,
      vault_ata: vaultAta, rake_bps: 1000, fee_match: 100n, fee_tournament: 200n,
      paused: true, bump: legacyPda.bump, reserved: 0n,
      pending_authority: "0".repeat(64), authority_change_slot: 0n,
    }, rentExempt(8 + (INIT_SPACE.get("EconomyConfig") ?? 196)));
  }

  return {
    world, fees,
    keys: {
      programId, mint, authority, treasury: authorityTreasuryAta, vault: vaultAta,
      config: configPda.address, configBump: configPda.bump, player, playerAta,
      authorityTreasuryAta, vaultAta,
      legacyConfig: legacyPda.address, legacyConfigBump: legacyPda.bump,
    },
  };
}

export function makeWorldWithProgram(programId: Key): World {
  const world: World = {
    programId,
    accounts: new Map(),
    signers: new Set(),
    args: {},
    clock: { slot: 100, unixTimestamp: 1_700_000_000 },
    created: [], closed: [], transfers: [], events: [],
  };
  return world;
}

/** Pass every field of a struct; `overrides` wins, sensible defaults fill in. */
export function pass(world: World, struct: AccountsStruct, keys: Record<string, Key>,
  overrides: Record<string, Key> = {}): void {
  for (const field of struct.fields) {
    const key = overrides[field.name] ?? keys[field.name] ?? defaultKeyFor(field.name, world);
    world.args[`__key_${field.name}`] = key;
  }
}

function defaultKeyFor(name: string, world: World): Key {
  if (name === "token_program") return keyOfBase58(TOKEN_PROGRAM);
  if (name === "system_program") return keyOfBase58(SYSTEM);
  if (name === "associated_token_program") {
    return keyOfBase58("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
  }
  if (name === "program_data") return k("program-data");
  void world;
  throw new Error(`no default key for account slot ${name}`);
}

export function mustPass(result: EvalResult, context = ""): void {
  if (!result.ok) {
    throw new Error(`constraints unexpectedly rejected${context ? ` (${context})` : ""}: ` +
      `${result.failure.kind} on ${result.failure.accountField} — ${result.failure.detail}`);
  }
}

export function expectFailure(result: EvalResult, kind: Failure["kind"], field?: string): Failure {
  if (result.ok) {
    throw new Error(`expected ${kind}${field ? ` on ${field}` : ""} but every constraint passed`);
  }
  if (result.failure.kind !== kind || (field && result.failure.accountField !== field)) {
    throw new Error(`expected ${kind}${field ? ` on ${field}` : ""}, got ` +
      `${result.failure.kind} on ${result.failure.accountField} — ${result.failure.detail}`);
  }
  return result.failure;
}

function run(struct: AccountsStruct, world: World): EvalResult {
  const result = evalAccounts(struct, world);
  if (!result.ok) return result;
  return { ok: true };
}

// ------------------------------------------------------------ atomicity
//
// A Solana transaction is atomic: if the instruction body returns `Err`, every
// account write it already made is discarded and the only thing that survives is
// the fee. The harness mutates a plain object graph, so without an explicit
// rollback a half-applied handler would look like a real partial payout — and
// would also leave `init`-created PDAs behind, making a later retry fail with
// `already-initialized` instead of the error under test.
//
// Every instruction runner therefore takes a snapshot before it evaluates the
// accounts struct and restores it on any failure path.

interface Snapshot {
  accounts: Map<Key, WorldAccount>;
  created: World["created"];
  closed: World["closed"];
  transfers: World["transfers"];
  events: World["events"];
}

/** Structural clone for the value types an account can hold (bigint included). */
function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => cloneValue(v)) as unknown as T;
  if (Buffer.isBuffer(value)) return Buffer.from(value) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = cloneValue(v);
    return out as T;
  }
  return value;
}

function snapshot(world: World): Snapshot {
  const accounts = new Map<Key, WorldAccount>();
  // `data` has to be cloned too: the handlers write through
  // `accountData(world, key)`, so a shallow copy would leave the "rolled back"
  // world pointing at the very object the failed instruction already mutated.
  for (const [key, acc] of world.accounts) {
    accounts.set(key, { ...acc, data: acc.data ? cloneValue(acc.data) : acc.data });
  }
  return {
    accounts,
    created: [...world.created],
    closed: [...world.closed],
    transfers: [...world.transfers],
    events: [...world.events],
  };
}

function restore(world: World, snap: Snapshot): void {
  world.accounts = snap.accounts;
  world.created = snap.created;
  world.closed = snap.closed;
  world.transfers = snap.transfers;
  world.events = snap.events;
}

/** Evaluate the accounts struct; roll the world back if Anchor rejects it. */
function runTx(struct: AccountsStruct, world: World, snap: Snapshot): EvalResult {
  const result = run(struct, world);
  if (!result.ok) restore(world, snap);
  return result;
}

/** Mark the instruction as committed, so the snapshot can be dropped. */
function commitTx(_snap: Snapshot): EvalResult {
  return { ok: true };
}

/** SPL token transfer with balance enforcement, mirroring `token::transfer`. */
export function transfer(world: World, from: Key, to: Key, amount: bigint, field: string): void {
  if (amount < 0n) throw new FailureError("constraint-failed", field, "negative transfer amount");
  if (amount === 0n) return;
  const source = world.accounts.get(from);
  const destination = world.accounts.get(to);
  if (!source || !destination) {
    throw new FailureError("missing-account", field, "token account missing for transfer");
  }
  if ((source.amount ?? 0n) < amount) {
    throw new FailureError("constraint-failed", field,
      `insufficient funds: ${String(source.amount)} < ${String(amount)}`);
  }
  // Debit before crediting: SPL settles the whole transfer or none of it.
  source.amount = (source.amount ?? 0n) - amount;
  destination.amount = (destination.amount ?? 0n) + amount;
  world.transfers.push({ from, to, amount });
}

export function accountData(world: World, key: Key): Record<string, unknown> {
  const acc = world.accounts.get(key);
  if (!acc || !acc.data) throw new Error(`no anchor data at ${key.slice(0, 8)}…`);
  return acc.data;
}

export function balance(world: World, key: Key): bigint {
  return world.accounts.get(key)?.amount ?? 0n;
}

// ------------------------------------------------------------------- handlers

export interface PayEntryV2Args {
  reference: string; // 32-byte hex
  kind?: number;
  tier?: number;
  player?: Key;
  playerAta?: Key;
  config?: Key;
  vault?: Key;
  treasury?: Key;
  ticket?: Key;
  signers?: Key[];
  extraKeys?: Record<string, Key>;
  skipHandler?: boolean;
}

export function ticketPdaV2(market: Market, reference: string, player: Key): { address: Key; bump: number } {
  const seed = Buffer.from(SEED_CONSTANTS.get("ENTRY_V2_SEED") ?? "neonrelay_entry_v2", "utf8");
  return pda([seed, Buffer.from(market.keys.mint, "hex"), Buffer.from(reference, "hex"),
    Buffer.from(player, "hex")], market.keys.programId);
}

export function prizesPdaV2(market: Market, epoch: bigint): { address: Key; bump: number } {
  const seed = Buffer.from(SEED_CONSTANTS.get("PRIZES_V2_SEED") ?? "neonrelay_prizes_v2", "utf8");
  const le = Buffer.alloc(8);
  le.writeBigUInt64LE(epoch);
  return pda([seed, Buffer.from(market.keys.mint, "hex"), le], market.keys.programId);
}

export function claimPdaV2(market: Market, epoch: bigint, player: Key): { address: Key; bump: number } {
  const seed = Buffer.from(SEED_CONSTANTS.get("CLAIM_V2_SEED") ?? "neonrelay_claim_v2", "utf8");
  const le = Buffer.alloc(8);
  le.writeBigUInt64LE(epoch);
  return pda([seed, Buffer.from(market.keys.mint, "hex"), le, Buffer.from(player, "hex")],
    market.keys.programId);
}

export function pendingPdaV2(market: Market): { address: Key; bump: number } {
  const seed = Buffer.from(SEED_CONSTANTS.get("PENDING_V2_SEED") ?? "neonrelay_pending_v2", "utf8");
  return pda([seed, Buffer.from(market.keys.mint, "hex")], market.keys.programId);
}

/** `pay_entry_v2`, constraints first then the handler body. */
export function payEntryV2(market: Market, args: PayEntryV2Args): EvalResult {
  const { world, keys } = market;
  const struct = getStruct(STRUCTS, "PayEntryV2");
  const snap = snapshot(world);
  const player = args.player ?? keys.player;
  const playerAta = args.playerAta ?? keys.playerAta;
  const reference = args.reference;
  const ticket = args.ticket ?? ticketPdaV2(market, reference, player).address;
  world.args.reference = reference;
  world.args.kind = args.kind ?? C.ENTRY_KIND_MATCH;
  world.args.tier = args.tier ?? 0;
  world.args["config.mint"] = keys.mint;
  world.signers = new Set(args.signers ?? [player]);
  pass(world, struct, {
    player, config: keys.config, player_ata: playerAta, vault_ata: keys.vaultAta,
    treasury_ata: keys.treasury, ticket,
  }, args.extraKeys ?? {});
  const result = runTx(struct, world, snap);
  if (!result.ok || args.skipHandler) return result;
  try {
    const config = accountData(world, keys.config) as {
      paused: boolean; mint: Key; fees: bigint[]; rake_bps: number;
    };
    if (config.paused) throw new ProgramError("Paused");
    const kind = world.args.kind as number;
    if (kind !== C.ENTRY_KIND_MATCH && kind !== C.ENTRY_KIND_TOURNAMENT) {
      throw new ProgramError("InvalidKind");
    }
    requireSafeTokenAccount(world.accounts.get(playerAta), "player_ata");
    requireSafeTokenAccount(world.accounts.get(keys.vaultAta), "vault_ata");
    requireSafeTokenAccount(world.accounts.get(keys.treasury), "treasury_ata");
    const tier = world.args.tier as number;
    const fee = config.fees[tier];
    if (fee === undefined) throw new ProgramError("InvalidFee");
    const { rake, prize } = splitFeeV2(fee, config.rake_bps);
    const ticketData = accountData(world, ticket);
    Object.assign(ticketData, {
      __type: "EntryTicketV2", mint: config.mint, player, reference, kind, tier,
      amount: fee, rake, prize, paid_at: BigInt(world.clock.unixTimestamp),
      bump: ticketPdaV2(market, reference, player).bump,
    });
    if (rake > 0n) transfer(world, playerAta, keys.treasury, rake, "treasury_ata");
    transfer(world, playerAta, keys.vaultAta, prize, "vault_ata");
    return commitTx(snap);
  } catch (err) {
    // The body failed, so on chain nothing it wrote would survive.
    restore(world, snap);
    return toFailure(err, "handler");
  }
}

function toFailure(err: unknown, field: string): EvalResult {
  if (err instanceof FailureError) return { ok: false, failure: err.failure };
  if (err instanceof ProgramError) {
    return { ok: false, failure: { kind: "constraint-failed", accountField: field, detail: err.code } };
  }
  throw err;
}

export interface PublishPrizesV2Args {
  epoch: bigint;
  root: string;
  total: bigint;
  leafCount: number;
  authority?: Key;
  vault?: Key;
  prizes?: Key;
  extraKeys?: Record<string, Key>;
  signers?: Key[];
}

/** `publish_prizes_v2`. */
export function publishPrizesV2(market: Market, args: PublishPrizesV2Args): EvalResult {
  const { world, keys } = market;
  const struct = getStruct(STRUCTS, "PublishPrizesV2");
  const snap = snapshot(world);
  const authority = args.authority ?? keys.authority;
  const prizesKey = args.prizes ?? prizesPdaV2(market, args.epoch).address;
  world.args.epoch = args.epoch;
  world.args["config.mint"] = keys.mint;
  world.signers = new Set(args.signers ?? [authority]);
  pass(world, struct, {
    authority, config: keys.config, vault_ata: keys.vault, prizes: prizesKey,
  }, args.extraKeys ?? {});
  const result = runTx(struct, world, snap);
  if (!result.ok) return result;
  try {
    const config = accountData(world, keys.config) as { paused: boolean; reserved: bigint; mint: Key };
    if (config.paused) throw new ProgramError("Paused");
    if (args.total <= 0n || args.root === "0".repeat(64) ||
        args.leafCount <= 0 || args.leafCount > C.V2_LEAF_COUNT_MAX) {
      throw new ProgramError("InvalidTotal");
    }
    const vaultBalance = balance(world, keys.vault);
    config.reserved = reservePrizesV2(vaultBalance, config.reserved, args.total);
    Object.assign(accountData(world, prizesKey), {
      __type: "PrizeEpochV2", mint: keys.mint, epoch: args.epoch, root: args.root,
      total: args.total, remaining: args.total, leaf_count: args.leafCount,
      published_at: BigInt(world.clock.unixTimestamp), bump: prizesPdaV2(market, args.epoch).bump,
    });
    return commitTx(snap);
  } catch (err) {
    // The body failed, so on chain nothing it wrote would survive.
    restore(world, snap);
    return toFailure(err, "handler");
  }
}

export interface ClaimPrizeV2Args {
  epoch: bigint;
  amount: bigint;
  leafIndex: number;
  proof: string[];
  player?: Key;
  playerAta?: Key;
  prizes?: Key;
  claim?: Key;
  extraKeys?: Record<string, Key>;
  signers?: Key[];
  skipHandler?: boolean;
}

/** `claim_prize_v2`. */
export function claimPrizeV2(market: Market, args: ClaimPrizeV2Args): EvalResult {
  const { world, keys } = market;
  const struct = getStruct(STRUCTS, "ClaimPrizeV2");
  const snap = snapshot(world);
  const player = args.player ?? keys.player;
  const playerAta = args.playerAta ?? keys.playerAta;
  const prizesKey = args.prizes ?? prizesPdaV2(market, args.epoch).address;
  const claimKey = args.claim ?? claimPdaV2(market, args.epoch, player).address;
  world.args.epoch = args.epoch;
  world.args["config.mint"] = keys.mint;
  world.signers = new Set(args.signers ?? [player]);
  pass(world, struct, {
    player, config: keys.config, player_ata: playerAta, vault_ata: keys.vault,
    prizes: prizesKey, claim: claimKey,
  }, args.extraKeys ?? {});
  const result = runTx(struct, world, snap);
  if (!result.ok || args.skipHandler) return result;
  try {
    const config = accountData(world, keys.config) as { paused: boolean; reserved: bigint; mint: Key };
    const prizes = accountData(world, prizesKey) as { remaining: bigint; root: string; leaf_count: number };
    if (config.paused) throw new ProgramError("Paused");
    if (args.amount <= 0n) throw new ProgramError("ZeroAmount");
    if (args.proof.length > C.MAX_PROOF_LEN) throw new ProgramError("ProofTooLong");
    requireSafeTokenAccount(world.accounts.get(playerAta), "player_ata");
    requireSafeTokenAccount(world.accounts.get(keys.vault), "vault_ata");
    if (args.leafIndex >= prizes.leaf_count) throw new ProgramError("ProofInvalid");
    const depth = proofDepth(prizes.leaf_count);
    if (args.proof.length !== depth) throw new ProgramError("ProofInvalid");
    const leaf = merkleLeafV2(Buffer.from(player, "hex"), args.amount, Buffer.from(keys.mint, "hex"));
    if (!verifyProofV2(leaf, args.leafIndex, args.proof, prizes.root)) throw new ProgramError("ProofInvalid");
    prizes.remaining = checked(prizes.remaining - args.amount, "InvalidTotal");
    config.reserved = checked(config.reserved - args.amount, "InvalidTotal");
    Object.assign(accountData(world, claimKey), {
      __type: "PrizeClaimV2", mint: keys.mint, epoch: args.epoch, player, amount: args.amount,
      claimed_at: BigInt(world.clock.unixTimestamp), bump: claimPdaV2(market, args.epoch, player).bump,
    });
    transfer(world, keys.vault, playerAta, args.amount, "vault_ata");
    world.events.push({ name: "PrizeClaimed", fields: { player, epoch: args.epoch, amount: args.amount } });
    return commitTx(snap);
  } catch (err) {
    // The body failed, so on chain nothing it wrote would survive.
    restore(world, snap);
    return toFailure(err, "handler");
  }
}

export interface RefundEntryV2Args {
  reference: string;
  authority?: Key;
  player?: Key;
  playerAta?: Key;
  ticket?: Key;
  extraKeys?: Record<string, Key>;
  signers?: Key[];
}

/** `refund_entry_v2`, including the `close = player` rent refund. */
export function refundEntryV2(market: Market, args: RefundEntryV2Args): EvalResult {
  const { world, keys } = market;
  const struct = getStruct(STRUCTS, "RefundEntryV2");
  const snap = snapshot(world);
  const authority = args.authority ?? keys.authority;
  const player = args.player ?? keys.player;
  const playerAta = args.playerAta ?? keys.playerAta;
  const ticket = args.ticket ?? ticketPdaV2(market, args.reference, player).address;
  world.args.reference = args.reference;
  world.args["config.mint"] = keys.mint;
  world.signers = new Set(args.signers ?? [authority]);
  pass(world, struct, {
    config: keys.config, authority, player, player_ata: playerAta, vault_ata: keys.vault,
    treasury_ata: keys.treasury, ticket,
  }, args.extraKeys ?? {});
  const result = runTx(struct, world, snap);
  if (!result.ok) return result;
  try {
    requireSafeTokenAccount(world.accounts.get(playerAta), "player_ata");
    requireSafeTokenAccount(world.accounts.get(keys.vault), "vault_ata");
    requireSafeTokenAccount(world.accounts.get(keys.treasury), "treasury_ata");
    const ticketData = accountData(world, ticket) as { amount: bigint; rake: bigint; prize: bigint };
    if (ticketData.rake + ticketData.prize !== ticketData.amount) throw new ProgramError("InvalidAmount");
    if (ticketData.rake > 0n) transfer(world, keys.treasury, playerAta, ticketData.rake, "treasury_ata");
    if (ticketData.prize > 0n) transfer(world, keys.vault, playerAta, ticketData.prize, "vault_ata");
    world.events.push({
      name: "EntryRefundedV2",
      fields: { authority, player, reference: args.reference, amount: ticketData.amount },
    });
    // Anchor closes the ticket only after the body succeeded.
    applyCloses(struct, world);
    return commitTx(snap);
  } catch (err) {
    // The body failed, so on chain nothing it wrote would survive.
    restore(world, snap);
    return toFailure(err, "handler");
  }
}

export interface SweepPrizesV2Args {
  epoch: bigint;
  authority?: Key;
  prizes?: Key;
  extraKeys?: Record<string, Key>;
  signers?: Key[];
}

/** `sweep_expired_prizes_v2`. */
export function sweepExpiredPrizesV2(market: Market, args: SweepPrizesV2Args): EvalResult {
  const { world, keys } = market;
  const struct = getStruct(STRUCTS, "SweepPrizesV2");
  const snap = snapshot(world);
  const authority = args.authority ?? keys.authority;
  const prizesKey = args.prizes ?? prizesPdaV2(market, args.epoch).address;
  world.args.epoch = args.epoch;
  world.args["config.mint"] = keys.mint;
  world.signers = new Set(args.signers ?? [authority]);
  pass(world, struct, {
    authority, config: keys.config, vault_ata: keys.vault, treasury_ata: keys.treasury,
    prizes: prizesKey,
  }, args.extraKeys ?? {});
  const result = runTx(struct, world, snap);
  if (!result.ok) return result;
  try {
    const config = accountData(world, keys.config) as { reserved: bigint; paused: boolean };
    // SW-2026-09-26 F-02: the sweep is pause-gated like every other
    // money-moving instruction.
    if (config.paused) throw new ProgramError("Paused");
    const prizes = accountData(world, prizesKey) as { remaining: bigint; published_at: bigint };
    const now = BigInt(world.clock.unixTimestamp);
    const expiry = prizes.published_at + C.PRIZE_SWEEP_DELAY_SECONDS;
    if (expiry > (1n << 63n) - 1n) throw new ProgramError("Overflow");
    if (now < expiry) throw new ProgramError("PrizeNotExpired");
    const amount = prizes.remaining;
    if (amount <= 0n) throw new ProgramError("NothingToSweep");
    config.reserved = checked(config.reserved - amount, "VaultUnderfunded");
    prizes.remaining = 0n;
    transfer(world, keys.vault, keys.treasury, amount, "treasury_ata");
    world.events.push({ name: "PrizeSwept", fields: { authority, epoch: args.epoch, amount } });
    return commitTx(snap);
  } catch (err) {
    // The body failed, so on chain nothing it wrote would survive.
    restore(world, snap);
    return toFailure(err, "handler");
  }
}

export interface AuthorityChangeV2Args {
  newAuthority: Key;
  newTreasuryAta: Key;
  proposer?: Key;
  pending?: Key;
  extraKeys?: Record<string, Key>;
  signers?: Key[];
}

/** `propose_authority_change_v2`. */
export function proposeAuthorityChangeV2(market: Market, args: AuthorityChangeV2Args): EvalResult {
  const { world, keys } = market;
  const struct = getStruct(STRUCTS, "ProposeAuthorityV2");
  const snap = snapshot(world);
  const proposer = args.proposer ?? keys.authority;
  const pendingKey = args.pending ?? pendingPdaV2(market).address;
  world.args["config.mint"] = keys.mint;
  world.signers = new Set(args.signers ?? [proposer]);
  pass(world, struct, {
    authority: proposer, config: keys.config, pending_authority: pendingKey,
  }, args.extraKeys ?? {});
  const result = runTx(struct, world, snap);
  if (!result.ok) return result;
  if (args.newAuthority === "0".repeat(64)) return toFailure(new ProgramError("InvalidAuthority"), "handler");
  Object.assign(accountData(world, pendingKey), {
    __type: "PendingAuthorityV2", mint: keys.mint, new_authority: args.newAuthority,
    change_slot: BigInt(world.clock.slot), bump: pendingPdaV2(market).bump,
  });
  // SW-2026-09-26 F-03: the handover is observable.
  world.events.push({ name: "AuthorityChangeProposedV2",
    fields: { authority: proposer, pending: args.newAuthority, slot: BigInt(world.clock.slot) } });
  return commitTx(snap);
}

/** `accept_authority_change_v2`, including the slot timelock and the close. */
export function acceptAuthorityChangeV2(market: Market, args: AuthorityChangeV2Args): EvalResult {
  const { world, keys } = market;
  const struct = getStruct(STRUCTS, "AcceptAuthorityV2");
  const snap = snapshot(world);
  const pendingKey = args.pending ?? pendingPdaV2(market).address;
  world.args["config.mint"] = keys.mint;
  world.signers = new Set(args.signers ?? [args.newAuthority]);
  pass(world, struct, {
    config: keys.config, pending_authority: pendingKey, new_authority: args.newAuthority,
    new_treasury_ata: args.newTreasuryAta,
  }, args.extraKeys ?? {});
  const result = runTx(struct, world, snap);
  if (!result.ok) return result;
  const pending = accountData(world, pendingKey) as { change_slot: bigint };
  const deadline = pending.change_slot + C.MIN_AUTHORITY_DELAY_SLOTS;
  if (deadline > U64_MAX) return toFailure(new ProgramError("Overflow"), "handler");
  if (BigInt(world.clock.slot) < deadline) {
    return toFailure(new ProgramError("TimelockNotExpired"), "handler");
  }
  const config = accountData(world, keys.config) as { authority: Key; treasury_ata: Key };
  const oldAuthority = config.authority;
  config.authority = args.newAuthority;
  config.treasury_ata = args.newTreasuryAta;
  applyCloses(struct, world);
  world.events.push({ name: "AuthorityChangedV2",
    fields: { old: oldAuthority, new: config.authority, treasury_ata: config.treasury_ata } });
  return commitTx(snap);
}

/** `initialize_v2`: the market must be bootstrapped by the legacy operator. */
export function initializeV2(market: Market, args: {
  authority?: Key;
  config?: Key;
  legacyConfig?: Key;
  mint?: Key;
  treasury?: Key;
  vault?: Key;
  rakeBps?: number;
  extraKeys?: Record<string, Key>;
  signers?: Key[];
  mintAuthority?: Key | null;
  freezeAuthority?: Key | null;
}): EvalResult {
  const { world, keys } = market;
  const struct = getStruct(STRUCTS, "InitializeV2");
  const snap = snapshot(world);
  const authority = args.authority ?? keys.authority;
  const mint = args.mint ?? keys.mint;
  // `legacy_config` is the v1 config PDA (seeds = [CONFIG_SEED]): the whole point
  // of initialize_v2 is that only the operator who already owns a v1 market can
  // open a v2 one.
  const legacyConfig = args.legacyConfig ?? keys.legacyConfig ?? pda(
    [Buffer.from(SEED_CONSTANTS.get("CONFIG_SEED") ?? "neonrelay_economy_config", "utf8")],
    keys.programId).address;
  const configKey = args.config ?? pda(
    [Buffer.from(SEED_CONSTANTS.get("CONFIG_V2_SEED") ?? "neonrelay_economy_v2", "utf8"),
      Buffer.from(mint, "hex")], keys.programId).address;
  const vault = args.vault ?? ataAddress(configKey, mint);
  const treasury = args.treasury ?? ataAddress(authority, mint);
  world.args.rake_bps = args.rakeBps ?? 1000;
  world.signers = new Set(args.signers ?? [authority]);
  const mintAccount = world.accounts.get(mint);
  if (mintAccount) {
    if (args.mintAuthority !== undefined) mintAccount.mintAuthority = args.mintAuthority;
    if (args.freezeAuthority !== undefined) mintAccount.freezeAuthority = args.freezeAuthority;
  }
  pass(world, struct, {
    authority, legacy_config: legacyConfig, mint, config: configKey, treasury_ata: treasury,
    vault_ata: vault,
  }, args.extraKeys ?? {});
  const result = runTx(struct, world, snap);
  if (!result.ok) return result;
  try {
    const rakeBps = world.args.rake_bps as number;
    if (rakeBps > C.MAX_RAKE_BPS) throw new ProgramError("InvalidRake");
    const mintData = world.accounts.get(mint);
    if (mintData?.mintAuthority !== null && mintData?.mintAuthority !== undefined) {
      throw new ProgramError("MintAuthorityNotRevoked");
    }
    if (mintData?.freezeAuthority !== null && mintData?.freezeAuthority !== undefined) {
      throw new ProgramError("FreezeAuthorityNotRevoked");
    }
    return commitTx(snap);
  } catch (err) {
    // The body failed, so on chain nothing it wrote would survive.
    restore(world, snap);
    return toFailure(err, "handler");
  }
}

/** `set_params_v2` / `set_paused_v2` through the shared `AdminV2` accounts. */
export function adminV2(market: Market, args: {
  authority?: Key;
  config?: Key;
  extraKeys?: Record<string, Key>;
  signers?: Key[];
  rakeBps?: number;
  paused?: boolean;
}): EvalResult {
  const { world, keys } = market;
  const struct = getStruct(STRUCTS, "AdminV2");
  const snap = snapshot(world);
  const authority = args.authority ?? keys.authority;
  world.args["config.mint"] = keys.mint;
  world.signers = new Set(args.signers ?? [authority]);
  pass(world, struct, { authority, config: args.config ?? keys.config }, args.extraKeys ?? {});
  const result = runTx(struct, world, snap);
  if (!result.ok) return result;
  const config = accountData(world, keys.config) as { rake_bps: number; paused: boolean };
  if (args.rakeBps !== undefined) {
    if (args.rakeBps > C.MAX_RAKE_BPS) return toFailure(new ProgramError("InvalidRake"), "handler");
    // SW-2026-09-26 F-01: a rake *increase* is bounded per call; decreases and
    // no-ops pass by construction (saturating_sub on chain).
    const step = args.rakeBps - config.rake_bps;
    if (step > C.MAX_RAKE_STEP_BPS) return toFailure(new ProgramError("RakeStepTooLarge"), "handler");
    const oldRakeBps = config.rake_bps;
    config.rake_bps = args.rakeBps;
    world.events.push({ name: "ParamsChangedV2", fields: { authority, old_rake_bps: oldRakeBps, rake_bps: args.rakeBps } });
  }
  if (args.paused !== undefined) {
    config.paused = args.paused;
    world.events.push({ name: "AdminPausedV2", fields: { authority, paused: args.paused } });
  }
  return commitTx(snap);
}

/** Seed a published epoch into an existing market (helper for claim tests). */
export function seedPublishedEpoch(market: Market, opts: {
  epoch: bigint; leaves: { player: Key; amount: bigint }[]; vaultBalance?: bigint;
  publishedAt?: number; leafCount?: number;
}): { root: string; proofs: string[][]; prizes: Key; total: bigint } {
  const { world, keys } = market;
  const leaves = opts.leaves.map((l) =>
    merkleLeafV2(Buffer.from(l.player, "hex"), l.amount, Buffer.from(keys.mint, "hex")));
  const count = opts.leafCount ?? leaves.length;
  const depth = proofDepth(count);
  const width = 2 ** depth;
  const layer: string[] = [...leaves];
  while (layer.length < width) layer.push("0".repeat(64));
  const layers: string[][] = [layer];
  // Rebind `layer` instead of emptying it in place: `layers` holds references,
  // so mutating the array that was just pushed collapses every level onto the
  // last one and the generated proofs stop verifying against their own root.
  let current = layer;
  while (current.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < current.length; i += 2) {
      next.push(sha256(current[i] as string, current[i + 1] as string).toString("hex"));
    }
    layers.push(next);
    current = next;
  }
  const root = layers[layers.length - 1]?.[0] as string;
  const proofs: string[][] = leaves.map((_, index) => {
    const proof: string[] = [];
    let i = index;
    for (let d = 0; d < layers.length - 1; d++) {
      const sibling = i % 2 === 0 ? i + 1 : i - 1;
      proof.push(layers[d]?.[sibling] ?? "0".repeat(64));
      i = Math.floor(i / 2);
    }
    return proof;
  });
  const total = opts.leaves.reduce((sum, l) => sum + l.amount, 0n);
  const prizesKey = prizesPdaV2(market, opts.epoch).address;
  const vault = world.accounts.get(keys.vault);
  if (vault) vault.amount = opts.vaultBalance ?? total;
  anchorAccount(world, prizesKey, {
    __type: "PrizeEpochV2", mint: keys.mint, epoch: opts.epoch, root, total, remaining: total,
    leaf_count: count, published_at: BigInt(opts.publishedAt ?? world.clock.unixTimestamp),
    bump: prizesPdaV2(market, opts.epoch).bump,
  }, rentExempt(8 + (INIT_SPACE.get("PrizeEpochV2") ?? 101)));
  const config = accountData(world, keys.config) as { reserved: bigint };
  config.reserved += total;
  return { root, proofs, prizes: prizesKey, total };
}
