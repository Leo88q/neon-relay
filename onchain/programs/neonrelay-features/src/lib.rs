//! Neon Relay features program (stage 11).
//!
//! Non-simulation on-chain features, per the spec rule that the blockchain is
//! used for rewards and metadata — never for game logic:
//!
//!   * Achievement registry: the operator service records achievements per
//!     player in a 256-bit bitmap PDA. Idempotent, authority-only writes.
//!   * Badge tokens: a recorded achievement lets the player mint ONE unique
//!     collectible — a 0-decimal SPL mint with supply 1, keyed by
//!     (achievement, player). Mint PDA `init` fails on a second attempt, so a
//!     badge is provably unique without any external NFT standard. Token
//!     metadata (name/art) is served off-chain by the backend; no metaplex
//!     dependency is vendored (see docs/KNOWN_LIMITATIONS.md BL-13).
//!   * Epoch leaderboards: the operator publishes a top-N snapshot
//!     (wallet, score) per epoch. One-way, like reward-epoch roots.
//!   * Tournaments: operator-created registration windows with a capacity;
//!     players register for free (no funds move), one registration per
//!     (tournament, wallet), cancellable once (frees the slot).
//!
//! Trust model matches the rewards program: only `config.authority` writes
//! curated data; players only act on their own behalf; `set_paused` stops
//! player actions without freezing operator maintenance.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount};

// PLACEHOLDER program id: replace with the real one from `anchor keys list`
// before the first deployment (onchain/README.md, docs/DEVNET_RUNBOOK.md).
declare_id!("4PH1dHVBRbfoydBx3SuRjAS46zRRjHvRxWCNcrFBDqYP");

/// PDA seeds. Mirrored by `onchain/src/constants.ts` (FEATURES_SEEDS) and
/// asserted equal by `onchain/test/features.test.ts`.
pub const CONFIG_SEED: &[u8] = b"neonrelay_features_config";
pub const ACHIEVEMENTS_SEED: &[u8] = b"neonrelay_achievements";
pub const BADGE_SEED: &[u8] = b"neonrelay_badge";
pub const LEADERBOARD_SEED: &[u8] = b"neonrelay_leaderboard";
pub const TOURNAMENT_SEED: &[u8] = b"neonrelay_tournament";
pub const REGISTRATION_SEED: &[u8] = b"neonrelay_registration";

/// Achievement ids are bits in a `[u64; 4]` bitmap.
pub const ACHIEVEMENT_BITS: usize = 256;
/// Leaderboard snapshot cap.
pub const MAX_LEADERBOARD_ENTRIES: usize = 64;
/// Tournament capacity cap (account-space bound).
pub const MAX_TOURNAMENT_CAPACITY: u32 = 65_535;
/// Anti-sybil minimum player balance required to register (0.01 SOL).
pub const MIN_SYBIL_PLAYER_LAMPORTS: u64 = 10_000_000;

#[program]
pub mod neonrelay_features {
	use super::*;

	/// One-time setup; the signer becomes the operator `authority`.
	pub fn initialize(ctx: Context<FeaturesInitialize>) -> Result<()> {
		let config = &mut ctx.accounts.config;
		config.authority = ctx.accounts.authority.key();
		config.paused = false;
		config.achievements_recorded = 0;
		config.badges_minted = 0;
		config.bump = ctx.bumps.config;
		config.pending_authority = Pubkey::default();
		config.authority_change_slot = 0;
		emit!(FeaturesInitialized { authority: config.authority });
		Ok(())
	}

	/// Operator-only: create the achievement registry for a player (called once
	/// per player before the first `record_achievement`).
	pub fn create_registry(ctx: Context<CreateRegistry>) -> Result<()> {
		let registry = &mut ctx.accounts.registry;
		registry.player = ctx.accounts.player.key();
		registry.bits = [0u64; 4];
		registry.count = 0;
		registry.bump = ctx.bumps.registry;
		emit!(RegistryCreated { player: registry.player });
		Ok(())
	}

	/// Operator-only: mark `achievement_id` as earned by `player`. Idempotent —
	/// recording an already-set bit succeeds without changing state.
	pub fn record_achievement(ctx: Context<RecordAchievement>, achievement_id: u32) -> Result<()> {
		require!(
			(achievement_id as usize) < ACHIEVEMENT_BITS,
			FeaturesError::AchievementIdOutOfRange
		);
		let registry = &mut ctx.accounts.registry;
		let word = (achievement_id / 64) as usize;
		let bit = 1u64 << (achievement_id % 64);
		if registry.bits[word] & bit != 0 {
			return Ok(()); // idempotent
		}
		registry.bits[word] |= bit;
		registry.count = registry.count.checked_add(1).ok_or(FeaturesError::Overflow)?;
		let config = &mut ctx.accounts.config;
		config.achievements_recorded = config
			.achievements_recorded
			.checked_add(1)
			.ok_or(FeaturesError::Overflow)?;
		emit!(AchievementRecorded {
			player: registry.player,
			achievement_id,
			count: registry.count,
		});
		Ok(())
	}

	/// Player-only: mint the unique badge for a recorded achievement. The mint
	/// PDA is keyed by (achievement, player); a second attempt fails on `init`
	/// — uniqueness is structural. Exactly one unit is minted to the player's
	/// token account; the mint authority is the config PDA and is never handed
	/// out.
	pub fn mint_achievement_badge(ctx: Context<MintBadge>, achievement_id: u32) -> Result<()> {
		require!(!ctx.accounts.config.paused, FeaturesError::Paused);
		require!(
			(achievement_id as usize) < ACHIEVEMENT_BITS,
			FeaturesError::AchievementIdOutOfRange
		);
		let registry = &ctx.accounts.registry;
		let word = (achievement_id / 64) as usize;
		let bit = 1u64 << (achievement_id % 64);
		require!(
			registry.bits[word] & bit != 0,
			FeaturesError::AchievementNotRecorded
		);

		let config = &ctx.accounts.config;
		let config_bump = config.bump;
		let signer_seeds: &[&[&[u8]]] = &[&[CONFIG_SEED, &[config_bump]]];
		let cpi_ctx = CpiContext::new_with_signer(
			ctx.accounts.token_program.to_account_info(),
			MintTo {
				mint: ctx.accounts.badge_mint.to_account_info(),
				to: ctx.accounts.player_badge_account.to_account_info(),
				authority: ctx.accounts.config.to_account_info(),
			},
			signer_seeds,
		);
		token::mint_to(cpi_ctx, 1)?;

		let config = &mut ctx.accounts.config;
		config.badges_minted = config.badges_minted.checked_add(1).ok_or(FeaturesError::Overflow)?;
		emit!(BadgeMinted {
			player: ctx.accounts.player.key(),
			achievement_id,
			mint: ctx.accounts.badge_mint.key(),
		});
		Ok(())
	}

	/// Operator-only: publish a top-N leaderboard snapshot for an epoch.
	/// One-way per epoch (PDA `init`), max `MAX_LEADERBOARD_ENTRIES` rows.
	pub fn publish_leaderboard(
		ctx: Context<PublishLeaderboard>,
		epoch_id: u64,
		entries: Vec<LeaderboardEntryInput>,
	) -> Result<()> {
		require!(
			!entries.is_empty() && entries.len() <= MAX_LEADERBOARD_ENTRIES,
			FeaturesError::LeaderboardLength
		);
		let board = &mut ctx.accounts.leaderboard;
		board.epoch_id = epoch_id;
		board.entries = entries
			.iter()
			.map(|e| LeaderboardEntry { wallet: e.wallet, score: e.score })
			.collect();
		board.published_at = Clock::get()?.unix_timestamp;
		board.bump = ctx.bumps.leaderboard;
		emit!(LeaderboardPublished {
			epoch_id,
			entry_count: board.entries.len() as u32,
		});
		Ok(())
	}

	/// Operator-only: open a free-registration tournament window.
	pub fn create_tournament(
		ctx: Context<CreateTournament>,
		tournament_id: u64,
		starts_at: i64,
		ends_at: i64,
		capacity: u32,
	) -> Result<()> {
		require!(ends_at > starts_at, FeaturesError::TournamentInvalidWindow);
		require!(capacity > 0 && capacity <= MAX_TOURNAMENT_CAPACITY, FeaturesError::TournamentInvalidCapacity);
		let now = Clock::get()?.unix_timestamp;
		require!(ends_at > now, FeaturesError::TournamentAlreadyOver);
		let tournament = &mut ctx.accounts.tournament;
		tournament.id = tournament_id;
		tournament.starts_at = starts_at;
		tournament.ends_at = ends_at;
		tournament.capacity = capacity;
		tournament.registered = 0;
		tournament.bump = ctx.bumps.tournament;
		emit!(TournamentCreated { tournament_id, starts_at, ends_at, capacity });
		Ok(())
	}

	/// Player-only: free registration, inside the window, within capacity.
	/// One registration per (tournament, wallet) — the PDA `init` enforces it.
	pub fn register(ctx: Context<Register>, tournament_id: u64) -> Result<()> {
		require!(!ctx.accounts.config.paused, FeaturesError::Paused);
		require!(ctx.accounts.player.lamports() >= MIN_SYBIL_PLAYER_LAMPORTS, FeaturesError::InsufficientPlayerBalance);
		let tournament = &mut ctx.accounts.tournament;
		let now = Clock::get()?.unix_timestamp;
		require!(now >= tournament.starts_at, FeaturesError::TournamentNotStarted);
		require!(now < tournament.ends_at, FeaturesError::TournamentAlreadyOver);
		require!(tournament.registered < tournament.capacity, FeaturesError::TournamentFull);
		tournament.registered = tournament.registered.checked_add(1).ok_or(FeaturesError::Overflow)?;
		let registration = &mut ctx.accounts.registration;
		registration.tournament_id = tournament_id;
		registration.player = ctx.accounts.player.key();
		registration.active = true;
		registration.registered_at = now;
		registration.bump = ctx.bumps.registration;
		emit!(Registered {
			tournament_id,
			player: registration.player,
			registered: tournament.registered,
		});
		Ok(())
	}

	/// Player-only: cancel a registration, freeing the slot. One-way per
	/// (tournament, wallet): re-registration after cancellation is not
	/// supported (documented in docs/SOLANA_ARCHITECTURE.md §7).
	pub fn cancel_registration(ctx: Context<CancelRegistration>, tournament_id: u64) -> Result<()> {
		let registration = &mut ctx.accounts.registration;
		require!(registration.active, FeaturesError::RegistrationNotActive);
		registration.active = false;
		let tournament = &mut ctx.accounts.tournament;
		tournament.registered = tournament.registered.saturating_sub(1);
		emit!(RegistrationCancelled {
			tournament_id,
			player: registration.player,
		});
		Ok(())
	}

	/// Operator-only emergency stop for player actions (badge minting,
	/// registration). Operator writes stay possible.
	pub fn set_paused(ctx: Context<FeaturesAdminOnly>, paused: bool) -> Result<()> {
		ctx.accounts.config.paused = paused;
		emit!(FeaturesPauseChanged { paused });
		Ok(())
	}

	pub fn propose_authority_change(ctx: Context<FeaturesAdminOnly>, new_authority: Pubkey) -> Result<()> {
		require!(new_authority != Pubkey::default(), FeaturesError::InvalidAuthority);
		let config = &mut ctx.accounts.config;
		config.pending_authority = new_authority;
		config.authority_change_slot = Clock::get()?.slot;
		emit!(AuthorityChangeProposed { current: config.authority, pending: new_authority, slot: config.authority_change_slot });
		Ok(())
	}

	pub fn accept_authority_change(ctx: Context<AcceptFeaturesAuthority>) -> Result<()> {
		let config = &mut ctx.accounts.config;
		require!(config.pending_authority != Pubkey::default(), FeaturesError::NoPendingAuthority);
		let current_slot = Clock::get()?.slot;
		require!(current_slot >= config.authority_change_slot + MIN_AUTHORITY_DELAY_SLOTS, FeaturesError::TimelockNotExpired);
		let old = config.authority;
		config.authority = config.pending_authority;
		config.pending_authority = Pubkey::default();
		config.authority_change_slot = 0;
		emit!(AuthorityChanged { old, new: config.authority });
		Ok(())
	}
}

// --------------------------------------------------------------------- state

#[account]
#[derive(InitSpace)]
pub struct FeaturesConfig {
	pub authority: Pubkey,
	pub paused: bool,
	pub achievements_recorded: u64,
	pub badges_minted: u64,
	pub bump: u8,
	pub pending_authority: Pubkey,
	pub authority_change_slot: u64,
}

/// 48h timelock for authority change (CRITICAL-02 fix)
pub const MIN_AUTHORITY_DELAY_SLOTS: u64 = 432_000;

#[account]
pub struct AchievementRegistry {
	pub player: Pubkey,
	/// Bitmap of earned achievement ids (256 bits).
	pub bits: [u64; 4],
	pub count: u32,
	pub bump: u8,
}

impl AchievementRegistry {
	pub const LEN: usize = 8 + 32 + 4 * 8 + 4 + 1;
}

#[account]
#[derive(InitSpace)]
pub struct Leaderboard {
	pub epoch_id: u64,
	#[max_len(MAX_LEADERBOARD_ENTRIES)]
	pub entries: Vec<LeaderboardEntry>,
	pub published_at: i64,
	pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace)]
pub struct LeaderboardEntry {
	pub wallet: Pubkey,
	pub score: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct LeaderboardEntryInput {
	pub wallet: Pubkey,
	pub score: u64,
}

#[account]
#[derive(InitSpace)]
pub struct Tournament {
	pub id: u64,
	pub starts_at: i64,
	pub ends_at: i64,
	pub capacity: u32,
	pub registered: u32,
	pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Registration {
	pub tournament_id: u64,
	pub player: Pubkey,
	pub active: bool,
	pub registered_at: i64,
	pub bump: u8,
}

// ------------------------------------------------------------------ contexts

#[derive(Accounts)]
pub struct FeaturesInitialize<'info> {
	#[account(
		init,
		payer = payer,
		space = 8 + FeaturesConfig::INIT_SPACE,
		seeds = [CONFIG_SEED],
		bump,
	)]
	pub config: Account<'info, FeaturesConfig>,
	pub authority: Signer<'info>,
	#[account(mut)]
	pub payer: Signer<'info>,
	pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FeaturesAdminOnly<'info> {
	#[account(
		mut,
		seeds = [CONFIG_SEED],
		bump = config.bump,
		has_one = authority @ FeaturesError::Unauthorized,
	)]
	pub config: Account<'info, FeaturesConfig>,
	pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct AcceptFeaturesAuthority<'info> {
	#[account(
		mut,
		seeds = [CONFIG_SEED],
		bump = config.bump,
		constraint = config.pending_authority == pending_authority.key() @ FeaturesError::Unauthorized,
	)]
	pub config: Account<'info, FeaturesConfig>,
	pub pending_authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct CreateRegistry<'info> {
	#[account(
		seeds = [CONFIG_SEED],
		bump = config.bump,
		has_one = authority @ FeaturesError::Unauthorized,
	)]
	pub config: Account<'info, FeaturesConfig>,
	pub authority: Signer<'info>,
	/// The player the registry belongs to (need not sign — the operator
	/// service attests it from server-verified match data).
	/// CHECK: address-only account, referenced by the registry PDA seeds.
	pub player: UncheckedAccount<'info>,
	#[account(
		init,
		payer = authority,
		space = AchievementRegistry::LEN,
		seeds = [ACHIEVEMENTS_SEED, player.key().as_ref()],
		bump,
	)]
	pub registry: Account<'info, AchievementRegistry>,
	pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RecordAchievement<'info> {
	#[account(
		mut,
		seeds = [CONFIG_SEED],
		bump = config.bump,
		has_one = authority @ FeaturesError::Unauthorized,
	)]
	pub config: Account<'info, FeaturesConfig>,
	pub authority: Signer<'info>,
	#[account(
		mut,
		seeds = [ACHIEVEMENTS_SEED, registry.player.as_ref()],
		bump = registry.bump,
	)]
	pub registry: Account<'info, AchievementRegistry>,
}

#[derive(Accounts)]
#[instruction(achievement_id: u32)]
pub struct MintBadge<'info> {
	#[account(
		mut,
		seeds = [CONFIG_SEED],
		bump = config.bump,
	)]
	pub config: Account<'info, FeaturesConfig>,
	#[account(
		seeds = [ACHIEVEMENTS_SEED, player.key().as_ref()],
		bump = registry.bump,
		has_one = player @ FeaturesError::Unauthorized,
	)]
	pub registry: Account<'info, AchievementRegistry>,
	/// Existence == badge already minted; `init` fails on the second attempt.
	#[account(
		init,
		payer = player,
		mint::decimals = 0,
		mint::authority = config,
		seeds = [BADGE_SEED, &achievement_id.to_be_bytes(), player.key().as_ref()],
		bump,
	)]
	pub badge_mint: Account<'info, Mint>,
	#[account(
		mut,
		token::mint = badge_mint,
		token::authority = player,
	)]
	pub player_badge_account: Account<'info, TokenAccount>,
	#[account(mut)]
	pub player: Signer<'info>,
	pub token_program: Program<'info, Token>,
	pub system_program: Program<'info, System>,
	pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(epoch_id: u64)]
pub struct PublishLeaderboard<'info> {
	#[account(
		seeds = [CONFIG_SEED],
		bump = config.bump,
		has_one = authority @ FeaturesError::Unauthorized,
	)]
	pub config: Account<'info, FeaturesConfig>,
	pub authority: Signer<'info>,
	#[account(
		init,
		payer = authority,
		space = 8 + Leaderboard::INIT_SPACE,
		seeds = [LEADERBOARD_SEED, &epoch_id.to_be_bytes()],
		bump,
	)]
	pub leaderboard: Account<'info, Leaderboard>,
	pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(tournament_id: u64)]
pub struct CreateTournament<'info> {
	#[account(
		seeds = [CONFIG_SEED],
		bump = config.bump,
		has_one = authority @ FeaturesError::Unauthorized,
	)]
	pub config: Account<'info, FeaturesConfig>,
	pub authority: Signer<'info>,
	#[account(
		init,
		payer = authority,
		space = 8 + Tournament::INIT_SPACE,
		seeds = [TOURNAMENT_SEED, &tournament_id.to_be_bytes()],
		bump,
	)]
	pub tournament: Account<'info, Tournament>,
	pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(tournament_id: u64)]
pub struct Register<'info> {
	#[account(
		seeds = [CONFIG_SEED],
		bump = config.bump,
	)]
	pub config: Account<'info, FeaturesConfig>,
	#[account(
		mut,
		seeds = [TOURNAMENT_SEED, &tournament_id.to_be_bytes()],
		bump = tournament.bump,
	)]
	pub tournament: Account<'info, Tournament>,
	#[account(
		init,
		payer = player,
		space = 8 + Registration::INIT_SPACE,
		seeds = [REGISTRATION_SEED, &tournament_id.to_be_bytes(), player.key().as_ref()],
		bump,
	)]
	pub registration: Account<'info, Registration>,
	#[account(mut)]
	pub player: Signer<'info>,
	pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(tournament_id: u64)]
pub struct CancelRegistration<'info> {
	#[account(
		mut,
		seeds = [TOURNAMENT_SEED, &tournament_id.to_be_bytes()],
		bump = tournament.bump,
	)]
	pub tournament: Account<'info, Tournament>,
	#[account(
		mut,
		seeds = [REGISTRATION_SEED, &tournament_id.to_be_bytes(), player.key().as_ref()],
		bump = registration.bump,
		has_one = player @ FeaturesError::Unauthorized,
	)]
	pub registration: Account<'info, Registration>,
	pub player: Signer<'info>,
}

// -------------------------------------------------------------------- events

#[event]
pub struct FeaturesInitialized {
	pub authority: Pubkey,
}

#[event]
pub struct RegistryCreated {
	pub player: Pubkey,
}

#[event]
pub struct AchievementRecorded {
	pub player: Pubkey,
	pub achievement_id: u32,
	pub count: u32,
}

#[event]
pub struct BadgeMinted {
	pub player: Pubkey,
	pub achievement_id: u32,
	pub mint: Pubkey,
}

#[event]
pub struct LeaderboardPublished {
	pub epoch_id: u64,
	pub entry_count: u32,
}

#[event]
pub struct TournamentCreated {
	pub tournament_id: u64,
	pub starts_at: i64,
	pub ends_at: i64,
	pub capacity: u32,
}

#[event]
pub struct Registered {
	pub tournament_id: u64,
	pub player: Pubkey,
	pub registered: u32,
}

#[event]
pub struct RegistrationCancelled {
	pub tournament_id: u64,
	pub player: Pubkey,
}

#[event]
pub struct FeaturesPauseChanged {
	pub paused: bool,
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
pub enum FeaturesError {
	#[msg("signer is not the configured operator authority")]
	Unauthorized,
	#[msg("program is paused; player actions are temporarily disabled")]
	Paused,
	#[msg("invalid authority")]
	InvalidAuthority,
	#[msg("no pending authority")]
	NoPendingAuthority,
	#[msg("timelock not expired (48h)")]
	TimelockNotExpired,
	#[msg("achievement id must be below the bitmap size")]
	AchievementIdOutOfRange,
	#[msg("achievement has not been recorded for this player")]
	AchievementNotRecorded,
	#[msg("leaderboard must have 1..=MAX_LEADERBOARD_ENTRIES entries")]
	LeaderboardLength,
	#[msg("tournament end must be after its start")]
	TournamentInvalidWindow,
	#[msg("tournament capacity must be within 1..=MAX_TOURNAMENT_CAPACITY")]
	TournamentInvalidCapacity,
	#[msg("tournament registration window has not started")]
	TournamentNotStarted,
	#[msg("tournament registration window has ended")]
	TournamentAlreadyOver,
	#[msg("tournament is full")]
	TournamentFull,
	#[msg("registration is not active")]
	RegistrationNotActive,
	#[msg("insufficient player lamports: anti-sybil minimum balance required")]
	InsufficientPlayerBalance,
	#[msg("arithmetic overflow")]
	Overflow,
}

// ---------------------------------------------------------------- unit tests
// Pure logic, runnable with `cargo test -p neonrelay-features` on a connected
// machine (BL-03: no Rust toolchain in the sandbox).

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn bitmap_words_cover_the_id_space() {
		assert_eq!(ACHIEVEMENT_BITS, 4 * 64);
		for id in [0u32, 1, 63, 64, 127, 128, 255] {
			let word = (id / 64) as usize;
			let bit = 1u64 << (id % 64);
			assert!(word < 4);
			assert!(bit != 0);
		}
	}

	#[test]
	fn registry_len_fits_the_struct() {
		// discriminator + player + bits(4*u64) + count + bump
		assert_eq!(AchievementRegistry::LEN, 8 + 32 + 32 + 4 + 1);
	}
}
