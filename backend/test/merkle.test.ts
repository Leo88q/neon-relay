import test from "node:test";
import assert from "node:assert/strict";
import { buildTree, leafHash, proofFor, verifyProofIndexed } from "../src/merkle.ts";

test("leaf hash binds key and amount", () => {
  const key = Buffer.alloc(32, 7);
  const a = leafHash(key, 100);
  assert.equal(a, leafHash(key, 100));
  assert.notEqual(a, leafHash(key, 101));
  assert.notEqual(a, leafHash(Buffer.alloc(32, 8), 100));
  assert.throws(() => leafHash(Buffer.alloc(31), 1));
  assert.throws(() => leafHash(key, -1));
});

test("proofs verify for every index in a padded tree", () => {
  const leaves = Array.from({ length: 5 }, (_, i) => leafHash(Buffer.alloc(32, i), i * 10));
  const tree = buildTree(leaves);
  const outsider = leafHash(Buffer.alloc(32, 99), 999);
  for (let i = 0; i < leaves.length; i++) {
    const proof = proofFor(tree, i);
    assert.equal(verifyProofIndexed(leaves[i] as string, i, proof, tree.root), true);
    // a different leaf never fits someone else's proof
    assert.equal(verifyProofIndexed(outsider, i, proof, tree.root), false);
  }
});

test("tampered leaf or root breaks verification", () => {
  const leaves = [leafHash(Buffer.alloc(32, 1), 1), leafHash(Buffer.alloc(32, 2), 2)];
  const tree = buildTree(leaves);
  const proof = proofFor(tree, 0);
  assert.equal(verifyProofIndexed("0".repeat(64), 0, proof, tree.root), false);
  assert.equal(verifyProofIndexed(leaves[0] as string, 0, proof, "0".repeat(64)), false);
});

test("empty epoch yields the zero root", () => {
  assert.equal(buildTree([]).root, "0".repeat(64));
});
