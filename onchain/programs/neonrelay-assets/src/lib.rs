//! Neon Relay assets — source-hardened, production-gated asset paths.
//!
//! The verified default build exposes a bounded internal collection descriptor
//! and a classic-SPL 0-decimal fallback. External MPL-Core/Bubblegum CPI is
//! compile-time disabled until upstream ABI/account metas and validator tests
//! are pinned. `mint_badge_compressed` therefore fails closed with
//! `AssetPathNotConfigured`; no live compressed-mint capability is claimed.
//!
//! Model: the chain stores asset/reward metadata and bounded proofs; game
//! simulation remains off-chain. Classic-SPL layout checks reject Token-2022
//! extensions, and authority changes use a slot-delay policy with pause gates;
//! wall-clock duration is cluster-dependent and unverified here.
//! The complete source checklist is in `docs/ASSETS_SECURITY_AUDIT_CHECKLIST.md`.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hashv;
use anchor_spl::token::{self, Mint, Token, TokenAccount, MintTo};

// These flags are reserved for a future release with pinned upstream ABI
// crates, account metas, and validator coverage. Refuse an accidental
// "enabled" build rather than shipping the raw-instruction sketch below as
// a production CPI implementation.
#[cfg(feature = "core")]
compile_error!("assets core CPI is not production-pinned; build without feature core");
#[cfg(feature = "bubblegum")]
compile_error!("assets Bubblegum CPI is not production-pinned; build without feature bubblegum");

// Placeholder — заменить `anchor keys list` перед деплоем (Anchor.toml + constants.ts).
declare_id!("F5VhZxGGEY61TNNexRwJVomMZtHeAZodqVHPMqoxq3oc");

/// PDA seeds — зеркалятся в `onchain/src/constants.ts` (ASSETS_SEEDS) и чекаются в `test/assets.test.ts`.
// Byte order (SW-2026-09-26 F-10): the badge id enters the badge seed as a
// u32 in big-endian order, like rewards/features and unlike economy.
pub const CONFIG_SEED: &[u8] = b"neonrelay_assets_config";
pub const COLLECTION_SEED: &[u8] = b"neonrelay_collection";
pub const BADGE_SEED: &[u8] = b"neonrelay_badge_asset";
pub const TREE_CONFIG_SEED: &[u8] = b"neonrelay_tree_config";

/// Лимиты (продакшн).
pub const MAX_COLLECTION_NAME: usize = 32;
pub const MAX_COLLECTION_SYMBOL: usize = 10;
pub const MAX_URI_LEN: usize = 200;
pub const MAX_PROOF_LEN: usize = 32;
/// Slot-delay policy for authority changes. The wall-clock duration is
/// cluster-dependent and must be measured separately; this source does not
/// claim that the value equals a fixed number of hours.
pub const MIN_AUTHORITY_DELAY_SLOTS: u64 = 432_000;

/// External program identifiers recorded for the gated adapter; live ownership,
/// ABI compatibility, and deployment are not verified in this checkout.
pub const BUBBLEGUM_PROGRAM_ID: &str = "BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY";
pub const COMPRESSION_PROGRAM_ID: &str = "cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK";
pub const NOOP_PROGRAM_ID: &str = "noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV";
pub const MPL_CORE_PROGRAM_ID: &str = "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d";
/// Features registry program and seed used for the on-chain achievement proof.
pub const FEATURES_PROGRAM_ID: Pubkey = pubkey!("4PH1dHVBRbfoydBx3SuRjAS46zRRjHvRxWCNcrFBDqYP");
pub const FEATURES_ACHIEVEMENTS_SEED: &[u8] = b"neonrelay_achievements";
/// Features config seed — used when the caller also passes the live
/// `FeaturesConfig` account (see `MintBadgeCore`) so the pinned operator can
/// be matched against the features program's *current* authority, not just
/// the one recorded inside the registry.
pub const FEATURES_CONFIG_SEED: &[u8] = b"neonrelay_features_config";

/// Validate the features achievement registry for `player` and the badge bit.
///
/// SW-2026-09-26 F-04: previously the only trust anchors were the registry's
/// PDA derivation, its owner and its discriminator — i.e. "the features
/// program wrote this". That is not enough, because the features and assets
/// programs bootstrap independently: a features authority the assets authority
/// never approved could grant itself achievement bits and mint badges here.
/// Now every caller pins the accepted operator (`expected_features_authority`
/// from `AssetsConfig`), the registry must name that same operator in its
/// `config_authority` field, and when the live features config account is
/// supplied (both `mint_badge_*` paths) it must agree too.
fn require_achievement_registry(
    registry: &AccountInfo<'_>,
    features_config: Option<&AccountInfo<'_>>,
    expected_features_authority: &Pubkey,
    player: &Pubkey,
    badge_id: u32,
) -> Result<()> {
    let expected = Pubkey::find_program_address(
        &[FEATURES_ACHIEVEMENTS_SEED, player.as_ref()],
        &FEATURES_PROGRAM_ID,
    ).0;
    require_keys_eq!(registry.key(), expected, AssetsError::InvalidAchievementRegistry);
    require_keys_eq!(*registry.owner, FEATURES_PROGRAM_ID, AssetsError::InvalidAchievementRegistry);
    let data = registry.try_borrow_data()?;
    let discriminator = hashv(&[b"account:AchievementRegistry"]).to_bytes();
    // 8 disc + 32 player + 32 config_authority + 32 bits (count/bump after).
    require!(data.len() >= 8 + 32 + 64 && data[..8] == discriminator[..8], AssetsError::InvalidAchievementRegistry);
    require!(&data[8..40] == player.as_ref(), AssetsError::InvalidAchievementRegistry);
    // The operator the features program acted for when the bit was recorded.
    let mut recorded_authority = [0u8; 32];
    recorded_authority.copy_from_slice(&data[8 + 32..8 + 64]);
    require!(
        recorded_authority == expected_features_authority.to_bytes(),
        AssetsError::FeatureAuthorityMismatch
    );
    // Stronger form (mint_badge_*): the features program's *current*
    // operator is read straight from its config PDA, so an already-rotated
    // features authority cannot keep minting against stale bits.
    if let Some(config) = features_config {
        let expected_config = Pubkey::find_program_address(
            &[FEATURES_CONFIG_SEED],
            &FEATURES_PROGRAM_ID,
        ).0;
        require_keys_eq!(config.key(), expected_config, AssetsError::FeatureAuthorityMismatch);
        require_keys_eq!(*config.owner, FEATURES_PROGRAM_ID, AssetsError::FeatureAuthorityMismatch);
        let config_data = config.try_borrow_data()?;
        let config_discriminator = hashv(&[b"account:FeaturesConfig"]).to_bytes();
        require!(
            config_data.len() >= 8 + 32 && config_data[..8] == config_discriminator[..8],
            AssetsError::FeatureAuthorityMismatch
        );
        let mut live_authority = [0u8; 32];
        live_authority.copy_from_slice(&config_data[8..40]);
        require!(
            live_authority == recorded_authority,
            AssetsError::FeatureAuthorityMismatch
        );
    }
    let word = usize::try_from(badge_id / 64).map_err(|_| error!(AssetsError::BadgeIdOutOfRange))?;
    let offset = 8 + 32 + 32 + word * 8;
    require!(offset + 8 <= data.len(), AssetsError::InvalidAchievementRegistry);
    let mut bytes = [0u8; 8];
    bytes.copy_from_slice(&data[offset..offset + 8]);
    require!(u64::from_le_bytes(bytes) & (1u64 << (badge_id % 64)) != 0, AssetsError::AchievementNotRecorded);
    Ok(())
}

fn require_safe_token_account(account: &TokenAccount) -> Result<()> {
    require!(
        account.state == anchor_spl::token::spl_token::state::AccountState::Initialized &&
        account.delegate.is_none() && account.is_native.is_none() && account.close_authority.is_none(),
        AssetsError::UnsafeTokenAccount
    );
    Ok(())
}

fn require_program_account(account: &AccountInfo<'_>, expected: Pubkey, error: AssetsError) -> Result<()> {
    let valid = account.key() == expected
        && account.executable
        && *account.owner == anchor_lang::solana_program::bpf_loader_upgradeable::id();
    if !valid {
        return Err(error.into());
    }
    Ok(())
}

fn verify_bootstrap_authority(program_data: &AccountInfo<'_>, authority: &Pubkey) -> Result<()> {
    let expected = Pubkey::find_program_address(
        &[crate::ID.as_ref()],
        &anchor_lang::solana_program::bpf_loader_upgradeable::id(),
    ).0;
    require_keys_eq!(program_data.key(), expected, AssetsError::BootstrapAuthorityInvalid);
    require_keys_eq!(*program_data.owner, anchor_lang::solana_program::bpf_loader_upgradeable::id(), AssetsError::BootstrapAuthorityInvalid);
    let state: anchor_lang::solana_program::bpf_loader_upgradeable::UpgradeableLoaderState =
        bincode::deserialize(&program_data.try_borrow_data()?).map_err(|_| error!(AssetsError::BootstrapAuthorityInvalid))?;
    match state {
        anchor_lang::solana_program::bpf_loader_upgradeable::UpgradeableLoaderState::ProgramData {
            upgrade_authority_address: Some(current), ..
        } => {
            require_keys_eq!(current, *authority, AssetsError::BootstrapAuthorityInvalid);
            Ok(())
        }
        _ => Err(error!(AssetsError::BootstrapAuthorityInvalid)),
    }
}

#[program]
pub mod neonrelay_assets {
    use super::*;

    /// One-time setup. Подписант становится authority. Немедленно паузим до аудита — оператор `set_paused(false)`.
    pub fn initialize(
        ctx: Context<Initialize>,
        features_authority: Pubkey,
    ) -> Result<()> {
        verify_bootstrap_authority(&ctx.accounts.program_data.to_account_info(), &ctx.accounts.authority.key())?;
        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.pending_authority = Pubkey::default();
        config.authority_change_slot = 0;
        config.paused = true; // secure-by-default (#38 checklist)
        config.collections_created = 0;
        config.badges_minted = 0;
        config.compressed_minted = 0;
        // SW-2026-09-26 F-04: the features operator must be pinned explicitly,
        // never inherited from whoever deploys the *other* program. An empty
        // pubkey keeps achievement-gated minting disabled until the authority
        // pins one deliberately.
        config.features_authority = features_authority;
        config.bump = ctx.bumps.config;
        emit!(AssetsInitialized {
            authority: config.authority,
        });
        emit!(FeaturesAuthorityChanged {
            old: Pubkey::default(),
            new: features_authority,
        });
        Ok(())
    }

    /// Create a bounded internal collection descriptor. Authority-only, PDA
    /// init makes a duplicate fail; no MPL Core CPI is attempted in the
    /// verified default build.
    pub fn create_collection(
        ctx: Context<CreateCollection>,
        name: String,
        symbol: String,
        uri: String,
    ) -> Result<()> {
        // The default build records a bounded internal collection descriptor;
        // no external MPL Core CPI is attempted. The optional raw CPI branch
        // below remains compile-time disabled until its ABI is independently
        // pinned and validator-tested.
        require!(!ctx.accounts.config.paused, AssetsError::Paused);
        require!(
            !name.is_empty() && name.len() <= MAX_COLLECTION_NAME,
            AssetsError::InvalidCollectionMeta
        );
        require!(
            !symbol.is_empty() && symbol.len() <= MAX_COLLECTION_SYMBOL,
            AssetsError::InvalidCollectionMeta
        );
        require!(
            !uri.is_empty() && uri.len() <= MAX_URI_LEN,
            AssetsError::InvalidCollectionMeta
        );
        // Защита от type cosplay: проверяем что collection PDA выведен канонически (seeds+bump уже в constraint).
        let collection = &mut ctx.accounts.collection;
        collection.authority = ctx.accounts.config.authority;
        collection.name = name.clone();
        collection.symbol = symbol.clone();
        collection.uri = uri.clone();
        collection.merkle_tree = Pubkey::default(); // заполнится при create_tree
        collection.bump = ctx.bumps.collection;
        collection.created_at = Clock::get()?.unix_timestamp;

        let config = &mut ctx.accounts.config;
        config.collections_created = config
            .collections_created
            .checked_add(1)
            .ok_or(AssetsError::Overflow)?;

        #[cfg(feature = "core")]
        {
            let config_bump = ctx.accounts.config.bump;
            let signer_seeds: &[&[&[u8]]] = &[&[CONFIG_SEED, &[config_bump]]];
            let mut ix_data = vec![0u8; 8];
            ix_data.extend_from_slice(name.as_bytes());
            let core_pubkey = MPL_CORE_PROGRAM_ID.parse::<Pubkey>().unwrap_or_default();
            let ix = anchor_lang::solana_program::instruction::Instruction {
                program_id: core_pubkey,
                accounts: vec![
                    anchor_lang::solana_program::instruction::AccountMeta::new(ctx.accounts.collection.key(), false),
                    anchor_lang::solana_program::instruction::AccountMeta::new_readonly(ctx.accounts.config.key(), true),
                    anchor_lang::solana_program::instruction::AccountMeta::new(ctx.accounts.authority.key(), true),
                    anchor_lang::solana_program::instruction::AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
                ],
                data: ix_data,
            };
            anchor_lang::solana_program::program::invoke_signed(
                &ix,
                &[
                    ctx.accounts.collection.to_account_info(),
                    ctx.accounts.config.to_account_info(),
                    ctx.accounts.authority.to_account_info(),
                    ctx.accounts.system_program.to_account_info(),
                ],
                signer_seeds,
            )?;
        }

        emit!(CollectionCreated {
            collection: collection.key(),
            authority: collection.authority,
            name,
            symbol,
        });
        Ok(())
    }

    /// Reserved Merkle-tree descriptor for compressed badges. Authority-only;
    /// the verified default build is fail-closed until the compression ABI and
    /// validator coverage are pinned.
    pub fn create_tree(
        ctx: Context<CreateTree>,
        max_depth: u32,
        max_buffer_size: u32,
        canopy_depth: u32,
    ) -> Result<()> {
        #[cfg(not(feature = "bubblegum"))]
        return Err(AssetsError::AssetPathNotConfigured.into());
        #[cfg(feature = "bubblegum")]
        require!(!ctx.accounts.config.paused, AssetsError::Paused);
        // Валидация как в Bubblegum: depth 14..30, buffer power-of-two, canopy <= depth.
        require!(
            (14..=30).contains(&max_depth) && canopy_depth <= max_depth,
            AssetsError::InvalidTreeArgs
        );
        require!(
            max_buffer_size.is_power_of_two() && max_buffer_size >= 64,
            AssetsError::InvalidTreeArgs
        );
        // Проверка что tree account принадлежит Compression program (cmtDvXum...) — constraint в контексте.
        // В оффлайн-тесте tree — System-owned PDA; на цепи будет compression-owned.
        let tree_config = &mut ctx.accounts.tree_config;
        tree_config.merkle_tree = ctx.accounts.merkle_tree.key();
        tree_config.authority = ctx.accounts.config.authority;
        tree_config.max_depth = max_depth;
        tree_config.max_buffer_size = max_buffer_size;
        tree_config.canopy_depth = canopy_depth;
        tree_config.bump = ctx.bumps.tree_config;

        // Обновляем коллекцию ссылкой на дерево (если передана).
        if ctx.accounts.collection.key() != Pubkey::default() {
            ctx.accounts.collection.merkle_tree = ctx.accounts.merkle_tree.key();
        }

        emit!(TreeCreated {
            merkle_tree: tree_config.merkle_tree,
            max_depth,
            max_buffer_size,
            canopy_depth,
        });
        Ok(())
    }

    /// Verified fallback: mint a bounded classic SPL 0-decimal badge PDA
    /// with supply 1 and the config PDA as mint authority. CEI updates the
    /// local counter before the token CPI.
    pub fn mint_badge_core(ctx: Context<MintBadgeCore>, badge_id: u32) -> Result<()> {
        require!(!ctx.accounts.config.paused, AssetsError::Paused);
        require!(badge_id < 256, AssetsError::BadgeIdOutOfRange);
        require_safe_token_account(&ctx.accounts.player_badge_account)?;
        require_achievement_registry(
            &ctx.accounts.achievement_registry.to_account_info(),
            Some(&ctx.accounts.features_config.to_account_info()),
            &ctx.accounts.config.features_authority,
            &ctx.accounts.player.key(),
            badge_id,
        )?;

        // The collection must be an assets collection bound to this config.
        require!(
            ctx.accounts.collection.authority == ctx.accounts.config.authority,
            AssetsError::Unauthorized
        );

        // Защита от Token-2022 PermanentDelegate: если mint — Token-2022 с delegate, CPI mint_to может быть перехвачен.
        // Оффлайн чекаем что mint decimals 0 и authority == config PDA (constraint mint::authority = config уже).
        // На цепи дополнительно: если mint.owner == TokenzQd..., проверить что extension PermanentDelegate отсутствует (см. docs чеклист #31).

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
        // CEI: увеличиваем счётчик до CPI (если CPI reenter, счётчик уже инкрементнут — но reentrancy запрещена runtime).
        ctx.accounts.config.badges_minted = ctx
            .accounts
            .config
            .badges_minted
            .checked_add(1)
            .ok_or(AssetsError::Overflow)?;
        token::mint_to(cpi_ctx, 1)?;

        emit!(BadgeMintedCore {
            player: ctx.accounts.player.key(),
            badge_id,
            mint: ctx.accounts.badge_mint.key(),
            collection: ctx.accounts.collection.key(),
        });
        Ok(())
    }

    /// Reserved compressed-badge path. The verified default build is
    /// deliberately fail-closed and returns `AssetPathNotConfigured`; the
    /// Bubblegum ABI/account metas must be pinned and validator-tested before
    /// this instruction can be enabled.
    pub fn mint_badge_compressed(
        ctx: Context<MintBadgeCompressed>,
        badge_id: u32,
        metadata_hash: [u8; 32],
        creator_hash: [u8; 32],
    ) -> Result<()> {
        #[cfg(not(feature = "bubblegum"))]
        return Err(AssetsError::AssetPathNotConfigured.into());
        #[cfg(feature = "bubblegum")]
        require!(!ctx.accounts.config.paused, AssetsError::Paused);
        require!(badge_id < 256, AssetsError::BadgeIdOutOfRange);
        require_achievement_registry(
            &ctx.accounts.achievement_registry.to_account_info(),
            Some(&ctx.accounts.features_config.to_account_info()),
            &ctx.accounts.config.features_authority,
            &ctx.accounts.player.key(),
            badge_id,
        )?;
        require!(
            ctx.accounts.collection.authority == ctx.accounts.config.authority,
            AssetsError::Unauthorized
        );
        // Проверка external program ids and executable program accounts (защита от arbitrary CPI #9).
        let bubblegum_program = BUBBLEGUM_PROGRAM_ID.parse::<Pubkey>().map_err(|_| error!(AssetsError::InvalidBubblegumProgram))?;
        let compression_program = COMPRESSION_PROGRAM_ID.parse::<Pubkey>().map_err(|_| error!(AssetsError::InvalidCompressionProgram))?;
        let noop_program = NOOP_PROGRAM_ID.parse::<Pubkey>().map_err(|_| error!(AssetsError::InvalidNoopProgram))?;
        require_program_account(&ctx.accounts.bubblegum_program.to_account_info(), bubblegum_program, AssetsError::InvalidBubblegumProgram)?;
        require_program_account(&ctx.accounts.compression_program.to_account_info(), compression_program, AssetsError::InvalidCompressionProgram)?;
        require_program_account(&ctx.accounts.noop_program.to_account_info(), noop_program, AssetsError::InvalidNoopProgram)?;
        require_keys_eq!(*ctx.accounts.merkle_tree.owner, compression_program, AssetsError::InvalidTreeOwner);
        require!(!ctx.accounts.merkle_tree.executable && !ctx.accounts.merkle_tree.data_is_empty(), AssetsError::InvalidTreeOwner);
        require!(ctx.accounts.tree_config.merkle_tree == ctx.accounts.merkle_tree.key(), AssetsError::TreeMismatch);
        require!(ctx.accounts.tree_config.authority == ctx.accounts.config.authority, AssetsError::Unauthorized);
        // Tree должен быть тем же что в collection (если коллекция указана).
        if ctx.accounts.collection.merkle_tree != Pubkey::default() {
            require!(
                ctx.accounts.collection.merkle_tree == ctx.accounts.merkle_tree.key(),
                AssetsError::TreeMismatch
            );
        }

        // Формируем leaf hash как в Bubblegum LeafSchemaV2:
        // leaf = hash(id, owner, delegate, nonce, data_hash, creator_hash, collection_hash, asset_data_hash, flags)
        // Упрощённо для аудита: leaf = SHA256(player || badge_id BE || metadata_hash || creator_hash)
        let leaf = hashv(&[
            ctx.accounts.player.key().as_ref(),
            &badge_id.to_be_bytes(),
            &metadata_hash,
            &creator_hash,
        ])
        .to_bytes();
        let receipt = &mut ctx.accounts.receipt;
        receipt.player = ctx.accounts.player.key();
        receipt.badge_id = badge_id;
        receipt.minted_at = Clock::get()?.unix_timestamp;
        receipt.bump = ctx.bumps.receipt;

        // CEI: инкремент до CPI
        ctx.accounts.config.compressed_minted = ctx
            .accounts
            .config
            .compressed_minted
            .checked_add(1)
            .ok_or(AssetsError::Overflow)?;

        // CPI в Bubblegum mint_v1
        let config_bump = ctx.accounts.config.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[CONFIG_SEED, &[config_bump]]];
        let mut ix_data = vec![145, 98, 192, 118, 184, 147, 118, 104];
        ix_data.extend_from_slice(&badge_id.to_be_bytes());
        ix_data.extend_from_slice(&metadata_hash);
        ix_data.extend_from_slice(&creator_hash);
        let ix = anchor_lang::solana_program::instruction::Instruction {
            program_id: ctx.accounts.bubblegum_program.key(),
            accounts: vec![
                anchor_lang::solana_program::instruction::AccountMeta::new(ctx.accounts.tree_config.key(), false),
                anchor_lang::solana_program::instruction::AccountMeta::new(ctx.accounts.merkle_tree.key(), false),
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(ctx.accounts.config.key(), true),
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(ctx.accounts.player.key(), false),
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(ctx.accounts.noop_program.key(), false),
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(ctx.accounts.compression_program.key(), false),
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
            ],
            data: ix_data,
        };
        #[cfg(feature = "bubblegum")]
        anchor_lang::solana_program::program::invoke_signed(
            &ix,
            &[
                ctx.accounts.tree_config.to_account_info(),
                ctx.accounts.merkle_tree.to_account_info(),
                ctx.accounts.config.to_account_info(),
                ctx.accounts.player.to_account_info(),
                ctx.accounts.noop_program.to_account_info(),
                ctx.accounts.compression_program.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            signer_seeds,
        )?;

        // Проверка что payer не алиасит vault/treasury (если они есть) — не применимо, но оставляем паттерн.
        emit!(BadgeMintedCompressed {
            player: ctx.accounts.player.key(),
            badge_id,
            merkle_tree: ctx.accounts.merkle_tree.key(),
            leaf,
            metadata_hash,
        });
        // Any external indexer visibility and finalization latency remain
        // deployment-specific and are not asserted by this source-level stub.
        Ok(())
    }

    /// Register an immutable classic-SPL mint for fungible accounting.
    /// Token-2022 and extension-bearing mints are rejected until a separate
    /// interface implementation proves fee/delegate semantics. The mint PDA is
    /// not created here; the operator supplies an existing mint.
    pub fn create_token_mint_config(
        ctx: Context<CreateTokenMintConfig>,
        decimals: u8,
        has_transfer_fee: bool,
        has_permanent_delegate: bool,
    ) -> Result<()> {
        require!(!ctx.accounts.config.paused, AssetsError::Paused);
        require!(decimals <= 9, AssetsError::InvalidDecimals);
        // The config is intentionally classic-SPL only. The booleans are
        // operator input, never evidence: inspect the actual account layout so
        // a caller cannot claim that an extension is absent.
        require!(!ctx.accounts.mint.executable, AssetsError::InvalidMint);
        require_keys_eq!(*ctx.accounts.mint.owner, anchor_spl::token::ID, AssetsError::InvalidMint);
        let mint_data = ctx.accounts.mint.try_borrow_data()?;
        require!(mint_data.len() == 82 && mint_data[44] == decimals && mint_data[45] == 1, AssetsError::InvalidMint);
        require!(u32::from_le_bytes(mint_data[0..4].try_into().unwrap()) == 0,
            AssetsError::PermanentDelegateNotAllowed);
        require!(u32::from_le_bytes(mint_data[46..50].try_into().unwrap()) == 0,
            AssetsError::PermanentDelegateNotAllowed);
        // Критично: PermanentDelegate позволяет списать с любого ATA — запрещаем для vault mint.
        require!(!has_permanent_delegate, AssetsError::PermanentDelegateNotAllowed);
        // TransferFee: если есть, бекенд должен учитывать при расчёте prize (fee BPS). Пока reject чтобы не усложнять.
        if has_transfer_fee {
            msg!("TransferFee extension detected — prize accounting must handle fee; currently rejected, use fee-free mint or update accounting");
            return Err(AssetsError::TransferFeeNotSupported.into());
        }
        let mint_config = &mut ctx.accounts.mint_config;
        mint_config.mint = ctx.accounts.mint.key();
        mint_config.decimals = decimals;
        mint_config.authority = ctx.accounts.config.authority;
        mint_config.bump = ctx.bumps.mint_config;
        emit!(TokenMintConfigured {
            mint: mint_config.mint,
            decimals,
        });
        Ok(())
    }

    /// Pause — emergency. Authority-only, immediate (как в rewards/features).
    pub fn set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
        ctx.accounts.config.paused = paused;
        emit!(AssetsPauseChanged { paused });
        Ok(())
    }

    /// SW-2026-09-26 F-04: pin (or re-pin, or clear) the features operator
    /// whose achievement registries this program honors. Authority-only.
    /// Clearing to `Pubkey::default()` fail-closes every achievement-gated
    /// mint path until a new operator is pinned.
    pub fn set_features_authority(
        ctx: Context<AdminOnly>,
        features_authority: Pubkey,
    ) -> Result<()> {
        let old = ctx.accounts.config.features_authority;
        ctx.accounts.config.features_authority = features_authority;
        emit!(FeaturesAuthorityChanged { old, new: features_authority });
        Ok(())
    }

    /// Propose an authority change with the configured slot-delay policy.
    pub fn propose_authority_change(
        ctx: Context<AdminOnly>,
        new_authority: Pubkey,
    ) -> Result<()> {
        require!(
            new_authority != Pubkey::default(),
            AssetsError::InvalidAuthority
        );
        let config = &mut ctx.accounts.config;
        config.pending_authority = new_authority;
        config.authority_change_slot = Clock::get()?.slot;
        emit!(AuthorityChangeProposed {
            current: config.authority,
            pending: new_authority,
            slot: config.authority_change_slot,
        });
        Ok(())
    }

    /// Принять смену authority после MIN_AUTHORITY_DELAY_SLOTS.
    pub fn accept_authority_change(ctx: Context<AcceptAuthority>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        require!(
            config.pending_authority != Pubkey::default(),
            AssetsError::NoPendingAuthority
        );
        let current_slot = Clock::get()?.slot;
        let deadline = config
            .authority_change_slot
            .checked_add(MIN_AUTHORITY_DELAY_SLOTS)
            .ok_or(AssetsError::Overflow)?;
        require!(
            current_slot >= deadline,
            AssetsError::TimelockNotExpired
        );
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
pub struct AssetsConfig {
    pub authority: Pubkey,
    pub pending_authority: Pubkey,
    pub authority_change_slot: u64,
    pub paused: bool,
    pub collections_created: u64,
    pub badges_minted: u64,
    pub compressed_minted: u64,
    /// Operator whose features achievement bits this program honors
    /// (SW-2026-09-26 F-04). Pinned at bootstrap, rotatable by the authority
    /// via `set_features_authority`. `Pubkey::default()` disables all
    /// achievement-gated minting (fail-closed).
    pub features_authority: Pubkey,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Collection {
    pub authority: Pubkey,
    #[max_len(MAX_COLLECTION_NAME)]
    pub name: String,
    #[max_len(MAX_COLLECTION_SYMBOL)]
    pub symbol: String,
    #[max_len(MAX_URI_LEN)]
    pub uri: String,
    pub merkle_tree: Pubkey,
    pub bump: u8,
    pub created_at: i64,
}

#[account]
#[derive(InitSpace)]
pub struct TreeConfig {
    pub merkle_tree: Pubkey,
    pub authority: Pubkey,
    pub max_depth: u32,
    pub max_buffer_size: u32,
    pub canopy_depth: u32,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct MintConfig {
    pub mint: Pubkey,
    pub decimals: u8,
    pub authority: Pubkey,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct BadgeReceipt {
    pub player: Pubkey,
    pub badge_id: u32,
    pub minted_at: i64,
    pub bump: u8,
}

// ------------------------------------------------------------------ contexts

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + AssetsConfig::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, AssetsConfig>,
    pub authority: Signer<'info>,
    /// CHECK: verified against the upgradeable-loader ProgramData account in the handler.
    pub program_data: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ AssetsError::Unauthorized,
    )]
    pub config: Account<'info, AssetsConfig>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = config.pending_authority == pending_authority.key() @ AssetsError::Unauthorized,
    )]
    pub config: Account<'info, AssetsConfig>,
    /// CHECK: новый authority должен подписать принятие (подтверждает владение ключом).
    pub pending_authority: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(name: String, symbol: String, uri: String)]
pub struct CreateCollection<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ AssetsError::Unauthorized,
    )]
    pub config: Account<'info, AssetsConfig>,
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + Collection::INIT_SPACE,
        seeds = [COLLECTION_SEED, name.as_bytes(), authority.key().as_ref()],
        bump,
    )]
    pub collection: Account<'info, Collection>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(max_depth: u32, max_buffer_size: u32, canopy_depth: u32)]
pub struct CreateTree<'info> {
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ AssetsError::Unauthorized,
    )]
    pub config: Account<'info, AssetsConfig>,
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: Merkle tree account — owned by compression program on-chain, System on devnet before init.
    #[account(mut)]
    pub merkle_tree: UncheckedAccount<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + TreeConfig::INIT_SPACE,
        seeds = [TREE_CONFIG_SEED, merkle_tree.key().as_ref()],
        bump,
    )]
    pub tree_config: Account<'info, TreeConfig>,
    // Optional collection to link tree to — if provided, must be owned by config authority.
    #[account(
        mut,
        constraint = collection.authority == authority.key() @ AssetsError::Unauthorized,
    )]
    pub collection: Account<'info, Collection>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(badge_id: u32)]
pub struct MintBadgeCore<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, AssetsConfig>,
    // SW-2026-09-26 F-05: the seeds and the authority constraint used to live
    // in two separate account attributes, whose merge behaviour is
    // Anchor-version-dependent. One merged attribute now; the handler keeps
    // its own authority check as defence in depth.
    #[account(
        seeds = [COLLECTION_SEED, collection.name.as_bytes(), collection.authority.as_ref()],
        bump = collection.bump,
        constraint = collection.authority == config.authority @ AssetsError::Unauthorized,
    )]
    pub collection: Account<'info, Collection>,
    /// CHECK: owned and PDA-validated against the features achievement registry.
    pub achievement_registry: UncheckedAccount<'info>,
    /// CHECK: the live features `FeaturesConfig` PDA — seeds, owner,
    /// discriminator and operator are validated in the handler (SW-2026-09-26
    /// F-04), so the pinned `AssetsConfig.features_authority` must match the
    /// features program's *current* authority.
    pub features_config: UncheckedAccount<'info>,
    #[account(
        init,
        payer = player,
        mint::decimals = 0,
        mint::authority = config,
        seeds = [BADGE_SEED, &badge_id.to_be_bytes(), player.key().as_ref()],
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
#[instruction(badge_id: u32, metadata_hash: [u8; 32], creator_hash: [u8; 32])]
pub struct MintBadgeCompressed<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, AssetsConfig>,
    // SW-2026-09-26 F-05: merged from two attributes, same as MintBadgeCore.
    #[account(
        seeds = [COLLECTION_SEED, collection.name.as_bytes(), collection.authority.as_ref()],
        bump = collection.bump,
        constraint = collection.authority == config.authority @ AssetsError::Unauthorized,
    )]
    pub collection: Account<'info, Collection>,
    /// CHECK: owned and PDA-validated against the features achievement registry.
    pub achievement_registry: UncheckedAccount<'info>,
    /// CHECK: the live features `FeaturesConfig` PDA — validated in the handler
    /// (SW-2026-09-26 F-04), same as the classic path.
    pub features_config: UncheckedAccount<'info>,
    /// CHECK: Merkle tree — validated against compression program + collection.
    #[account(mut)]
    pub merkle_tree: UncheckedAccount<'info>,
    #[account(
        seeds = [TREE_CONFIG_SEED, merkle_tree.key().as_ref()],
        bump = tree_config.bump,
    )]
    pub tree_config: Account<'info, TreeConfig>,
    /// CHECK: Bubblegum program — key compared to BGUMAp9... in handler (no arbitrary CPI).
    pub bubblegum_program: UncheckedAccount<'info>,
    /// CHECK: Compression program — key compared to cmtDv... in handler.
    pub compression_program: UncheckedAccount<'info>,
    /// CHECK: Noop program for Bubblegum event logging.
    pub noop_program: UncheckedAccount<'info>,
    #[account(
        init,
        payer = player,
        space = 8 + BadgeReceipt::INIT_SPACE,
        seeds = [BADGE_SEED, &badge_id.to_be_bytes(), player.key().as_ref()],
        bump,
    )]
    pub receipt: Account<'info, BadgeReceipt>,
    #[account(mut)]
    pub player: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreateTokenMintConfig<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ AssetsError::Unauthorized,
    )]
    pub config: Account<'info, AssetsConfig>,
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: mint — validated for extensions in handler, not hardcoded.
    pub mint: UncheckedAccount<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + MintConfig::INIT_SPACE,
        seeds = [b"neonrelay_mint_config", mint.key().as_ref()],
        bump,
    )]
    pub mint_config: Account<'info, MintConfig>,
    pub system_program: Program<'info, System>,
}

// -------------------------------------------------------------------- events

#[event]
pub struct AssetsInitialized {
    pub authority: Pubkey,
}

// SW-2026-09-26 F-04: rotating (or clearing) the trusted features operator is
// now an observable, on-chain event.
#[event]
pub struct FeaturesAuthorityChanged {
    pub old: Pubkey,
    pub new: Pubkey,
}

#[event]
pub struct CollectionCreated {
    pub collection: Pubkey,
    pub authority: Pubkey,
    pub name: String,
    pub symbol: String,
}

#[event]
pub struct TreeCreated {
    pub merkle_tree: Pubkey,
    pub max_depth: u32,
    pub max_buffer_size: u32,
    pub canopy_depth: u32,
}

#[event]
pub struct BadgeMintedCore {
    pub player: Pubkey,
    pub badge_id: u32,
    pub mint: Pubkey,
    pub collection: Pubkey,
}

#[event]
pub struct BadgeMintedCompressed {
    pub player: Pubkey,
    pub badge_id: u32,
    pub merkle_tree: Pubkey,
    pub leaf: [u8; 32],
    pub metadata_hash: [u8; 32],
}

#[event]
pub struct TokenMintConfigured {
    pub mint: Pubkey,
    pub decimals: u8,
}

#[event]
pub struct AssetsPauseChanged {
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
pub enum AssetsError {
    #[msg("signer is not the configured authority")]
    Unauthorized,
    #[msg("program is paused")]
    Paused,
    #[msg("collection metadata invalid")]
    InvalidCollectionMeta,
    #[msg("collection not found")]
    CollectionNotFound,
    #[msg("invalid tree args (depth 14..30, buffer pow2, canopy <= depth)")]
    InvalidTreeArgs,
    #[msg("badge id out of range (0..255)")]
    BadgeIdOutOfRange,
    #[msg("bubblegum program id mismatch")]
    InvalidBubblegumProgram,
    #[msg("compression program id mismatch")]
    InvalidCompressionProgram,
    #[msg("merkle tree does not match collection")]
    TreeMismatch,
    #[msg("mint must be an initialized classic SPL mint with no unsupported extensions")]
    InvalidMint,
    #[msg("decimals must be 0..9")]
    InvalidDecimals,
    #[msg("PermanentDelegate extension not allowed for vault mints")]
    PermanentDelegateNotAllowed,
    #[msg("TransferFee extension not yet supported — use fee-free mint")]
    TransferFeeNotSupported,
    #[msg("invalid authority")]
    InvalidAuthority,
    #[msg("no pending authority")]
    NoPendingAuthority,
    #[msg("authority slot delay has not expired")]
    TimelockNotExpired,
    #[msg("arithmetic overflow")]
    Overflow,
    #[msg("this asset path is not enabled in the verified build")]
    AssetPathNotConfigured,
    #[msg("achievement registry is missing, not owned by features, or malformed")]
    InvalidAchievementRegistry,
    #[msg("achievement has not been recorded for this player")]
    AchievementNotRecorded,
    #[msg("Bubblegum noop program account is invalid")]
    InvalidNoopProgram,
    #[msg("Merkle tree account is not compression-owned or initialized")]
    InvalidTreeOwner,
    #[msg("bootstrap signer is not the program upgrade authority")]
    BootstrapAuthorityInvalid,
    #[msg("token account has unsupported delegate, native wrapper, or close authority")]
    UnsafeTokenAccount,
    #[msg("features registry or config names an operator this program does not trust")]
    FeatureAuthorityMismatch,
}

// ---------------------------------------------------------------- unit tests (cargo test -p neonrelay-assets, no chain)

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seeds_are_correct() {
        assert_eq!(CONFIG_SEED, b"neonrelay_assets_config");
        assert_eq!(COLLECTION_SEED, b"neonrelay_collection");
        assert_eq!(BADGE_SEED, b"neonrelay_badge_asset");
    }

    #[test]
    fn program_ids_pinned() {
        assert_eq!(BUBBLEGUM_PROGRAM_ID, "BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY");
        assert_eq!(COMPRESSION_PROGRAM_ID, "cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK");
        assert_eq!(MPL_CORE_PROGRAM_ID, "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
    }

    #[test]
    fn leaf_hash_deterministic() {
        let player = [7u8; 32];
        let leaf1 = hashv(&[&player, &42u32.to_be_bytes(), &[1u8; 32], &[2u8; 32]]).to_bytes();
        let leaf2 = hashv(&[&player, &42u32.to_be_bytes(), &[1u8; 32], &[2u8; 32]]).to_bytes();
        assert_eq!(leaf1, leaf2);
        let leaf3 = hashv(&[&player, &43u32.to_be_bytes(), &[1u8; 32], &[2u8; 32]]).to_bytes();
        assert_ne!(leaf1, leaf3);
    }

    #[test]
    fn timelock_slots_positive() {
        assert!(MIN_AUTHORITY_DELAY_SLOTS >= 432_000);
    }
}
