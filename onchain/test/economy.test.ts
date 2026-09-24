/**
 * Stage-14 economy-program tests: prize-table arithmetic (runtime) and static
 * conformance of programs/neonrelay-economy/src/lib.rs against the TS
 * constants and the money-safety policy — same approach as the other suites,
 * because cargo/anchor cannot run in the sandbox (BL-03).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
	DEFAULT_RAKE_BPS, ECONOMY_PROGRAM_ID_PLACEHOLDER, ECONOMY_SEEDS, ENTRY_KIND,
	MAX_PROOF_LEN, MAX_RAKE_BPS, PRIZE_TABLE_BPS,
} from "../src/constants.ts";
import { buildTree, leafHash, proofFor, verifyProofIndexed } from "../src/merkle.ts";

const here = dirname(fileURLToPath(import.meta.url));
const libRs = readFileSync(join(here, "../programs/neonrelay-economy/src/lib.rs"), "utf8");
const cargoToml = readFileSync(join(here, "../programs/neonrelay-economy/Cargo.toml"), "utf8");
const anchorToml = readFileSync(join(here, "../Anchor.toml"), "utf8");

test("prize table sums to 100% and rake defaults stay under the cap", () => {
	assert.equal(PRIZE_TABLE_BPS.length, 10);
	assert.equal(PRIZE_TABLE_BPS.reduce((a, b) => a + b, 0), 10_000);
	assert.ok(DEFAULT_RAKE_BPS <= MAX_RAKE_BPS);
	assert.equal(DEFAULT_RAKE_BPS, 1000); // approved operator rake: 10%
	assert.deepEqual(Object.values(ENTRY_KIND), [0, 1]);
});

test("top-10 prize leaves build a tree the program's fold rule verifies", () => {
	const wallets = Array.from({ length: 10 }, (_, i) => Buffer.alloc(32, i + 1));
	const amounts = PRIZE_TABLE_BPS.map((bps) => bps * 1_000); // 1 SKR-unit per bps
	const leaves = wallets.map((w, i) => leafHash(w, amounts[i]));
	const tree = buildTree(leaves);
	for (let i = 0; i < 10; i++) {
		const proof = proofFor(tree, i);
		assert.ok(proof.length <= MAX_PROOF_LEN);
		assert.equal(verifyProofIndexed(leaves[i], i, proof, tree.root), true);
		// tamper: wrong amount or wrong index must fail
		assert.equal(verifyProofIndexed(leafHash(wallets[i], amounts[i] + 1), i, proof, tree.root), false);
		assert.equal(verifyProofIndexed(leaves[i], i + 1, proof, tree.root), false);
	}
});

test("economy PDA seeds in lib.rs match the TS constants", () => {
	assert.match(libRs, new RegExp(`CONFIG_SEED: &\\[u8\\] = b"${ECONOMY_SEEDS.config}"`));
	assert.match(libRs, new RegExp(`ENTRY_SEED: &\\[u8\\] = b"${ECONOMY_SEEDS.entry}"`));
	assert.match(libRs, new RegExp(`PRIZES_SEED: &\\[u8\\] = b"${ECONOMY_SEEDS.prizes}"`));
	assert.match(libRs, new RegExp(`CLAIM_SEED: &\\[u8\\] = b"${ECONOMY_SEEDS.claim}"`));
});

test("economy program id placeholder is wired in Anchor.toml and constants", () => {
	assert.match(anchorToml, new RegExp(`neonrelay_economy = "${ECONOMY_PROGRAM_ID_PLACEHOLDER}"`));
	assert.match(libRs, new RegExp(`declare_id!\\("${ECONOMY_PROGRAM_ID_PLACEHOLDER}"\\)`));
});

test("money safety: no init_if_needed, pause gate, double-claim and proof caps", () => {
	assert.equal(libRs.includes("init_if_needed"), false);
	assert.match(libRs, /require!\(!config\.paused, EconomyError::Paused\)/);
	// claim PDA is `init` on (epoch, player) seeds: a second claim cannot recreate it
	assert.match(libRs, /seeds = \[CLAIM_SEED, epoch\.to_le_bytes\(\)\.as_ref\(\), player\.key\(\)\.as_ref\(\)\]/);
	assert.match(libRs, new RegExp(`MAX_PROOF_LEN: usize = ${MAX_PROOF_LEN}`));
	assert.match(libRs, /require!\(proof\.len\(\) <= MAX_PROOF_LEN, EconomyError::ProofTooLong\)/);
	// prize publication is one-way and vault-covered
	assert.match(libRs, /ctx\.accounts\.vault_ata\.amount >= total/);
	assert.match(libRs, /account\.state == anchor_spl::token::spl_token::state::AccountState::Initialized/);
	assert.equal(libRs.includes("pub fn update_prizes"), false);
});

test("no hardcoded payment mint: SKR arrives only via initialize()", () => {
	// no base58 pubkey literals except the program's own declare_id
	const ids = libRs.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g) ?? [];
	assert.deepEqual(ids.filter((x) => x !== ECONOMY_PROGRAM_ID_PLACEHOLDER), []);
	assert.match(libRs, /pub mint: Box<Account<'info, Mint>>/);
	assert.match(libRs, /constraint = treasury_ata\.mint == mint\.key\(\)/);
	// checked arithmetic on the rake split
	assert.match(libRs, /checked_mul\(u64::from\(config\.rake_bps\)\)/);
	assert.match(libRs, /checked_div\(RAKE_DENOM\)/);
	assert.match(libRs, new RegExp(`MAX_RAKE_BPS: u16 = ${MAX_RAKE_BPS}`));
});

test("economy crate pins the same Anchor version as the other programs", () => {
  assert.match(cargoToml, /anchor-lang = "0\.31\.1"/);
  assert.match(cargoToml, /anchor-spl = "0\.31\.1"/);
});

test("Tranche A: v1 prizes bind leaf_count and v1 claims enforce exact depth", () => {
	// Scope to the v1 instruction block: v2 already had these guards, so a
	// whole-file match would pass without the v1 fix.
	const v1 = libRs.slice(libRs.indexOf("pub fn publish_prizes("), libRs.indexOf("pub fn initialize_v2("));
	assert.ok(v1.length > 1000, "v1 block must be found");
	assert.match(v1, /total: u64,\n\t\tleaf_count: u32,/);
	assert.match(v1, /require!\(leaf_count > 0 && leaf_count <= 10, EconomyError::InvalidLeafCount\)/);
	assert.match(v1, /prizes\.leaf_count = leaf_count;/);
	assert.match(v1, /require!\(proof\.len\(\) == depth, EconomyError::ProofInvalid\)/);
	assert.match(v1, /require!\(leaf_index < ctx\.accounts\.prizes\.leaf_count, EconomyError::ProofInvalid\)/);
	// both prize account types now carry the count
	assert.equal((libRs.match(/pub leaf_count: u32,/g) ?? []).length, 2);
});
