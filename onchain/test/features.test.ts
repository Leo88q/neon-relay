/**
 * Stage-11 features-program tests: achievement bitmap helpers (runtime) and
 * static conformance of programs/neonrelay-features/src/lib.rs against the TS
 * constants and the security policy — the same approach as program.test.ts,
 * because cargo/anchor cannot run in the sandbox (BL-03).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
	ACHIEVEMENT_BITS, FEATURES_PROGRAM_ID_PLACEHOLDER, FEATURES_SEEDS,
	MAX_LEADERBOARD_ENTRIES, MAX_TOURNAMENT_CAPACITY,
} from "../src/constants.ts";
import {
	achievementIsSet, achievementList, bitmapFromBytes, bitmapToBytes,
	emptyBitmap, withAchievement,
} from "../src/achievements.ts";

const here = dirname(fileURLToPath(import.meta.url));
const libRs = readFileSync(join(here, "../programs/neonrelay-features/src/lib.rs"), "utf8");
const cargoToml = readFileSync(join(here, "../programs/neonrelay-features/Cargo.toml"), "utf8");
const anchorToml = readFileSync(join(here, "../Anchor.toml"), "utf8");

test("bitmap helpers round-trip and match the program's word/bit arithmetic", () => {
	let bits = emptyBitmap();
	for (const id of [0, 1, 63, 64, 127, 128, 200, 255]) {
		assert.equal(achievementIsSet(bits, id), false);
		bits = withAchievement(bits, id);
		assert.equal(achievementIsSet(bits, id), true);
	}
	assert.deepEqual(achievementList(bits), [0, 1, 63, 64, 127, 128, 200, 255]);
	const bytes = bitmapToBytes(bits);
	assert.equal(bytes.length, 32);
	assert.deepEqual(bitmapFromBytes(bytes), bits);
	// idempotence, like record_achievement
	assert.deepEqual(withAchievement(bits, 64), bits);
	assert.throws(() => achievementIsSet(bits, ACHIEVEMENT_BITS));
	assert.throws(() => achievementIsSet(bits, -1));
	assert.throws(() => bitmapFromBytes(Buffer.alloc(31)));
});

test("features PDA seeds in lib.rs match the TS constants", () => {
	assert.match(libRs, new RegExp(`CONFIG_SEED: &\\[u8\\] = b"${FEATURES_SEEDS.config}"`));
	assert.match(libRs, new RegExp(`ACHIEVEMENTS_SEED: &\\[u8\\] = b"${FEATURES_SEEDS.achievements}"`));
	assert.match(libRs, new RegExp(`BADGE_SEED: &\\[u8\\] = b"${FEATURES_SEEDS.badge}"`));
	assert.match(libRs, new RegExp(`LEADERBOARD_SEED: &\\[u8\\] = b"${FEATURES_SEEDS.leaderboard}"`));
	assert.match(libRs, new RegExp(`TOURNAMENT_SEED: &\\[u8\\] = b"${FEATURES_SEEDS.tournament}"`));
	assert.match(libRs, new RegExp(`REGISTRATION_SEED: &\\[u8\\] = b"${FEATURES_SEEDS.registration}"`));
});

test("caps agree between program and client", () => {
	assert.match(libRs, new RegExp(`ACHIEVEMENT_BITS: usize = ${ACHIEVEMENT_BITS}`));
	assert.match(libRs, new RegExp(`MAX_LEADERBOARD_ENTRIES: usize = ${MAX_LEADERBOARD_ENTRIES}`));
	assert.match(libRs, new RegExp(`MAX_TOURNAMENT_CAPACITY: u32 = 65_535`));
	assert.equal(MAX_TOURNAMENT_CAPACITY, 65535);
});

test("placeholder program id is consistent across Anchor.toml, lib.rs and TS", () => {
	assert.match(libRs, new RegExp(`declare_id!\\("${FEATURES_PROGRAM_ID_PLACEHOLDER}"\\)`));
	assert.match(anchorToml, new RegExp(`neonrelay_features = "${FEATURES_PROGRAM_ID_PLACEHOLDER}"`));
});

test("authority gating, uniqueness and pause guards are present", () => {
	// every curated-write context binds the signer to config.authority
	const authorityChecks = libRs.match(/has_one = authority @ FeaturesError::Unauthorized/g);
	assert.ok(authorityChecks && authorityChecks.length >= 5,
		"record/create_registry/publish_leaderboard/create_tournament/set_paused must enforce has_one = authority");
	// badge uniqueness: mint PDA keyed by (achievement, player), created via init
	assert.match(libRs, /seeds = \[BADGE_SEED, &achievement_id\.to_be_bytes\(\), player\.key\(\)\.as_ref\(\)\]/);
	// badge only after the achievement bit is set
	assert.match(libRs, /FeaturesError::AchievementNotRecorded/);
	// supply-1 collectible: 0 decimals, mint exactly one
	assert.match(libRs, /mint::decimals = 0/);
	assert.match(libRs, /token::mint_to\(cpi_ctx, 1\)\?/);
	// leaderboard and tournament one-way publication via init PDAs
	assert.match(libRs, /seeds = \[LEADERBOARD_SEED, &epoch_id\.to_be_bytes\(\)\]/);
	assert.match(libRs, /seeds = \[TOURNAMENT_SEED, &tournament_id\.to_be_bytes\(\)\]/);
	// registration: no double registration (init PDA), window + capacity checks
	assert.match(libRs, /seeds = \[REGISTRATION_SEED, &tournament_id\.to_be_bytes\(\), player\.key\(\)\.as_ref\(\)\]/);
	assert.match(libRs, /FeaturesError::TournamentNotStarted/);
	assert.match(libRs, /FeaturesError::TournamentAlreadyOver/);
	assert.match(libRs, /tournament\.registered < tournament\.capacity/);
	// pause blocks player actions
	const pauseChecks = libRs.match(/require!\(!ctx\.accounts\.config\.paused, FeaturesError::Paused\)/g);
	assert.ok(pauseChecks && pauseChecks.length >= 2, "badge minting and registration must check paused");
	// registry recording is idempotent (early return when the bit is set)
	assert.match(libRs, /if registry\.bits\[word\] & bit != 0 \{\n\t\t\treturn Ok\(\(\)\); \/\/ idempotent/);
});

test("no external NFT dependency, no SKR, no hardcoded mint", () => {
	// metadata stays off-chain (BL-13): no metaplex/token-metadata crate pinned
	assert.ok(!/metaplex|token-metadata/i.test(cargoToml), "no metaplex dependency allowed (unverifiable offline)");
	// only the two pinned anchor crates
	const deps = cargoToml.split("[dependencies]")[1] ?? "";
	assert.ok(!/^\s*[a-z0-9_-]+\s*=/im.test(deps.split("\n").filter((l) => !l.startsWith("#") && !l.startsWith("anchor-")).join("\n")),
		"dependencies must stay anchor-lang + anchor-spl only");
	assert.ok(!/skr/i.test(libRs) && !/skr/i.test(cargoToml));
	// the only pubkey-shaped literal is the declare_id placeholder
	const candidates = libRs.match(/"[1-9A-HJ-NP-Za-km-z]{32,44}"/g) ?? [];
	assert.deepEqual(candidates, [`"${FEATURES_PROGRAM_ID_PLACEHOLDER}"`]);
});
