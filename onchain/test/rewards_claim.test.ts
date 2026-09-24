/**
 * Static contract tests for the rewards `claim` instruction — the spec the
 * mobile claim builder (android/.../wallet/RewardsTxBuilder.kt) implements.
 *
 * The sandbox cannot run cargo/anchor (BL-03), so these tests pin the client
 * contract against programs/neonrelay-rewards/src/lib.rs by parsing it:
 * account/argument order, PDA seeds (epoch id is big-endian), account
 * layouts and sizes, discriminators, and the exact-depth proof rule. The
 * golden hex vectors below are shared with RewardsTxBuilderTest.kt: two
 * independent implementations, one truth.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
	CLAIM_ACCOUNTS, CLAIM_ARGS, CLAIM_IX_DISCRIMINATOR, MAX_PROOF_LEN,
	REWARDS_CONFIG_DISCRIMINATOR, REWARDS_CONFIG_SIZE,
	REWARDS_EPOCH_STATE_DISCRIMINATOR, REWARDS_EPOCH_STATE_SIZE, SEEDS,
} from "../src/constants.ts";
import { buildTree, leafHash, proofFor } from "../src/merkle.ts";

const here = dirname(fileURLToPath(import.meta.url));
const libRs = readFileSync(join(here, "../programs/neonrelay-rewards/src/lib.rs"), "utf8");

const sha256hex = (text: string): string =>
	createHash("sha256").update(text, "utf8").digest("hex");

test("claim discriminators match sha256(global/account) pins", () => {
	assert.equal(sha256hex("global:claim").slice(0, 16), CLAIM_IX_DISCRIMINATOR);
	assert.equal(sha256hex("account:Config").slice(0, 16), REWARDS_CONFIG_DISCRIMINATOR);
	assert.equal(sha256hex("account:EpochState").slice(0, 16), REWARDS_EPOCH_STATE_DISCRIMINATOR);
});

test("claim argument order and types match lib.rs", () => {
	const fn = /pub fn claim\(\s*ctx: Context<Claim>,\s*([\s\S]*?)\) -> Result<\(\)>/.exec(libRs);
	assert.ok(fn, "claim handler not found");
	const args = [...fn[1].matchAll(/(\w+):\s*([\w<>\[; \]]+?),/g)]
		.map((m) => [m[1].trim(), m[2].trim().replace(/\s+/g, "")] as const);
	const want = CLAIM_ARGS.map(([name, type]) => [name, type.replace(/\s+/g, "")] as const);
	assert.deepEqual(args, want);
});

test("Claim account order matches lib.rs", () => {
	const body = /pub struct Claim<'info> \{([\s\S]*?)\n\}/.exec(libRs);
	assert.ok(body, "Claim struct not found");
	const fields = [...body[1].matchAll(/pub (\w+):/g)].map((m) => m[1]);
	assert.deepEqual(fields, [...CLAIM_ACCOUNTS]);
});

test("Claim constraints: init/payer, signer, mut, token bindings, BE seeds", () => {
	// Claim record is created (init) by the player; existence rejects replays.
	assert.match(libRs, /pub claim: Account<'info, ClaimRecord>/);
	assert.match(libRs, /seeds = \[CLAIM_SEED, &epoch_id\.to_be_bytes\(\), player\.key\(\)\.as_ref\(\)\]/);
	// Epoch PDA binds the big-endian epoch id (NOT little-endian).
	assert.match(libRs, /seeds = \[EPOCH_SEED, &epoch_id\.to_be_bytes\(\)\]/);
	// Player signs and pays; both token legs are writable with strict bindings.
	assert.match(libRs, /pub player: Signer<'info>/);
	assert.match(libRs, /account\.state == anchor_spl::token::spl_token::state::AccountState::Initialized/);
	assert.match(libRs, /token::mint = mint,\s*token::authority = player,/);
	assert.match(libRs, /seeds = \[VAULT_SEED\][\s\S]{0,120}?token::authority = config,/);
	// Config and mint must match; program is mint-agnostic otherwise.
	assert.match(libRs, /has_one = mint @ NeonRelayError::MintMismatch/);
});

test("account sizes derive from the struct layouts", () => {
	const fieldSize = (type: string): number => {
		if (type === "Pubkey") return 32;
		if (type === "u64" || type === "i64") return 64 / 8;
		if (type === "u32") return 4;
		if (type === "u8" || type === "bool") return 1;
		const arr = /\[u8; (\d+)\]/.exec(type);
		if (arr) return Number(arr[1]);
		throw new Error(`unexpected account field type: ${type}`);
	};
	const structSize = (name: string): number => {
		const body = new RegExp(`pub struct ${name} \\{([\\s\\S]*?)\\n\\}`).exec(libRs);
		assert.ok(body, `${name} struct not found`);
		const fields = [...body[1].matchAll(/pub \w+: ([\w;\[ \]]+)/g)].map((m) => m[1].trim());
		assert.ok(fields.length > 0, `${name} has no fields`);
		return 8 + fields.reduce((sum, type) => sum + fieldSize(type), 0);
	};
	assert.equal(structSize("Config"), REWARDS_CONFIG_SIZE);
	assert.equal(structSize("EpochState"), REWARDS_EPOCH_STATE_SIZE);
	// Config layout the client parses: authority, mint, paused, epoch_count, ...
	const config = /pub struct Config \{([\s\S]*?)\n\}/.exec(libRs)![1];
	const order = [...config.matchAll(/pub (\w+):/g)].map((m) => m[1]);
	assert.deepEqual(order.slice(0, 4), ["authority", "mint", "paused", "epoch_count"]);
	const epoch = /pub struct EpochState \{([\s\S]*?)\n\}/.exec(libRs)![1];
	assert.deepEqual([...epoch.matchAll(/pub (\w+):/g)].map((m) => m[1]),
		["id", "root", "published_at", "bump", "leaf_count", "total_micro", "remaining_micro"]);
});

test("proof rules: max length and exact depth bound at publish", () => {
	assert.match(libRs, new RegExp(`pub const MAX_PROOF_LEN: usize = ${MAX_PROOF_LEN};`));
	assert.match(libRs, /require!\(proof\.len\(\) <= MAX_PROOF_LEN, NeonRelayError::ProofTooLong\)/);
	// Tranche A: the proof must match the padded-tree depth exactly, and the
	// leaf index must be in range — the client mirrors both before signing.
	assert.match(libRs, /fn proof_depth\(leaf_count: u32\) -> Result<usize>/);
	assert.match(libRs, /checked_next_power_of_two\(\)/);
	assert.match(libRs, /let depth = proof_depth\(ctx\.accounts\.epoch\.leaf_count\)\?;/);
	assert.match(libRs, /require!\(proof\.len\(\) == depth, NeonRelayError::ProofInvalid\)/);
	assert.match(libRs, /require!\(leaf_index < .*?\.leaf_count, NeonRelayError::ProofInvalid\)/);
	// Epoch PDA seeds mirror the TS constants (already covered for programs
	// in program.test.ts; the claim builder additionally needs BE order).
	assert.match(libRs, new RegExp(`EPOCH_SEED: &\\[u8\\] = b"${SEEDS.epoch}"`));
	assert.match(libRs, new RegExp(`CLAIM_SEED: &\\[u8\\] = b"${SEEDS.claim}"`));
});

test("golden claim instruction data (shared with RewardsTxBuilderTest.kt)", () => {
	// claim(epoch=7, amount=100, leaf_index=0, proof=[0x0b * 32])
	const u64le = (n: number): Buffer => {
		const b = Buffer.alloc(8);
		b.writeBigUInt64LE(BigInt(n));
		return b;
	};
	const u32le = (n: number): Buffer => {
		const b = Buffer.alloc(4);
		b.writeUInt32LE(n);
		return b;
	};
	const data = Buffer.concat([
		Buffer.from(CLAIM_IX_DISCRIMINATOR, "hex"),
		u64le(7), u64le(100), u32le(0), u32le(1), Buffer.alloc(32, 11),
	]);
	assert.equal(data.toString("hex"),
		"3ec6d6c1d59f6cd2070000000000000064000000000000000000000001000000" +
		"0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b");
});

test("golden indexed-fold vector (shared with RewardsTxBuilderTest.kt)", () => {
	// Three fixed leaves: wallet 0x01/100, 0x02/250, 0x03/400; prove index 1.
	const leaves = [1, 2, 3].map((b, i) =>
		leafHash(Buffer.alloc(32, b), [100, 250, 400][i] as number));
	const tree = buildTree(leaves);
	const proof = proofFor(tree, 1);
	assert.equal(leaves[1], "800c616f2fc929365fc4c4a1bda013523d9d691c4e5fd8bf41fb71ef2071966a");
	assert.deepEqual(proof, [
		"8d4ae284eb918c4af0acc58867b8ece221a13f63b2e76e3031ee4d576e18ac6e",
		"67c0382c46a2d79724ca3b7604b739279b6026d9fcd3cdbb72fa71d6fb90369d",
	]);
	assert.equal(tree.root, "beabab895b91754cc53b68c5e9de7e4f59fd787f8cd72a43cde36dc211457493");
	// Independent indexed fold (the program's rule): even index ⇒ left.
	let current = Buffer.from(leaves[1] as string, "hex");
	let index = 1;
	for (const siblingHex of proof) {
		const sibling = Buffer.from(siblingHex, "hex");
		current = index % 2 === 0
			? createHash("sha256").update(Buffer.concat([current, sibling])).digest()
			: createHash("sha256").update(Buffer.concat([sibling, current])).digest();
		index >>= 1;
	}
	assert.equal(current.toString("hex"), tree.root);
});
