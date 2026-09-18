/** Offline v2 economy claim verifier. Not wired to the legacy Rust program.
 * Amounts are SPL base units as bigint; mints are raw 32-byte public keys. */
import { createHash } from "node:crypto";
const U64_MAX = (1n << 64n) - 1n;
function u64(value: bigint): bigint {
  if (typeof value !== "bigint" || value < 0n || value > U64_MAX) throw new RangeError("expected u64 bigint");
  return value;
}
function keyHex(value: Buffer): string {
  if (!Buffer.isBuffer(value) || value.length !== 32) throw new Error("expected 32-byte key");
  return value.toString("hex");
}
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
