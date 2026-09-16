import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
	buildTree, leafHash, proofFor, verifyProofIndexed,
} from "../src/merkle.ts";
// Cross-package: the client mirror must stay byte-identical to the backend.
import {
	buildTree as backendBuildTree,
	leafHash as backendLeafHash,
	proofFor as backendProofFor,
	verifyProofIndexed as backendVerifyProofIndexed,
} from "../../backend/src/merkle.ts";

test("golden leaf matches the vector pinned for the Rust unit test", () => {
	// onchain/programs/neonrelay-rewards/tests/golden_leaf.txt — same input.
	assert.equal(
		leafHash(Buffer.alloc(32, 7), 1200),
		"b550dcfd1f99d0dee53d429a289fab9001d7814e6b1209760bf6c28617c06d97");
});

test("client merkle is byte-identical to the backend implementation", () => {
	for (let n = 1; n <= 9; n++) {
		const keys = Array.from({ length: n }, () => randomBytes(32));
		const amounts = Array.from({ length: n }, (_, i) => (i + 1) * 137);
		const leaves = keys.map((k, i) => leafHash(k, amounts[i] as number));
		const backendLeaves = keys.map((k, i) => backendLeafHash(k, amounts[i] as number));
		assert.deepEqual(leaves, backendLeaves);
		const tree = buildTree(leaves);
		const backendTree = backendBuildTree(backendLeaves);
		assert.equal(tree.root, backendTree.root);
		for (let i = 0; i < leaves.length; i++) {
			const proof = proofFor(tree, i);
			assert.deepEqual(proof, backendProofFor(backendTree, i));
			assert.equal(verifyProofIndexed(leaves[i] as string, i, proof, tree.root), true);
			assert.equal(backendVerifyProofIndexed(leaves[i] as string, i, proof, tree.root), true);
		}
	}
});

test("padded 5-leaf tree verifies every index and rejects tampering", () => {
	const keys = Array.from({ length: 5 }, (_, i) => Buffer.alloc(32, i + 1));
	const amounts = [250, 0 + 1, 999, 12345, 7];
	const leaves = keys.map((k, i) => leafHash(k, amounts[i] as number));
	const tree = buildTree(leaves);
	assert.equal(tree.levels[0]!.length, 8); // padded to the next power of two
	for (let i = 0; i < leaves.length; i++) {
		const proof = proofFor(tree, i);
		assert.equal(verifyProofIndexed(leaves[i] as string, i, proof, tree.root), true);
		// tampered amount
		assert.equal(
			verifyProofIndexed(leafHash(keys[i]!, (amounts[i] as number) + 1), i, proof, tree.root),
			false);
		// wrong direction fails wherever the sibling differs from the leaf
		// (padded duplicates are the documented, harmless ambiguity: they fold
		// to the same parent, but the amount+wallet leaf itself still binds)
		const siblingIndex = i ^ 1;
		if (siblingIndex < leaves.length) {
			assert.equal(
				verifyProofIndexed(leaves[i] as string, siblingIndex, proof, tree.root),
				false);
		}
		// outsider leaf never verifies with someone else's proof
		const outsider = leafHash(Buffer.alloc(32, 99), 4242);
		assert.equal(verifyProofIndexed(outsider, i, proof, tree.root), false);
	}
});

test("two-leaf fold direction matches the on-chain rule", () => {
	const l0 = leafHash(Buffer.alloc(32, 7), 1200);
	const l1 = leafHash(Buffer.alloc(32, 8), 400);
	const tree = buildTree([l0, l1]);
	assert.equal(verifyProofIndexed(l0, 0, [l1], tree.root), true);
	assert.equal(verifyProofIndexed(l1, 1, [l0], tree.root), true);
	// swapped direction must fail
	assert.equal(verifyProofIndexed(l0, 1, [l1], tree.root), false);
	assert.equal(verifyProofIndexed(l1, 0, [l0], tree.root), false);
});

test("empty tree has the all-zero root the program rejects at publish time", () => {
	assert.equal(buildTree([]).root, "0".repeat(64));
});
