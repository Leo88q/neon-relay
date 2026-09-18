import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { economyLeafV2, verifyEconomyProofV2 } from "../src/economy_v2.ts";

const vectors = JSON.parse(readFileSync(new URL("./fixtures/economy_v2.json", import.meta.url), "utf8"));

test("v2 client leaf matches independent SHA256 wallet/amount/mint golden vectors", () => {
  for (const vector of vectors) {
    assert.equal(economyLeafV2(Buffer.from(vector.wallet, "hex"), BigInt(vector.amountBase), Buffer.from(vector.mint, "hex")), vector.leaf);
  }
  assert.notEqual(vectors[0].leaf, vectors[1].leaf);
  assert.throws(() => economyLeafV2(Buffer.alloc(32), 1n << 64n, Buffer.alloc(32)));
  assert.throws(() => economyLeafV2(Buffer.alloc(31), 1n, Buffer.alloc(32)));
});

test("v2 client rejects cross-mint claims and high-bit index aliases", () => {
  const leaf = vectors[0].leaf, sibling = "a".repeat(64);
  const root = createHash("sha256").update(Buffer.from(leaf + sibling, "hex")).digest("hex");
  assert.equal(verifyEconomyProofV2(leaf, 0, [sibling], root), true);
  assert.equal(verifyEconomyProofV2(vectors[1].leaf, 0, [sibling], root), false);
  assert.equal(verifyEconomyProofV2(leaf, 2, [sibling], root), false);
  assert.equal(verifyEconomyProofV2(leaf, -1, [sibling], root), false);
  assert.equal(verifyEconomyProofV2(leaf, 0, ["invalid"], root), false);
  assert.equal(verifyEconomyProofV2(leaf, 0, Array(33).fill(sibling), root), false);
});

test("v2 client verifies depth-32 proof at maximum u32 index without signed shifts", () => {
  const leaf = vectors[0].leaf, proof = Array(32).fill("b".repeat(64));
  let root = leaf;
  for (const sibling of proof) root = createHash("sha256").update(Buffer.from(sibling + root, "hex")).digest("hex");
  assert.equal(verifyEconomyProofV2(leaf, 0xffffffff, proof, root), true);
  assert.equal(verifyEconomyProofV2(leaf, 0x100000000, proof, root), false);
});
