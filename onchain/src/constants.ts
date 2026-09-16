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
