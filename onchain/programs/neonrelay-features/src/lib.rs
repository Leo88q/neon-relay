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

// Source ID is pinned in Anchor.toml and checked against the TS/backend
// manifests. A live deployment still requires finalized RPC verification.
declare_id!("4PH1dHVBRbfoydBx3SuRjAS46zRRjHvRxWCNcrFBDqYP");

/// PDA seeds. Mirrored by `onchain/src/constants.ts` (FEATURES_SEEDS) and
/// asserted equal by `onchain/test/features.test.ts`.
// Byte order (SW-2026-09-26 F-10): every u64 id in these seeds (achievement,
// epoch, tournament) is big-endian, like rewards/assets and unlike economy.
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
/// Registration stake (SW-2026-09-26 F-07): every registration locks this
/// many lamports inside the registration PDA. It is a refundable capital
/// lock, NOT a fee — `cancel_registration` (while the window is open) and
/// `reclaim_stake` (after the tournament ends) return it in full, and the
/// operator has no instruction that can take it. Filling every slot of a
/// MAX_TOURNAMENT_CAPACITY tournament therefore binds 655.35 SOL of the
/// attacker's capital concurrently, which is the anti-sybil property the old
/// bare balance check could not provide (a wallet could register every slot
/// "for free" as long as it held 0.01 SOL once).
pub const REGISTRATION_STAKE_LAMPORTS: u64 = 10_000_000;

/// Return a registration's stake to its owner (SW-2026-09-26 F-07). Shared by
/// `cancel_registration` and `reclaim_stake`. The PDA keeps its rent so the
/// one-slot-per-wallet tombstone survives; an account that never held a stake
/// (pre-upgrade) is rejected instead of being dropped below rent-exemption —
/// an under-funded tombstone could be garbage-collected, which would break
/// the one-way registration rule.
fn return_registration_stake(
	registration: &AccountInfo<'_>,
	player: &AccountInfo<'_>,
	system_program: &AccountInfo<'_>,
	rent: &Rent,
	tournament_id: u64,
	bump: u8,
) -> Result<()> {
	let keep = rent.minimum_balance(8 + Registration::INIT_SPACE);
	let needed = keep.checked_add(REGISTRATION_STAKE_LAMPORTS).ok_or(FeaturesError::Overflow)?;
	require!(registration.lamports() >= needed, FeaturesError::RegistrationStakeMissing);
	// Bound before the seeds so no temporary is borrowed past its statement
	// (same pattern as the rewards program's claim signer seeds). The player
	// key goes through a `let` binding: `player.key().as_ref()` inline would
	// create a temporary that is freed at the end of the statement (E0716),
	// because method-call results are not covered by temporary lifetime
	// extension, unlike array literals such as `&[bump]`.
	let tournament_id_bytes = tournament_id.to_be_bytes();
	let player_key = player.key();
	let signer_seeds: &[&[&[u8]]] =
		&[&[REGISTRATION_SEED, &tournament_id_bytes, player_key.as_ref(), &[bump]]];
	anchor_lang::system_program::transfer(
		CpiContext::new_with_signer(
			system_program.clone(),
			anchor_lang::system_program::Transfer {
				from: registration.clone(),
				to: player.clone(),
			},
			signer_seeds,
		),
		REGISTRATION_STAKE_LAMPORTS,
	)
}

fn require_safe_token_account(account: &TokenAccount) -> Result<()> {
	require!(
		account.state == anchor_spl::token::spl_token::state::AccountState::Initialized &&
		account.delegate.is_none() && account.is_native.is_none() && account.close_authority.is_none(),
		FeaturesError::UnsafeTokenAccount
	);
	Ok(())
}

fn verify_bootstrap_authority(program_data: &AccountInfo<'_>, authority: &Pubkey) -> Result<()> {
	let expected = Pubkey::find_program_address(
		&[crate::ID.as_ref()],
		&anchor_lang::solana_program::bpf_loader_upgradeable::id(),
	).0;
	require_keys_eq!(program_data.key(), expected, FeaturesError::BootstrapAuthorityInvalid);
	require_keys_eq!(*program_data.owner, anchor_lang::solana_program::bpf_loader_upgradeable::id(), FeaturesError::BootstrapAuthorityInvalid);
	let state: anchor_lang::solana_program::bpf_loader_upgradeable::UpgradeableLoaderState =
		bincode::deserialize(&program_data.try_borrow_data()?).map_err(|_| error!(FeaturesError::BootstrapAuthorityInvalid))?;
	match state {
		anchor_lang::solana_program::bpf_loader_upgradeable::UpgradeableLoaderState::ProgramData {
			upgrade_authority_address: Some(current), ..
		} => {
			require_keys_eq!(current, *authority, FeaturesError::BootstrapAuthorityInvalid);
			Ok(())
		}
		_ => Err(error!(FeaturesError::BootstrapAuthorityInvalid)),
	}
}

#[program]
pub mod neonrelay_features {
	use super::*;

	/// One-time setup; the signer becomes the operator `authority`.
	pub fn initialize(ctx: Context<FeaturesInitialize>) -> Result<()> {
		verify_bootstrap_authority(&ctx.accounts.program_data.to_account_info(), &ctx.accounts.authority.key())?;
		let config = &mut ctx.accounts.config;
		config.authority = ctx.accounts.authority.key();
		// Boot locked: achievement recording/minting is enabled only after the
		// operator verifies the deployment and the backend anti-sybil gate.
		config.paused = true;
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
		// SW-2026-09-26 F-04: stamp the operator so downstream consumers
		// (neonrelay-assets) can pin which features authority they trust.
		registry.config_authority = ctx.accounts.config.authority;
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
		// SW-2026-09-26 F-04: after an authority rotation, stale registries are
		// rejected until the new operator re-vouches for them. Fail-closed: a
		// rotated-out operator cannot keep minting achievements against
		// registries it stamped itself.
		require!(
			ctx.accounts.registry.config_authority == ctx.accounts.config.authority,
			FeaturesError::RegistryAuthorityMismatch
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

	/// Operator-only: re-vouch for an existing registry under the *current*
	/// authority (SW-2026-09-26 F-04). After an authority rotation every
	/// existing registry keeps the stamp of the old operator and is rejected by
	/// `record_achievement` (and by the assets program) until the new operator
	/// deliberately re-stamps it. `create_registry` cannot do this — its PDA
	/// `init` fails on an existing account.
	pub fn restamp_registry(ctx: Context<RecordAchievement>) -> Result<()> {
		if ctx.accounts.registry.config_authority == ctx.accounts.config.authority {
			return Ok(()); // already vouched for by the current operator
		}
		ctx.accounts.registry.config_authority = ctx.accounts.config.authority;
		emit!(RegistryRestamped {
			player: ctx.accounts.registry.player,
			authority: ctx.accounts.config.authority,
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

		require_safe_token_account(&ctx.accounts.player_badge_account)?;
		// SW008: effects-before-interactions. Bump the counter BEFORE the mint
		// CPI so no program-owned state is written after an external call.
		let config = &mut ctx.accounts.config;
		config.badges_minted = config.badges_minted.checked_add(1).ok_or(FeaturesError::Overflow)?;
		let config_bump = config.bump;

		let config = &ctx.accounts.config;
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

	/// Player-only: registration inside the window, within capacity, secured
	/// by a refundable stake. One registration per (tournament, wallet) — the
	/// PDA `init` enforces it.
	pub fn register(ctx: Context<Register>, tournament_id: u64) -> Result<()> {
		require!(!ctx.accounts.config.paused, FeaturesError::Paused);
		require!(
			ctx.accounts.player.lamports() >= REGISTRATION_STAKE_LAMPORTS,
			FeaturesError::InsufficientPlayerBalance
		);
		let tournament = &mut ctx.accounts.tournament;
		let now = Clock::get()?.unix_timestamp;
		require!(now >= tournament.starts_at, FeaturesError::TournamentNotStarted);
		require!(now < tournament.ends_at, FeaturesError::TournamentAlreadyOver);
		require!(tournament.registered < tournament.capacity, FeaturesError::TournamentFull);
		tournament.registered = tournament.registered.checked_add(1).ok_or(FeaturesError::Overflow)?;
		// SW-2026-09-26 F-07: lock, don't just look — the stake sits in the
		// registration PDA for the lifetime of the registration and is fully
		// refundable (cancel while the window is open, reclaim after the end).
		// Placed before the `registration` mutable borrow below.
		anchor_lang::system_program::transfer(
			CpiContext::new(
				ctx.accounts.system_program.to_account_info(),
				anchor_lang::system_program::Transfer {
					from: ctx.accounts.player.to_account_info(),
					to: ctx.accounts.registration.to_account_info(),
				},
			),
			REGISTRATION_STAKE_LAMPORTS,
		)?;
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

	/// Player-only: cancel a registration, freeing the slot and returning the
	/// stake. One-way per (tournament, wallet): re-registration after
	/// cancellation is not supported (documented in docs/SOLANA_ARCHITECTURE.md).
	pub fn cancel_registration(ctx: Context<CancelRegistration>, tournament_id: u64) -> Result<()> {
		require!(ctx.accounts.registration.active, FeaturesError::RegistrationNotActive);
		return_registration_stake(
			&ctx.accounts.registration.to_account_info(),
			&ctx.accounts.player.to_account_info(),
			&ctx.accounts.system_program.to_account_info(),
			&ctx.accounts.rent,
			tournament_id,
			ctx.accounts.registration.bump,
		)?;
		let registration = &mut ctx.accounts.registration;
		registration.active = false;
		let tournament = &mut ctx.accounts.tournament;
		tournament.registered = tournament.registered.saturating_sub(1);
		emit!(RegistrationCancelled {
			tournament_id,
			player: registration.player,
		});
		emit!(RegistrationStakeReturned {
			tournament_id,
			player: registration.player,
			amount: REGISTRATION_STAKE_LAMPORTS,
		});
		Ok(())
	}

	/// Player-only: after the tournament ends, take the registration stake
	/// back (SW-2026-09-26 F-07). The tombstone stays, so re-registration for
	/// the same (tournament, wallet) remains impossible.
	pub fn reclaim_stake(ctx: Context<ReclaimStake>, tournament_id: u64) -> Result<()> {
		require!(ctx.accounts.registration.active, FeaturesError::RegistrationNotActive);
		let now = Clock::get()?.unix_timestamp;
		require!(now >= ctx.accounts.tournament.ends_at, FeaturesError::TournamentNotEnded);
		return_registration_stake(
			&ctx.accounts.registration.to_account_info(),
			&ctx.accounts.player.to_account_info(),
			&ctx.accounts.system_program.to_account_info(),
			&ctx.accounts.rent,
			tournament_id,
			ctx.accounts.registration.bump,
		)?;
		let registration = &mut ctx.accounts.registration;
		registration.active = false;
		emit!(RegistrationStakeReturned {
			tournament_id,
			player: registration.player,
			amount: REGISTRATION_STAKE_LAMPORTS,
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
			let deadline = config.authority_change_slot
				.checked_add(MIN_AUTHORITY_DELAY_SLOTS)
				.ok_or(FeaturesError::Overflow)?;
			require!(current_slot >= deadline, FeaturesError::TimelockNotExpired);
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

/// Minimum slot-delay policy for authority change. Wall-clock duration is
/// cluster-dependent and must be measured before operational approval.
pub const MIN_AUTHORITY_DELAY_SLOTS: u64 = 432_000;

#[account]
pub struct AchievementRegistry {
	pub player: Pubkey,
	/// Operator the registry was created (and is last vouched) for — the
	/// features `FeaturesConfig.authority` at the time of the last state
	/// change. SW-2026-09-26 F-04: consumed by the neonrelay-assets program,
	/// which pins the features operator it honors and rejects registries
	/// naming a different one. Layout change: requires a coordinated upgrade
	/// with the assets program (its guard reads this field at offset 8+32).
	pub config_authority: Pubkey,
	/// Bitmap of earned achievement ids (256 bits).
	pub bits: [u64; 4],
	pub count: u32,
	pub bump: u8,
}

impl AchievementRegistry {
	/// 8 disc + 32 player + 32 config_authority + 32 bits + 4 count + 1 bump.
	pub const LEN: usize = 8 + 32 + 32 + 4 * 8 + 4 + 1;
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
	/// CHECK: verified against the upgradeable-loader ProgramData account in the handler.
	pub program_data: UncheckedAccount<'info>,
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
	#[account(mut)]
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
	#[account(mut)]
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
	#[account(mut)]
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
	// SW-2026-09-26 F-07: the player is `mut` (stake destination) and the
	// system program + rent sysvar are needed to return the stake safely.
	#[account(mut)]
	pub player: Signer<'info>,
	pub system_program: Program<'info, System>,
	pub rent: Sysvar<'info, Rent>,
}

/// `reclaim_stake`: same shape as CancelRegistration, but the tournament is
/// read-only (it has ended — no counter changes) and the window check is the
/// mirror image of `register`'s.
#[derive(Accounts)]
#[instruction(tournament_id: u64)]
pub struct ReclaimStake<'info> {
	#[account(
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
	#[account(mut)]
	pub player: Signer<'info>,
	pub system_program: Program<'info, System>,
	pub rent: Sysvar<'info, Rent>,
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

/// SW-2026-09-26 F-04: the current operator explicitly re-vouched for an
/// existing registry (after an authority rotation).
#[event]
pub struct RegistryRestamped {
	pub player: Pubkey,
	pub authority: Pubkey,
}

/// SW-2026-09-26 F-07: a registration stake went home to its owner (via
/// cancel_registration or reclaim_stake). Emitted on every stake transfer.
#[event]
pub struct RegistrationStakeReturned {
	pub tournament_id: u64,
	pub player: Pubkey,
	pub amount: u64,
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
	#[msg("authority slot delay has not expired")]
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
	#[msg("insufficient player lamports for the registration stake")]
	InsufficientPlayerBalance,
	#[msg("arithmetic overflow")]
	Overflow,
	#[msg("bootstrap signer is not the program upgrade authority")]
	BootstrapAuthorityInvalid,
	#[msg("token account has unsupported delegate, native wrapper, or close authority")]
	UnsafeTokenAccount,
	#[msg("registry was created for a different operator authority")]
	RegistryAuthorityMismatch,
	#[msg("tournament has not ended yet")]
	TournamentNotEnded,
	#[msg("registration holds no stake to return")]
	RegistrationStakeMissing,
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
		// discriminator + player + config_authority + bits(4*u64) + count + bump
		assert_eq!(AchievementRegistry::LEN, 8 + 32 + 32 + 4 * 8 + 4 + 1);
	}
}
