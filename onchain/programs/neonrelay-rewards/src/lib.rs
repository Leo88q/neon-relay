//! Neon Relay rewards program (stage 9).
//!
//! Pays sealed reward epochs exactly once per (epoch, wallet) leaf of a
//! SHA-256 Merkle tree. The tree construction is byte-identical to the reward
//! backend (`backend/src/merkle.ts`, docs/REWARD_SECURITY.md §6):
//!
//!   leaf   = SHA256(wallet_pubkey_bytes(32) || amount_micro as u64be)
//!   parent = SHA256(left(32) || right(32))
//!   tree   = complete binary, padded by duplicating the last leaf
//!   proof  = siblings leaf-first, folded with an explicit leaf index
//!
//! Trust model:
//!   * Only `config.authority` (the operator) can publish an epoch root or
//!     pause the program. A published root can never be replaced (the epoch
//!     PDA `init` fails if it already exists).
//!   * The program never trusts the backend beyond a root: a payout requires a
//!     valid proof for the claimed wallet + amount against that root.
//!   * Double claims are impossible: the claim record PDA is keyed by
//!     (epoch, wallet) and `init` fails when it already exists.
//!   * No mint is hardcoded. The reward mint is provided at `initialize` and
//!     must have `EXPECTED_DECIMALS` (6) decimals so that `amount_micro`
//!     equals SPL base units. Mainnet mints are out of scope: deployments are
//!     devnet-only until a legal/liquidity review says otherwise
//!     (docs/KNOWN_LIMITATIONS.md).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hashv;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

// PLACEHOLDER program id: replace with the real one from `anchor keys list`
// before the first deployment (recorded in onchain/README.md).
declare_id!("2RaaXKUutemHtSZUsmnEv41ytWMkaXD6rcoziHGLRtmj");

/// PDA seeds. Mirrored by `onchain/src/pda.ts` and asserted equal by
/// `onchain/test/program.test.ts` so the TS client cannot drift.
pub const CONFIG_SEED: &[u8] = b"neonrelay_config";
pub const EPOCH_SEED: &[u8] = b"neonrelay_epoch";
pub const CLAIM_SEED: &[u8] = b"neonrelay_claim";
pub const VAULT_SEED: &[u8] = b"neonrelay_vault";

/// Proof length cap: 2^32 leaves would need 32 siblings; anything longer is
/// rejected outright to bound compute.
pub const MAX_PROOF_LEN: usize = 32;

/// Reward mints must use 6 decimals so that the ledger's `amount_micro`
/// (1e-6 units) equals the SPL token's base units.
pub const EXPECTED_DECIMALS: u8 = 6;

/// 48h timelock for authority change (HIGH-04 fix, 432k slots @0.4s/slot)
pub const MIN_AUTHORITY_DELAY_SLOTS: u64 = 432_000;

#[program]
pub mod neonrelay_rewards {
	use super::*;

	/// One-time setup: records the operator authority and the reward mint,
	/// creates the program-owned token vault. Not pausable, not repeatable
	/// (the config PDA `init` fails on a second call).
	pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
		require!(
			ctx.accounts.mint.decimals == EXPECTED_DECIMALS,
			NeonRelayError::UnexpectedDecimals
		);
		let config = &mut ctx.accounts.config;
		config.authority = ctx.accounts.authority.key();
		config.mint = ctx.accounts.mint.key();
		config.paused = false;
		config.epoch_count = 0;
		config.bump = ctx.bumps.config;
		config.vault_bump = ctx.bumps.vault;
		config.pending_authority = Pubkey::default();
		config.authority_change_slot = 0;
		emit!(Initialized {
			authority: config.authority,
			mint: config.mint,
		});
		Ok(())
	}

	/// Operator-only: publish the Merkle root of a sealed backend epoch.
	/// One-way — re-publishing the same `epoch_id` fails because the epoch PDA
	/// already exists. An all-zero root is rejected.
	///
	/// Tranche A: `leaf_count` (the sealed backend leaf total) is bound into
	/// the epoch so `claim` enforces the exact proof depth derived from it —
	/// short proofs on the padded tree can never verify.
	pub fn publish_epoch(ctx: Context<PublishEpoch>, epoch_id: u64, root: [u8; 32], leaf_count: u32) -> Result<()> {
		require!(root != [0u8; 32], NeonRelayError::EmptyRoot);
		require!(leaf_count > 0, NeonRelayError::InvalidLeafCount);
		let epoch = &mut ctx.accounts.epoch;
		epoch.id = epoch_id;
		epoch.root = root;
		epoch.published_at = Clock::get()?.unix_timestamp;
		epoch.bump = ctx.bumps.epoch;
		epoch.leaf_count = leaf_count;
		let config = &mut ctx.accounts.config;
		config.epoch_count = config.epoch_count.checked_add(1).ok_or(NeonRelayError::Overflow)?;
		emit!(EpochPublished { epoch_id, root, leaf_count });
		Ok(())
	}

	/// Operator-only emergency stop. While paused, `claim` rejects; publishing
	/// roots stays possible so sealed epochs do not pile up.
	pub fn set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
		let config = &mut ctx.accounts.config;
		config.paused = paused;
		emit!(PauseChanged { paused });
		Ok(())
	}

	/// Propose authority change with 48h timelock (CRITICAL-02 fix)
	pub fn propose_authority_change(ctx: Context<AdminOnly>, new_authority: Pubkey) -> Result<()> {
		require!(new_authority != Pubkey::default(), NeonRelayError::InvalidAuthority);
		let config = &mut ctx.accounts.config;
		config.pending_authority = new_authority;
		config.authority_change_slot = Clock::get()?.slot;
		emit!(AuthorityChangeProposed { current: config.authority, pending: new_authority, slot: config.authority_change_slot });
		Ok(())
	}

	/// Accept authority after timelock
	pub fn accept_authority_change(ctx: Context<AcceptAuthority>) -> Result<()> {
		let config = &mut ctx.accounts.config;
		require!(config.pending_authority != Pubkey::default(), NeonRelayError::NoPendingAuthority);
		let current_slot = Clock::get()?.slot;
		require!(current_slot >= config.authority_change_slot + MIN_AUTHORITY_DELAY_SLOTS, NeonRelayError::TimelockNotExpired);
		let old = config.authority;
		config.authority = config.pending_authority;
		config.pending_authority = Pubkey::default();
		config.authority_change_slot = 0;
		emit!(AuthorityChanged { old, new: config.authority });
		Ok(())
	}

	/// Pay one leaf: verify the proof against the published root, create the
	/// (epoch, wallet) claim record (fails if it exists — no double claims)
	/// and transfer `amount_micro` base units from the vault to the player's
	/// token account. The player wallet signs and must be the leaf's pubkey.
	pub fn claim(
		ctx: Context<Claim>,
		epoch_id: u64,
		amount_micro: u64,
		leaf_index: u32,
		proof: Vec<[u8; 32]>,
	) -> Result<()> {
		let config = &ctx.accounts.config;
		require!(!config.paused, NeonRelayError::Paused);
		require!(amount_micro > 0, NeonRelayError::ZeroAmount);
		require!(proof.len() <= MAX_PROOF_LEN, NeonRelayError::ProofTooLong);
		// MEDIUM-01 fix: vault not frozen (initialized state)
		require!(ctx.accounts.vault.state == anchor_spl::token::spl_token::state::AccountState::Initialized, NeonRelayError::VaultFrozen);
		require!(ctx.accounts.player_token_account.state == anchor_spl::token::spl_token::state::AccountState::Initialized, NeonRelayError::VaultFrozen);
		require!(ctx.accounts.vault.amount >= amount_micro, NeonRelayError::InsufficientVaultFunds);
		// Tranche A: exact depth + index bound, unconditional. leaf_count is
		// always bound at publish time, so a short proof on the padded tree
		// (or an out-of-range leaf index) can never verify.
		let depth = ctx.accounts.epoch.leaf_count.next_power_of_two().trailing_zeros() as usize;
		require!(proof.len() == depth, NeonRelayError::ProofInvalid);
		require!(leaf_index < ctx.accounts.epoch.leaf_count, NeonRelayError::ProofInvalid);

		let epoch = &ctx.accounts.epoch;
		require!(epoch.id == epoch_id, NeonRelayError::EpochMismatch);

		let leaf = merkle_leaf(&ctx.accounts.player.key().to_bytes(), amount_micro);
		require!(
			verify_proof_indexed(&leaf, leaf_index, &proof, &epoch.root),
			NeonRelayError::ProofInvalid
		);

		let claim_record = &mut ctx.accounts.claim;
		claim_record.epoch_id = epoch_id;
		claim_record.wallet = ctx.accounts.player.key();
		claim_record.amount_micro = amount_micro;
		claim_record.claimed_at = Clock::get()?.unix_timestamp;
		claim_record.bump = ctx.bumps.claim;

		let config_bump = config.bump;
		let signer_seeds: &[&[&[u8]]] = &[&[CONFIG_SEED, &[config_bump]]];
		let cpi_ctx = CpiContext::new_with_signer(
			ctx.accounts.token_program.to_account_info(),
			Transfer {
				from: ctx.accounts.vault.to_account_info(),
				to: ctx.accounts.player_token_account.to_account_info(),
				authority: ctx.accounts.config.to_account_info(),
			},
			signer_seeds,
		);
		token::transfer(cpi_ctx, amount_micro)?;

		emit!(Claimed {
			epoch_id,
			wallet: claim_record.wallet,
			amount_micro,
		});
		Ok(())
	}
}

// --------------------------------------------------------------------- state

#[account]
#[derive(InitSpace)]
pub struct Config {
	pub authority: Pubkey,
	pub mint: Pubkey,
	pub paused: bool,
	pub epoch_count: u64,
	pub bump: u8,
	pub vault_bump: u8,
	pub pending_authority: Pubkey,
	pub authority_change_slot: u64,
}

#[account]
#[derive(InitSpace)]
pub struct EpochState {
	pub id: u64,
	pub root: [u8; 32],
	pub published_at: i64,
	pub bump: u8,
	pub leaf_count: u32,
}

#[account]
#[derive(InitSpace)]
pub struct ClaimRecord {
	pub epoch_id: u64,
	pub wallet: Pubkey,
	pub amount_micro: u64,
	pub claimed_at: i64,
	pub bump: u8,
}

// ------------------------------------------------------------------ contexts

#[derive(Accounts)]
pub struct Initialize<'info> {
	#[account(
		init,
		payer = payer,
		space = 8 + Config::INIT_SPACE,
		seeds = [CONFIG_SEED],
		bump,
	)]
	pub config: Account<'info, Config>,
	#[account(
		init,
		payer = payer,
		token::mint = mint,
		token::authority = config,
		seeds = [VAULT_SEED],
		bump,
	)]
	pub vault: Account<'info, TokenAccount>,
	/// Reward mint. Provided by the deployer — never hardcoded. Devnet
	/// deployments use a throwaway test mint created by
	/// `onchain/scripts/create_test_mint.sh`.
	pub mint: Account<'info, Mint>,
	/// Becomes `config.authority` (the operator key that publishes roots).
	pub authority: Signer<'info>,
	#[account(mut)]
	pub payer: Signer<'info>,
	pub token_program: Program<'info, Token>,
	pub system_program: Program<'info, System>,
	pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
	#[account(
		mut,
		seeds = [CONFIG_SEED],
		bump = config.bump,
		has_one = authority @ NeonRelayError::Unauthorized,
	)]
	pub config: Account<'info, Config>,
	pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
	#[account(
		mut,
		seeds = [CONFIG_SEED],
		bump = config.bump,
		constraint = config.pending_authority == pending_authority.key() @ NeonRelayError::Unauthorized,
	)]
	pub config: Account<'info, Config>,
	pub pending_authority: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(epoch_id: u64)]
pub struct PublishEpoch<'info> {
	#[account(
		mut,
		seeds = [CONFIG_SEED],
		bump = config.bump,
		has_one = authority @ NeonRelayError::Unauthorized,
	)]
	pub config: Account<'info, Config>,
	pub authority: Signer<'info>,
	#[account(
		init,
		payer = authority,
		space = 8 + EpochState::INIT_SPACE,
		seeds = [EPOCH_SEED, &epoch_id.to_be_bytes()],
		bump,
	)]
	pub epoch: Account<'info, EpochState>,
	pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(epoch_id: u64, amount_micro: u64)]
pub struct Claim<'info> {
	#[account(
		seeds = [CONFIG_SEED],
		bump = config.bump,
		has_one = mint @ NeonRelayError::MintMismatch,
	)]
	pub config: Account<'info, Config>,
	#[account(
		seeds = [EPOCH_SEED, &epoch_id.to_be_bytes()],
		bump = epoch.bump,
	)]
	pub epoch: Account<'info, EpochState>,
	/// Existence == already claimed. `init` fails on the second attempt for
	/// the same (epoch, wallet) pair — the no-double-claim guarantee.
	#[account(
		init,
		payer = player,
		space = 8 + ClaimRecord::INIT_SPACE,
		seeds = [CLAIM_SEED, &epoch_id.to_be_bytes(), player.key().as_ref()],
		bump,
	)]
	pub claim: Account<'info, ClaimRecord>,
	/// The wallet whose pubkey is bound into the Merkle leaf; signs the claim.
	#[account(mut)]
	pub player: Signer<'info>,
	#[account(
		mut,
		token::mint = mint,
		token::authority = player,
	)]
	pub player_token_account: Account<'info, TokenAccount>,
	#[account(
		address = config.mint @ NeonRelayError::MintMismatch,
	)]
	pub mint: Account<'info, Mint>,
	#[account(
		mut,
		seeds = [VAULT_SEED],
		bump = config.vault_bump,
		token::mint = mint,
		token::authority = config,
	)]
	pub vault: Account<'info, TokenAccount>,
	pub token_program: Program<'info, Token>,
	pub system_program: Program<'info, System>,
}

// -------------------------------------------------------------------- merkle

/// leaf = SHA256(wallet_pubkey(32) || amount_micro as u64be) — byte-identical
/// to backend `leafHash()` and onchain/src/merkle.ts.
pub fn merkle_leaf(wallet: &[u8; 32], amount_micro: u64) -> [u8; 32] {
	hashv(&[wallet, &amount_micro.to_be_bytes()]).to_bytes()
}

/// Indexed proof fold — same direction rule as backend
/// `verifyProofIndexed()`: even index ⇒ current on the left.
pub fn verify_proof_indexed(
	leaf: &[u8; 32],
	leaf_index: u32,
	proof: &[[u8; 32]],
	root: &[u8; 32],
) -> bool {
	let mut current = *leaf;
	let mut index = leaf_index;
	for sibling in proof {
		current = if index & 1 == 0 {
			hashv(&[&current, sibling]).to_bytes()
		} else {
			hashv(&[sibling, &current]).to_bytes()
		};
		index >>= 1;
	}
	&current == root
}

// -------------------------------------------------------------------- events

#[event]
pub struct Initialized {
	pub authority: Pubkey,
	pub mint: Pubkey,
}

#[event]
pub struct EpochPublished {
	pub epoch_id: u64,
	pub root: [u8; 32],
	pub leaf_count: u32,
}

#[event]
pub struct PauseChanged {
	pub paused: bool,
}

#[event]
pub struct Claimed {
	pub epoch_id: u64,
	pub wallet: Pubkey,
	pub amount_micro: u64,
}

#[event]
pub struct AuthorityChangeProposed {
	pub current: Pubkey,
	pub pending: Pubkey,
	pub slot: u64,
}

#[event]
pub struct AuthorityChanged {
	pub old: Pubkey,
	pub new: Pubkey,
}

// -------------------------------------------------------------------- errors

#[error_code]
pub enum NeonRelayError {
	#[msg("signer is not the configured operator authority")]
	Unauthorized,
	#[msg("program is paused; claims are temporarily disabled")]
	Paused,
	#[msg("epoch id does not match the epoch account")]
	EpochMismatch,
	#[msg("merkle proof does not verify against the published epoch root")]
	ProofInvalid,
	#[msg("merkle proof exceeds the maximum length")]
	ProofTooLong,
	#[msg("epoch root must not be all-zero")]
	EmptyRoot,
	#[msg("claim amount must be greater than zero")]
	ZeroAmount,
	#[msg("reward mint must have 6 decimals (amount_micro == base units)")]
	UnexpectedDecimals,
	#[msg("mint does not match the configured reward mint")]
	MintMismatch,
	#[msg("arithmetic overflow")]
	Overflow,
	#[msg("invalid authority")]
	InvalidAuthority,
	#[msg("no pending authority")]
	NoPendingAuthority,
	#[msg("timelock not expired (48h)")]
	TimelockNotExpired,
	#[msg("vault is frozen")]
	VaultFrozen,
	// Appended last so existing error discriminants stay stable.
	#[msg("leaf count must be greater than zero")]
	InvalidLeafCount,
	#[msg("vault has insufficient funds for claim")]
	InsufficientVaultFunds,
}

// ---------------------------------------------------------------- unit tests
// These run with plain `cargo test -p neonrelay-rewards` (no Solana toolchain
// needed for the pure-Merkle part) and pin the construction shared with the
// backend and the TS client.

#[cfg(test)]
mod tests {
	use super::*;

	fn hex(s: &str) -> [u8; 32] {
		let mut out = [0u8; 32];
		for i in 0..32 {
			out[i] = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap();
		}
		out
	}

	#[test]
	fn leaf_matches_backend_vector() {
		// Golden vector: wallet = 32 bytes of 0x07, amount_micro = 1200.
		// Computed with backend/src/merkle.ts leafHash().
		let wallet = [7u8; 32];
		let leaf = merkle_leaf(&wallet, 1200);
		let expected = hex(&std::fs::read_to_string("tests/golden_leaf.txt").unwrap().trim());
		assert_eq!(leaf, expected);
	}

	#[test]
	fn proof_depth_matches_backend_padding() {
		// depth = trailing zeros of next_power_of_two(leaf_count):
		// 1 leaf -> empty proof, 2 -> 1 sibling, 3..4 -> 2, 5..8 -> 3, 9..16 -> 4.
		for (leaves, depth) in [(1u32, 0usize), (2, 1), (3, 2), (4, 2), (7, 3), (8, 3), (10, 4)] {
			assert_eq!(leaves.next_power_of_two().trailing_zeros() as usize, depth);
		}
	}

	#[test]
	fn indexed_proof_fold_matches_backend() {
		// Two-leaf tree: leaf0 = leaf(0x07*32, 1200), leaf1 = leaf(0x08*32, 400).
		let l0 = merkle_leaf(&[7u8; 32], 1200);
		let l1 = merkle_leaf(&[8u8; 32], 400);
		let root = hashv(&[&l0, &l1]).to_bytes();
		assert!(verify_proof_indexed(&l0, 0, &[l1], &root));
		assert!(verify_proof_indexed(&l1, 1, &[l0], &root));
		// tampered amount must fail
		assert!(!verify_proof_indexed(&merkle_leaf(&[7u8; 32], 1201), 0, &[l1], &root));
		// wrong direction must fail
		assert!(!verify_proof_indexed(&l0, 1, &[l1], &root));
	}
}
