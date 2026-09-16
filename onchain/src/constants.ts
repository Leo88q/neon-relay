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
