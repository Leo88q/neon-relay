/** Strict, read-only validation of the v2 Anchor/SPL account ABI.
 * No transaction is constructed or signed. An RPC response remains trusted
 * infrastructure data, not a cryptographic light-client proof. */
import { createHash } from "node:crypto";
import { base58Decode, base58Encode, findProgramAddress, type RpcCaller } from "./economy.ts";
import { configPdaV2, ticketPdaV2, keyHex, u64 } from "./economy_v2_codec.ts";

export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ATA_PROGRAM = base58Decode("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const V2_ACCOUNT_BYTES = Object.freeze({ config: 180, ticket: 139, mint: 82, token: 165 });
export class V2AccountError extends Error {
  constructor(code: string) { super(code); this.name = "V2AccountError"; }
}
function check(ok: unknown, code: string): asserts ok {
  if (!ok) throw new V2AccountError(code);
}
function record(value: unknown): Record<string, unknown> {
  check(value !== null && typeof value === "object" && !Array.isArray(value), "invalid-rpc-object");
  return value as Record<string, unknown>;
}
function contextSlot(result: Record<string, unknown>): number {
  const slot = record(result.context).slot;
  check(typeof slot === "number" && Number.isSafeInteger(slot) && slot >= 0, "invalid-rpc-slot");
  return slot;
}
export function anchorDiscriminator(name: string): Buffer {
  return createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
}
function accountBytes(value: unknown, owner: string, size: number): Buffer {
  check(value !== null, "account-missing");
  const account = record(value);
  check(account.owner === owner && account.executable === false, "wrong-account-owner");
  const data = account.data;
  check(Array.isArray(data) && data.length === 2 && data[1] === "base64" && typeof data[0] === "string", "wrong-account-encoding");
  check(data[0].length === Math.ceil(size / 3) * 4, "wrong-account-size");
  const bytes = Buffer.from(data[0], "base64");
  check(bytes.length === size && bytes.toString("base64") === data[0], "noncanonical-account-data");
  return bytes;
}
function anchorBytes(value: unknown, owner: string, size: number, name: string): Buffer {
  const bytes = accountBytes(value, owner, size);
  check(bytes.subarray(0, 8).equals(anchorDiscriminator(name)), "wrong-discriminator");
  return bytes;
}
export function vaultAddressV2(config: Buffer, mint: Buffer): Buffer {
  keyHex(config); keyHex(mint);
  return findProgramAddress([config, base58Decode(TOKEN_PROGRAM), mint], ATA_PROGRAM).address;
}
function readConfig(account: unknown, program: Buffer, mint: Buffer) {
  const pda = configPdaV2(mint, program);
  const bytes = anchorBytes(account, base58Encode(program), V2_ACCOUNT_BYTES.config, "EconomyConfigV2");
  check(bytes.subarray(40, 72).equals(mint), "wrong-config-mint");
  check(bytes[179] === pda.bump, "wrong-config-bump");
  check(bytes[178] === 0 || bytes[178] === 1, "invalid-pause-flag");
  const authority = bytes.subarray(8, 40), treasury = bytes.subarray(72, 104), vault = bytes.subarray(104, 136);
  check(!authority.equals(Buffer.alloc(32)), "zero-authority");
  check(vault.equals(vaultAddressV2(pda.address, mint)), "wrong-vault-address");
  check(!treasury.equals(vault), "aliased-treasury");
  const rakeBps = bytes.readUInt16LE(168);
  check(rakeBps <= 2000, "invalid-rake");
  return { address: pda.address, authority, treasury, vault, rakeBps,
    fees: [136, 144, 152, 160].map((offset) => bytes.readBigUInt64LE(offset)),
    reserved: bytes.readBigUInt64LE(170), paused: bytes[178] === 1 };
}
function readMint(account: unknown): number {
  // Verified market path is classic SPL only. Token-2022 is deliberately not
  // accepted until transfer/delegate/fee semantics are implemented and tested
  // end-to-end.
  const raw = accountBytes(account, TOKEN_PROGRAM, V2_ACCOUNT_BYTES.mint);
  check(raw[45] === 1, "mint-uninitialized");
  check(raw.readUInt32LE(0) === 0 && raw.readUInt32LE(46) === 0, "invalid-mint-options");
  const decimals = raw[44]!;
  check(decimals <= 15, "unsupported-mint-decimals");
  return decimals;
}
function readToken(account: unknown, mint: Buffer, owner: Buffer): bigint {
  const bytes = accountBytes(account, TOKEN_PROGRAM, V2_ACCOUNT_BYTES.token);
  check(bytes.subarray(0, 32).equals(mint), "wrong-token-mint");
  check(bytes.subarray(32, 64).equals(owner), "wrong-token-authority");
  check(bytes[108] === 1, "token-not-active"); // rejects frozen/uninitialized
  check(bytes.readUInt32LE(72) === 0 && bytes.readUInt32LE(109) === 0 && bytes.readUInt32LE(129) === 0,
    "unsupported-token-delegate-native-or-close-authority");
  return bytes.readBigUInt64LE(64);
}
export interface ExpectedTicketV2 {
  wallet: Buffer; reference: Buffer; kind: 0 | 1; tier: number; amountBase: bigint;
}

/** Two-step discovery, then a coherent finalized getMultipleAccounts snapshot.
 * Config is reread alongside mint/vault/treasury/ticket, at or after discovery. */
export interface MarketReadOptions {
  /** Separate server-side gate; callers never infer enablement from mint presence. */
  allowPayments?: boolean;
}

async function readSnapshot(
  rpc: RpcCaller, program: Buffer, mint: Buffer,
  expected?: ExpectedTicketV2, options: MarketReadOptions = {},
) {
  keyHex(program); keyHex(mint);
  check(!program.equals(Buffer.alloc(32)) && !mint.equals(Buffer.alloc(32)), "zero-program-or-mint");
  if (expected) {
    keyHex(expected.wallet); keyHex(expected.reference); u64(expected.amountBase);
    check((expected.kind === 0 || expected.kind === 1) && Number.isInteger(expected.tier) && expected.tier >= 0 && expected.tier < 4,
      "invalid-ticket-expectation");
  }
  const configAddress = configPdaV2(mint, program).address;
  const initial = record(await rpc("getAccountInfo", [base58Encode(configAddress), { encoding: "base64", commitment: "finalized" }]));
  const initialSlot = contextSlot(initial);
  const discovered = readConfig(initial.value, program, mint);
  const ticket = expected ? ticketPdaV2(mint, expected.reference, expected.wallet, program) : null;
  const addresses = [mint, configAddress, discovered.vault, discovered.treasury];
  if (ticket) addresses.push(ticket.address);
  const snapshot = record(await rpc("getMultipleAccounts", [addresses.map(base58Encode),
    { encoding: "base64", commitment: "finalized", minContextSlot: initialSlot }]));
  const slot = contextSlot(snapshot);
  check(slot >= initialSlot, "stale-rpc-snapshot");
  check(Array.isArray(snapshot.value) && snapshot.value.length === addresses.length, "wrong-rpc-account-count");
  const values = snapshot.value;
  const config = readConfig(values[1], program, mint);
  check(config.vault.equals(discovered.vault) && config.treasury.equals(discovered.treasury) && config.authority.equals(discovered.authority),
    "market-identity-changed");
  const decimals = readMint(values[0]);
  const fees = [50n, 100n, 500n, 2000n].map((n) => n * 10n ** BigInt(decimals));
  check(config.fees.every((n, i) => n === fees[i]), "wrong-tier-fees");
  const balance = readToken(values[2], mint, configAddress);
  readToken(values[3], mint, config.authority);
  check(config.reserved <= balance, "vault-underfunded");
  const market = { version: 2, mint: base58Encode(mint), programId: base58Encode(program),
    config: base58Encode(configAddress), vault: base58Encode(config.vault), treasury: base58Encode(config.treasury),
    authority: base58Encode(config.authority), slot, decimals, rakeBps: config.rakeBps, paused: config.paused,
    feesBase: fees.map(String), balanceBase: balance.toString(), reservedBase: config.reserved.toString(),
    availableBase: (balance - config.reserved).toString(),
    paymentsEnabled: options.allowPayments === true && !config.paused };
  if (!expected || !ticket) return { market, ticket: null };
  check(expected.amountBase === fees[expected.tier], "intent-fee-mismatch");
  if (values[4] === null) return { market, ticket: { ticketed: false } };
  const bytes = anchorBytes(values[4], base58Encode(program), V2_ACCOUNT_BYTES.ticket, "EntryTicketV2");
  check(bytes.subarray(8, 40).equals(mint) && bytes.subarray(40, 72).equals(expected.wallet) &&
    bytes.subarray(72, 104).equals(expected.reference), "ticket-identity-mismatch");
  check(bytes[104] === expected.kind && bytes[105] === expected.tier, "ticket-kind-or-tier-mismatch");
  const amount = bytes.readBigUInt64LE(106);
  check(amount === expected.amountBase, "ticket-amount-mismatch");
  const rake = bytes.readBigUInt64LE(114), prize = bytes.readBigUInt64LE(122);
  check(rake + prize === amount, "ticket-split-mismatch");
  check(bytes[138] === ticket.bump, "wrong-ticket-bump");
  const paidAt = bytes.readBigInt64LE(130);
  check(paidAt >= 0n, "invalid-ticket-time");
  return { market, ticket: { ticketed: true, address: base58Encode(ticket.address), amountBase: expected.amountBase.toString(), paidAt: paidAt.toString() } };
}
export async function readMarketV2(
  rpc: RpcCaller, program: Buffer, mint: Buffer, options: MarketReadOptions = {},
) {
  return (await readSnapshot(rpc, program, mint, undefined, options)).market;
}
export async function readTicketV2(rpc: RpcCaller, program: Buffer, mint: Buffer, expected: ExpectedTicketV2) {
  return readSnapshot(rpc, program, mint, expected);
}
