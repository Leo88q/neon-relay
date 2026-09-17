// Neon Relay on-chain economy program (stage 14).
//
// Pay-to-play economics WITHOUT touching game simulation:
//   * `pay_entry`        — a player pays the configured entry fee (match or
//                          tournament) from their own wallet: rake_bps share
//                          goes to the operator treasury ATA, the rest to the
//                          program-owned prize vault ATA. The payment mints an
//                          idempotent EntryTicket PDA keyed by (reference, player).
//   * `publish_prizes`   — authority publishes ONE Merkle root per epoch over the
//                          top-N prize shares computed off-chain from the
//                          server-authoritative leaderboard (one-way, like rewards).
//   * `claim_prize`      — a ranked player claims their share from the vault via
//                          an indexed Merkle proof; a Claim PDA blocks double claims.
//
// CLUSTER POLICY: devnet only in this repository. The payment mint (SKR on
// mainnet, the Solana Mobile Seeker token) is NOT hardcoded and NOT created
// here: it is passed to `initialize` by the operator and validated off-chain by
// the backend at boot (symbol/decimals over RPC). Devnet runs use a labelled
// throwaway test mint (onchain/scripts/create_test_mint.sh). No private keys
// live in clients or game servers; the vault is program-owned, so Neon Relay
// never custodies player funds.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hashv;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("FZcLDdUrs6i1HYFFK2NhqNrbVaP6KTvrqzhyoDGT6CV9");

const CONFIG_SEED: &[u8] = b"neonrelay_economy_config";
const ENTRY_SEED: &[u8] = b"neonrelay_entry";
const PRIZES_SEED: &[u8] = b"neonrelay_prizes";
const CLAIM_SEED: &[u8] = b"neonrelay_prize_claim";

/// Rake cap in basis points (20%); the deployed default is 1000 = 10%.
pub const MAX_RAKE_BPS: u16 = 2000;
/// Rake denominator (basis points).
pub const RAKE_DENOM: u64 = 10_000;
/// Entry kind: ranked match.
pub const ENTRY_KIND_MATCH: u8 = 0;
/// Entry kind: tournament.
pub const ENTRY_KIND_TOURNAMENT: u8 = 1;
/// Maximum Merkle proof length accepted by `claim_prize`.
pub const MAX_PROOF_LEN: usize = 32;

#[program]
pub mod neonrelay_economy {
	use super::*;

	/// Operator-controlled one-time setup. `mint` is the operator's payment
	/// token (SKR on mainnet); `treasury_ata` must belong to that mint.
	pub fn initialize(
		ctx: Context<Initialize>,
		rake_bps: u16,
		fee_match: u64,
		fee_tournament: u64,
	) -> Result<()> {
		require!(rake_bps <= MAX_RAKE_BPS, EconomyError::InvalidRake);
		require!(fee_match > 0 && fee_tournament > 0, EconomyError::InvalidFee);
		let config = &mut ctx.accounts.config;
		config.authority = ctx.accounts.authority.key();
		config.mint = ctx.accounts.mint.key();
		config.treasury_ata = ctx.accounts.treasury_ata.key();
		config.vault_ata = ctx.accounts.vault_ata.key();
		config.rake_bps = rake_bps;
		config.fee_match = fee_match;
		config.fee_tournament = fee_tournament;
		config.paused = false;
		config.bump = ctx.bumps.config;
		Ok(())
	}

	/// Authority-only fee/rake update (rake stays capped at MAX_RAKE_BPS).
	pub fn set_params(
		ctx: Context<Admin>,
		rake_bps: u16,
		fee_match: u64,
		fee_tournament: u64,
	) -> Result<()> {
		require!(rake_bps <= MAX_RAKE_BPS, EconomyError::InvalidRake);
		require!(fee_match > 0 && fee_tournament > 0, EconomyError::InvalidFee);
		let config = &mut ctx.accounts.config;
		config.rake_bps = rake_bps;
		config.fee_match = fee_match;
		config.fee_tournament = fee_tournament;
		Ok(())
	}

	/// Emergency stop: while paused no new entries can be paid.
	pub fn set_paused(ctx: Context<Admin>, paused: bool) -> Result<()> {
		ctx.accounts.config.paused = paused;
		Ok(())
	}

	/// Player pays the entry fee for `kind` (match/tournament). The fee is
	/// split on-chain: rake -> treasury ATA, remainder -> prize vault ATA.
	/// The (reference, player) ticket PDA makes duplicate payments fail.
	pub fn pay_entry(ctx: Context<PayEntry>, reference: [u8; 32], kind: u8) -> Result<()> {
		let config = &ctx.accounts.config;
		require!(!config.paused, EconomyError::Paused);
		let fee = match kind {
			ENTRY_KIND_MATCH => config.fee_match,
			ENTRY_KIND_TOURNAMENT => config.fee_tournament,
			_ => return Err(EconomyError::InvalidKind.into()),
		};
		let rake = fee
			.checked_mul(u64::from(config.rake_bps))
			.and_then(|v| v.checked_div(RAKE_DENOM))
			.ok_or(EconomyError::Overflow)?;
		let prize = fee.checked_sub(rake).ok_or(EconomyError::Overflow)?;

		let ticket = &mut ctx.accounts.ticket;
		ticket.player = ctx.accounts.player.key();
		ticket.reference = reference;
		ticket.kind = kind;
		ticket.amount = fee;
		ticket.paid_at = Clock::get()?.unix_timestamp;
		ticket.bump = ctx.bumps.ticket;

		let token_program = &ctx.accounts.token_program;
		let player_info = ctx.accounts.player.to_account_info();
		let from_info = ctx.accounts.player_ata.to_account_info();
		if rake > 0 {
			token::transfer(
				CpiContext::new(
					token_program.to_account_info(),
					Transfer {
						from: from_info.clone(),
						to: ctx.accounts.treasury_ata.to_account_info(),
						authority: player_info.clone(),
					},
				),
				rake,
			)?;
		}
		if prize > 0 {
			token::transfer(
				CpiContext::new(
					token_program.to_account_info(),
					Transfer {
						from: from_info,
						to: ctx.accounts.vault_ata.to_account_info(),
						authority: player_info,
					},
				),
				prize,
			)?;
		}
		Ok(())
	}

	/// Authority publishes the epoch prize distribution root (one-way).
	/// `total` must be covered by the vault balance at publication time.
	pub fn publish_prizes(
		ctx: Context<PublishPrizes>,
		epoch: u64,
		root: [u8; 32],
		total: u64,
	) -> Result<()> {
		require!(total > 0, EconomyError::InvalidTotal);
		require!(
			ctx.accounts.vault_ata.amount >= total,
			EconomyError::VaultUnderfunded
		);
		let prizes = &mut ctx.accounts.prizes;
		prizes.epoch = epoch;
		prizes.root = root;
		prizes.total = total;
		prizes.published_at = Clock::get()?.unix_timestamp;
		prizes.bump = ctx.bumps.prizes;
		Ok(())
	}

	/// Player claims their epoch share from the vault. Indexed Merkle proof,
	/// leaf = SHA256(wallet || amount_be) — identical to the rewards program.
	pub fn claim_prize(
		ctx: Context<ClaimPrize>,
		epoch: u64,
		amount: u64,
		leaf_index: u32,
		proof: Vec<[u8; 32]>,
	) -> Result<()> {
		require!(amount > 0, EconomyError::ZeroAmount);
		require!(proof.len() <= MAX_PROOF_LEN, EconomyError::ProofTooLong);
		let prizes = &ctx.accounts.prizes;
		require!(prizes.epoch == epoch, EconomyError::EpochMismatch);
		let leaf = merkle_leaf(&ctx.accounts.player.key().to_bytes(), amount);
		require!(
			verify_proof_indexed(&leaf, leaf_index, &proof, &prizes.root),
			EconomyError::ProofInvalid
		);

		let claim = &mut ctx.accounts.claim;
		claim.epoch = epoch;
		claim.player = ctx.accounts.player.key();
		claim.amount = amount;
		claim.claimed_at = Clock::get()?.unix_timestamp;
		claim.bump = ctx.bumps.claim;

		let config = &ctx.accounts.config;
		let signer_seeds: &[&[&[u8]]] = &[&[CONFIG_SEED, &[config.bump]]];
		token::transfer(
			CpiContext::new_with_signer(
				ctx.accounts.token_program.to_account_info(),
				Transfer {
					from: ctx.accounts.vault_ata.to_account_info(),
					to: ctx.accounts.player_ata.to_account_info(),
					authority: config.to_account_info(),
				},
				signer_seeds,
			),
			amount,
		)
	}
}

// -------------------------------------------------------------------- accounts

#[derive(Accounts)]
pub struct Initialize<'info> {
	#[account(mut)]
	pub authority: Signer<'info>,
	#[account(
		init,
		payer = authority,
		space = 8 + EconomyConfig::INIT_SPACE,
		seeds = [CONFIG_SEED],
		bump,
	)]
	pub config: Account<'info, EconomyConfig>,
	/// Operator-chosen payment mint (SKR on mainnet). Not hardcoded anywhere.
	pub mint: Account<'info, Mint>,
	#[account(
		constraint = treasury_ata.mint == mint.key() @ EconomyError::InvalidTreasuryMint,
	)]
	pub treasury_ata: Account<'info, TokenAccount>,
	#[account(
		init,
		payer = authority,
		associated_token::mint = mint,
		associated_token::authority = config,
	)]
	pub vault_ata: Account<'info, TokenAccount>,
	pub token_program: Program<'info, Token>,
	pub system_program: Program<'info, System>,
	pub associated_token_program: Program<'info, anchor_spl::associated_token::AssociatedToken>,
}

#[derive(Accounts)]
pub struct Admin<'info> {
	#[account(
		constraint = authority.key() == config.authority @ EconomyError::Unauthorized,
	)]
	pub authority: Signer<'info>,
	#[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
	pub config: Account<'info, EconomyConfig>,
}

#[derive(Accounts)]
#[instruction(reference: [u8; 32], kind: u8)]
pub struct PayEntry<'info> {
	#[account(mut)]
	pub player: Signer<'info>,
	#[account(
		mut,
		constraint = player_ata.mint == config.mint @ EconomyError::WrongMint,
		constraint = player_ata.authority == player.key() @ EconomyError::NotPlayerAta,
	)]
	pub player_ata: Account<'info, TokenAccount>,
	#[account(seeds = [CONFIG_SEED], bump = config.bump)]
	pub config: Account<'info, EconomyConfig>,
	#[account(
		mut,
		constraint = vault_ata.key() == config.vault_ata @ EconomyError::WrongVault,
	)]
	pub vault_ata: Account<'info, TokenAccount>,
	#[account(
		mut,
		constraint = treasury_ata.key() == config.treasury_ata @ EconomyError::WrongTreasury,
	)]
	pub treasury_ata: Account<'info, TokenAccount>,
	#[account(
		init,
		payer = player,
		space = 8 + EntryTicket::INIT_SPACE,
		seeds = [ENTRY_SEED, reference.as_ref(), player.key().as_ref()],
		bump,
	)]
	pub ticket: Account<'info, EntryTicket>,
	pub token_program: Program<'info, Token>,
	pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(epoch: u64)]
pub struct PublishPrizes<'info> {
	#[account(
		constraint = authority.key() == config.authority @ EconomyError::Unauthorized,
	)]
	pub authority: Signer<'info>,
	#[account(seeds = [CONFIG_SEED], bump = config.bump)]
	pub config: Account<'info, EconomyConfig>,
	#[account(
		constraint = vault_ata.key() == config.vault_ata @ EconomyError::WrongVault,
	)]
	pub vault_ata: Account<'info, TokenAccount>,
	#[account(
		init,
		payer = authority,
		space = 8 + PrizeEpoch::INIT_SPACE,
		seeds = [PRIZES_SEED, epoch.to_le_bytes().as_ref()],
		bump,
	)]
	pub prizes: Account<'info, PrizeEpoch>,
	pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(epoch: u64)]
pub struct ClaimPrize<'info> {
	#[account(mut)]
	pub player: Signer<'info>,
	#[account(
		mut,
		constraint = player_ata.mint == config.mint @ EconomyError::WrongMint,
		constraint = player_ata.authority == player.key() @ EconomyError::NotPlayerAta,
	)]
	pub player_ata: Account<'info, TokenAccount>,
	#[account(seeds = [CONFIG_SEED], bump = config.bump)]
	pub config: Account<'info, EconomyConfig>,
	#[account(
		mut,
		constraint = vault_ata.key() == config.vault_ata @ EconomyError::WrongVault,
	)]
	pub vault_ata: Account<'info, TokenAccount>,
	#[account(
		seeds = [PRIZES_SEED, epoch.to_le_bytes().as_ref()],
		bump = prizes.bump,
	)]
	pub prizes: Account<'info, PrizeEpoch>,
	#[account(
		init,
		payer = player,
		space = 8 + PrizeClaim::INIT_SPACE,
		seeds = [CLAIM_SEED, epoch.to_le_bytes().as_ref(), player.key().as_ref()],
		bump,
	)]
	pub claim: Account<'info, PrizeClaim>,
	pub token_program: Program<'info, Token>,
	pub system_program: Program<'info, System>,
}

// -------------------------------------------------------------------- state

#[account]
#[derive(InitSpace)]
pub struct EconomyConfig {
	pub authority: Pubkey,
	pub mint: Pubkey,
	pub treasury_ata: Pubkey,
	pub vault_ata: Pubkey,
	pub rake_bps: u16,
	pub fee_match: u64,
	pub fee_tournament: u64,
	pub paused: bool,
	pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct EntryTicket {
	pub player: Pubkey,
	pub reference: [u8; 32],
	pub kind: u8,
	pub amount: u64,
	pub paid_at: i64,
	pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct PrizeEpoch {
	pub epoch: u64,
	pub root: [u8; 32],
	pub total: u64,
	pub published_at: i64,
	pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct PrizeClaim {
	pub epoch: u64,
	pub player: Pubkey,
	pub amount: u64,
	pub claimed_at: i64,
	pub bump: u8,
}

// -------------------------------------------------------------------- merkle

/// leaf = SHA256(wallet_pubkey(32) || amount as u64be) — byte-identical to the
/// rewards program, backend `leafHash()` and onchain/src/merkle.ts.
pub fn merkle_leaf(wallet: &[u8; 32], amount: u64) -> [u8; 32] {
	hashv(&[wallet, &amount.to_be_bytes()]).to_bytes()
}

/// Indexed proof fold — even index ⇒ current on the left (same rule as the
/// rewards program and backend `verifyProofIndexed()`).
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

// -------------------------------------------------------------------- errors

#[error_code]
pub enum EconomyError {
	InvalidRake,
	InvalidFee,
	InvalidKind,
	InvalidTreasuryMint,
	Unauthorized,
	Paused,
	Overflow,
	WrongMint,
	NotPlayerAta,
	WrongVault,
	WrongTreasury,
	InvalidTotal,
	VaultUnderfunded,
	ZeroAmount,
	ProofTooLong,
	ProofInvalid,
	EpochMismatch,
}
