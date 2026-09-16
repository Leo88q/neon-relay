/**
 * Achievement bitmap helpers for the neonrelay-features program.
 *
 * The program stores earned achievements per player as `[u64; 4]` (256 bits),
 * serialized little-endian by Anchor. word = id / 64, bit = id % 64 — the same
 * arithmetic as `record_achievement` in lib.rs. Clients use this to decode a
 * registry account and to pre-check `mint_achievement_badge` eligibility
 * before paying for a transaction that would fail.
 */
import { ACHIEVEMENT_BITS } from "./constants.ts";

export type Bitmap = bigint[]; // 4 words, u64 each

export function emptyBitmap(): Bitmap {
	return [0n, 0n, 0n, 0n];
}

export function checkId(id: number): void {
	if (!Number.isInteger(id) || id < 0 || id >= ACHIEVEMENT_BITS) {
		throw new Error(`achievement id ${id} out of range (0..${ACHIEVEMENT_BITS - 1})`);
	}
}

export function achievementIsSet(bits: Bitmap, id: number): boolean {
	checkId(id);
	const word = bits[Math.floor(id / 64)] ?? 0n;
	return ((word >> BigInt(id % 64)) & 1n) === 1n;
}

export function withAchievement(bits: Bitmap, id: number): Bitmap {
	checkId(id);
	const next = [...bits] as Bitmap;
	const w = Math.floor(id / 64);
	next[w] = (next[w] ?? 0n) | (1n << BigInt(id % 64));
	return next;
}

export function achievementList(bits: Bitmap): number[] {
	const out: number[] = [];
	for (let id = 0; id < ACHIEVEMENT_BITS; id++) {
		if (achievementIsSet(bits, id)) out.push(id);
	}
	return out;
}

/** Decode the 32-byte account field (Anchor little-endian u64 x4). */
export function bitmapFromBytes(buf: Buffer): Bitmap {
	if (buf.length !== 32) throw new Error("achievement bitmap is 32 bytes");
	return [0, 1, 2, 3].map((i) => buf.readBigUInt64LE(i * 8));
}

/** Encode back to the on-chain representation. */
export function bitmapToBytes(bits: Bitmap): Buffer {
	const buf = Buffer.alloc(32);
	for (let i = 0; i < 4; i++) buf.writeBigUInt64LE(BigInt.asUintN(64, bits[i] ?? 0n), i * 8);
	return buf;
}
