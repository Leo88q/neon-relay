/** V2 economy wire primitives. NOT compatible with the deployed/legacy v1
 * program. Kept separate from rewards/merkle.ts to preserve old claims. */
import { createHash } from "node:crypto";
import { findProgramAddress } from "./economy.ts";

export const U64_MAX = (1n << 64n) - 1n;
export const V2_SEEDS = Object.freeze({
  config: "neonrelay_economy_v2",
  entry: "neonrelay_entry_v2",
  prizes: "neonrelay_prizes_v2",
  claim: "neonrelay_claim_v2",
});

export function u64(value: bigint): bigint {
  if (typeof value !== "bigint" || value < 0n || value > U64_MAX) throw new RangeError("expected u64 bigint");
  return value;
}
export function keyHex(value: Buffer): string {
  if (!Buffer.isBuffer(value) || value.length !== 32) throw new Error("expected 32-byte key");
  return value.toString("hex");
}
function epochLE(epoch: bigint): Buffer {
  const result = Buffer.alloc(8);
  result.writeBigUInt64LE(u64(epoch));
  return result;
}

/** Exactly SHA256(wallet32 || amount_u64be || mint32). */
export function economyLeafV2(wallet: Buffer, amount: bigint, mint: Buffer): string {
  keyHex(wallet); keyHex(mint);
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(u64(amount));
  return createHash("sha256").update(wallet).update(bytes).update(mint).digest("hex");
}

/** Strict indexed proof: cap depth and reject unused high index bits. */
export function verifyEconomyProofV2(leaf: string, index: number, proof: string[], root: string): boolean {
  const hash = (value: unknown) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
  if (!hash(leaf) || !hash(root) || !Array.isArray(proof) || proof.length > 32 ||
      !proof.every(hash) || !Number.isSafeInteger(index) || index < 0 || index > 0xffffffff ||
      index >= 2 ** proof.length) return false;
  let current = leaf;
  for (const sibling of proof) {
    const pair = index % 2 === 0 ? current + sibling : sibling + current;
    current = createHash("sha256").update(Buffer.from(pair, "hex")).digest("hex");
    index = Math.floor(index / 2);
  }
  return current === root;
}

function derive(seed: string, mint: Buffer, extra: Buffer[], program: Buffer) {
  keyHex(mint); keyHex(program);
  return findProgramAddress([Buffer.from(seed), mint, ...extra], program);
}
export function configPdaV2(mint: Buffer, program: Buffer) {
  return derive(V2_SEEDS.config, mint, [], program);
}
export function ticketPdaV2(mint: Buffer, reference: Buffer, wallet: Buffer, program: Buffer) {
  keyHex(reference); keyHex(wallet);
  return derive(V2_SEEDS.entry, mint, [reference, wallet], program);
}
export function prizesPdaV2(mint: Buffer, epoch: bigint, program: Buffer) {
  return derive(V2_SEEDS.prizes, mint, [epochLE(epoch)], program);
}
export function claimPdaV2(mint: Buffer, epoch: bigint, wallet: Buffer, program: Buffer) {
  keyHex(wallet);
  return derive(V2_SEEDS.claim, mint, [epochLE(epoch), wallet], program);
}
