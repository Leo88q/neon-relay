/**
 * Constants shared with the Anchor program (programs/neonrelay-rewards/src/lib.rs).
 * test/program.test.ts asserts the Rust source and this file agree, so the
 * TS client cannot silently drift from the deployed program.
 */

/** PDA seeds, exactly as in lib.rs (CONFIG_SEED, EPOCH_SEED, CLAIM_SEED, VAULT_SEED). */
export const SEEDS = {
	config: "neonrelay_config",
	epoch: "neonrelay_epoch",
	claim: "neonrelay_claim",
	vault: "neonrelay_vault",
} as const;

/** PLACEHOLDER program id from Anchor.toml; replace with `anchor keys list` output on deployment. */
export const PROGRAM_ID_PLACEHOLDER = "2RaaXKUutemHtSZUsmnEv41ytWMkaXD6rcoziHGLRtmj";

/** Reward mints must use 6 decimals so amount_micro == SPL base units. */
export const EXPECTED_DECIMALS = 6;

/** Maximum Merkle proof length accepted by `claim`. */
export const MAX_PROOF_LEN = 32;

/** --- rewards `claim` client contract (mobile claim builder) ---
 * Mirrored by android/.../wallet/RewardsTxBuilder.kt; test/rewards_claim.test.ts
 * asserts every value below against programs/neonrelay-rewards/src/lib.rs. */

/** Anchor instruction discriminator: sha256("global:claim")[0..8], hex. */
export const CLAIM_IX_DISCRIMINATOR = "3ec6d6c1d59f6cd2";
/** Account discriminators: sha256("account:<Name>")[0..8], hex. */
export const REWARDS_CONFIG_DISCRIMINATOR = "9b0caae01efacc82";
export const REWARDS_EPOCH_STATE_DISCRIMINATOR = "bf3f8bed900cdfd2";

/** Account sizes including the 8-byte discriminator. */
export const REWARDS_CONFIG_SIZE = 131;
export const REWARDS_EPOCH_STATE_SIZE = 77;

/** `Claim` account order, exactly as in lib.rs. */
export const CLAIM_ACCOUNTS = [
	"config", "epoch", "claim", "player", "player_token_account",
	"mint", "vault", "token_program", "system_program",
] as const;

/** `claim` argument order and Borsh types, exactly as in lib.rs. */
export const CLAIM_ARGS = [
	["epoch_id", "u64"],
	["amount_micro", "u64"],
	["leaf_index", "u32"],
	["proof", "Vec<[u8; 32]>"],
] as const;

/** --- neonrelay-features program (stage 11) --- */

/** PLACEHOLDER program id from Anchor.toml; replace with `anchor keys list` output on deployment. */
export const FEATURES_PROGRAM_ID_PLACEHOLDER = "4PH1dHVBRbfoydBx3SuRjAS46zRRjHvRxWCNcrFBDqYP";

/** PDA seeds of the features program, exactly as in its lib.rs. */
export const FEATURES_SEEDS = {
	config: "neonrelay_features_config",
	achievements: "neonrelay_achievements",
	badge: "neonrelay_badge",
	leaderboard: "neonrelay_leaderboard",
	tournament: "neonrelay_tournament",
	registration: "neonrelay_registration",
} as const;

/** Achievement ids are bits in a [u64; 4] bitmap. */
export const ACHIEVEMENT_BITS = 256;

/** Leaderboard snapshot cap. */
export const MAX_LEADERBOARD_ENTRIES = 64;

/** Tournament capacity cap. */
export const MAX_TOURNAMENT_CAPACITY = 65535;

/** --- neonrelay-economy program (stage 14) --- */

/** PLACEHOLDER program id from Anchor.toml; replace with `anchor keys list` output on deployment. */
export const ECONOMY_PROGRAM_ID_PLACEHOLDER = "FZcLDdUrs6i1HYFFK2NhqNrbVaP6KTvrqzhyoDGT6CV9";

/** PDA seeds of the economy program, exactly as in its lib.rs. */
export const ECONOMY_SEEDS = {
	config: "neonrelay_economy_config",
	entry: "neonrelay_entry",
	prizes: "neonrelay_prizes",
	claim: "neonrelay_prize_claim",
} as const;

/** Rake cap in basis points (20%); deployed default is 1000 (10%). */
export const MAX_RAKE_BPS = 2000;
/** Approved operator rake in basis points (10%). */
export const DEFAULT_RAKE_BPS = 1000;
/** Entry kinds accepted by `pay_entry`. */
export const ENTRY_KIND = { match: 0, tournament: 1 } as const;
/**
 * Approved top-10 prize split in basis points of the epoch prize pool
 * (places 1..10; sums to 10000 = 100%).
 */
export const PRIZE_TABLE_BPS = [2500, 1800, 1400, 1100, 900, 700, 600, 500, 300, 200] as const;

/** --- neonrelay-assets program (source-gated asset paths, 2026) --- */

export const ASSETS_PROGRAM_ID_PLACEHOLDER =
  "F5VhZxGGEY61TNNexRwJVomMZtHeAZodqVHPMqoxq3oc";

export const ASSETS_SEEDS = {
  config: "neonrelay_assets_config",
  collection: "neonrelay_collection",
  badge: "neonrelay_badge_asset",
  treeConfig: "neonrelay_tree_config",
  mintConfig: "neonrelay_mint_config",
} as const;

export const BUBBLEGUM_PROGRAM_ID =
  "BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY";
export const COMPRESSION_PROGRAM_ID =
  "cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK";
export const NOOP_PROGRAM_ID =
  "noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV";
export const MPL_CORE_PROGRAM_ID =
  "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d";
