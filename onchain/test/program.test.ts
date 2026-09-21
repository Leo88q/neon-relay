/**
 * Static conformance tests for the Anchor program source.
 *
 * The sandbox cannot run cargo/anchor (docs/KNOWN_LIMITATIONS.md BL-03), so
 * these tests pin the contract between programs/neonrelay-rewards/src/lib.rs,
 * Anchor.toml and the TS client constants: PDA seeds, the leaf/proof
 * construction, caps, the placeholder program id, and the "no hardcoded mint,
 * no SKR token" policy. They catch drift on every `npm test` run and will be
 * complemented by `cargo test` + `anchor test` on a connected machine.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
	EXPECTED_DECIMALS, MAX_PROOF_LEN, PROGRAM_ID_PLACEHOLDER, SEEDS,
} from "../src/constants.ts";

const here = dirname(fileURLToPath(import.meta.url));
const libRs = readFileSync(join(here, "../programs/neonrelay-rewards/src/lib.rs"), "utf8");
const anchorToml = readFileSync(join(here, "../Anchor.toml"), "utf8");
const goldenLeaf = readFileSync(
	join(here, "../programs/neonrelay-rewards/tests/golden_leaf.txt"), "utf8").trim();

test("PDA seeds in lib.rs match the TS client constants", () => {
	assert.match(libRs, new RegExp(`CONFIG_SEED: &\\[u8\\] = b"${SEEDS.config}"`));
	assert.match(libRs, new RegExp(`EPOCH_SEED: &\\[u8\\] = b"${SEEDS.epoch}"`));
	assert.match(libRs, new RegExp(`CLAIM_SEED: &\\[u8\\] = b"${SEEDS.claim}"`));
	assert.match(libRs, new RegExp(`VAULT_SEED: &\\[u8\\] = b"${SEEDS.vault}"`));
});

test("leaf and proof construction match the backend/TS mirror", () => {
	// leaf = SHA256(wallet || amount_micro.to_be_bytes())
	assert.match(libRs, /hashv\(&\[wallet, &amount_micro\.to_be_bytes\(\)\]\)/);
	// indexed fold: even index ⇒ current on the left; index shifts right
	assert.match(libRs, /if index & 1 == 0 \{/);
	assert.match(libRs, /hashv\(&\[&current, sibling\]\)/);
	assert.match(libRs, /hashv\(&\[sibling, &current\]\)/);
	assert.match(libRs, /index >>= 1;/);
});

test("golden leaf file matches the TS computation", async () => {
	const { leafHash } = await import("../src/merkle.ts");
	assert.equal(leafHash(Buffer.alloc(32, 7), 1200), goldenLeaf);
});

test("caps and decimals agree between program and client", () => {
	assert.match(libRs, new RegExp(`MAX_PROOF_LEN: usize = ${MAX_PROOF_LEN}`));
	assert.match(libRs, new RegExp(`EXPECTED_DECIMALS: u8 = ${EXPECTED_DECIMALS}`));
	assert.match(libRs, /require!\(proof\.len\(\) <= MAX_PROOF_LEN/);
	assert.match(libRs, /ctx\.accounts\.mint\.decimals == EXPECTED_DECIMALS/);
});

test("placeholder program id is consistent across Anchor.toml, lib.rs and TS", () => {
	assert.match(libRs, new RegExp(`declare_id!\\("${PROGRAM_ID_PLACEHOLDER}"\\)`));
	assert.match(anchorToml, new RegExp(`neonrelay_rewards = "${PROGRAM_ID_PLACEHOLDER}"`));
});

test("no-double-claim and pause guards are present", () => {
	// claim record PDA keyed by (epoch, wallet), created with init ⇒ second
	// claim for the same pair fails
	assert.match(libRs,
		/seeds = \[CLAIM_SEED, &epoch_id\.to_be_bytes\(\), player\.key\(\)\.as_ref\(\)\]/);
	// epoch root publication is one-way (init fails if the PDA exists)
	assert.match(libRs, /seeds = \[EPOCH_SEED, &epoch_id\.to_be_bytes\(\)\]/);
	assert.match(libRs, /require!\(!config\.paused, NeonRelayError::Paused\)/);
	assert.match(libRs, /require!\(root != \[0u8; 32\], NeonRelayError::EmptyRoot\)/);
	// admin instructions bind the signer to config.authority
	const authorityChecks = libRs.match(/has_one = authority @ NeonRelayError::Unauthorized/g);
	assert.ok(authorityChecks && authorityChecks.length >= 2,
		"publish_epoch and set_paused must both enforce has_one = authority");
});

test("no hardcoded mint, no SKR token anywhere in onchain/", () => {
	// the only base58 string literal long enough to be a pubkey in lib.rs must
	// be the declare_id placeholder
	const candidates = libRs.match(/"[1-9A-HJ-NP-Za-km-z]{32,44}"/g) ?? [];
	assert.deepEqual(candidates, [`"${PROGRAM_ID_PLACEHOLDER}"`]);
	// mint comes from an account passed at initialize
	assert.match(libRs, /config\.mint = ctx\.accounts\.mint\.key\(\)/);
	assert.ok(!/skr/i.test(libRs) && !/skr/i.test(anchorToml),
		"no token named SKR may appear (spec requirement)");
	// Anchor.toml stays on devnet: no mainnet outside comments
	const anchorNoComments = anchorToml.replace(/#.*$/gm, "");
	assert.match(anchorNoComments, /cluster = "devnet"/);
	assert.ok(!/mainnet/.test(anchorNoComments), "Anchor.toml must not configure mainnet");
});

test("Tranche A: publish_epoch binds leaf_count and claim enforces exact depth", () => {
	assert.match(libRs,
		/pub fn publish_epoch\(ctx: Context<PublishEpoch>, epoch_id: u64, root: \[u8; 32\], leaf_count: u32\)/);
	assert.match(libRs, /require!\(leaf_count > 0, NeonRelayError::InvalidLeafCount\)/);
	assert.match(libRs, /epoch\.leaf_count = leaf_count;/);
	// unconditional: the old `if leaf_count != 0` gate is gone
	assert.equal(libRs.includes("if ctx.accounts.epoch.leaf_count != 0"), false);
	assert.match(libRs, /let depth = ctx\.accounts\.epoch\.leaf_count\.next_power_of_two\(\)\.trailing_zeros\(\) as usize;/);
	assert.match(libRs, /require!\(proof\.len\(\) == depth, NeonRelayError::ProofInvalid\)/);
	assert.match(libRs, /require!\(leaf_index < ctx\.accounts\.epoch\.leaf_count, NeonRelayError::ProofInvalid\)/);
	// the publication event carries the count for indexers
	assert.match(libRs, /pub struct EpochPublished \{[^}]*pub leaf_count: u32,/s);
});
