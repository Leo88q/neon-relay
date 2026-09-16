/**
 * Client-side mirror of the epoch Merkle construction, byte-identical to
 * backend/src/merkle.ts and to programs/neonrelay-rewards/src/lib.rs:
 *
 *   leaf   = SHA256(walletPubkeyBytes(32) || u64be(amountMicro))
 *   parent = SHA256(left(32) || right(32))
 *   tree   = complete binary, padded by duplicating the last leaf
 *   proof  = siblings leaf-first, folded with an explicit leaf index
 *            (even index ⇒ current hash on the left)
 *
 * The mobile/CLI client uses this to pre-verify a claim intent received from
 * the backend BEFORE signing a `claim` transaction, and the tests pin the
 * golden vectors shared with the Rust unit test.
 */
import { createHash } from "node:crypto";

export function leafHash(publicKeyRaw: Buffer, amountMicro: number): string {
	if (publicKeyRaw.length !== 32) throw new Error("leaf needs a 32-byte public key");
	if (!Number.isInteger(amountMicro) || amountMicro < 0) {
		throw new Error("leaf amount must be a non-negative integer");
	}
	const amount = Buffer.alloc(8);
	amount.writeBigUInt64BE(BigInt(amountMicro));
	return createHash("sha256").update(Buffer.concat([publicKeyRaw, amount])).digest("hex");
}

function parentHash(left: string, right: string): string {
	return createHash("sha256")
		.update(Buffer.from(left + right, "hex")).digest("hex");
}

export interface MerkleTree {
	root: string;
	levels: string[][]; // levels[0] = leaves (padded)
}

export function buildTree(leaves: string[]): MerkleTree {
	if (leaves.length === 0) {
		return { root: "0".repeat(64), levels: [["0".repeat(64)]] };
	}
	const padded = [...leaves];
	while ((padded.length & (padded.length - 1)) !== 0) {
		padded.push(padded[padded.length - 1] as string);
	}
	const levels: string[][] = [padded];
	let current = padded;
	while (current.length > 1) {
		const next: string[] = [];
		for (let i = 0; i < current.length; i += 2) {
			next.push(parentHash(current[i] as string, current[i + 1] as string));
		}
		levels.push(next);
		current = next;
	}
	return { root: current[0] as string, levels };
}

/** Sibling hashes from leaf to root, ordered leaf-first. */
export function proofFor(tree: MerkleTree, leafIndex: number): string[] {
	const proof: string[] = [];
	let index = leafIndex;
	for (let level = 0; level < tree.levels.length - 1; level++) {
		const row = tree.levels[level] as string[];
		const sibling = index ^ 1;
		proof.push(row[sibling] as string);
		index >>= 1;
	}
	return proof;
}

/** Verification with an explicit leaf index — same rule as the on-chain fold. */
export function verifyProofIndexed(leaf: string, index: number, proof: string[],
	root: string): boolean {
	let current = leaf;
	let i = index;
	for (const sibling of proof) {
		current = (i & 1) === 0 ? parentHash(current, sibling) : parentHash(sibling, current);
		i >>= 1;
	}
	return current === root;
}
