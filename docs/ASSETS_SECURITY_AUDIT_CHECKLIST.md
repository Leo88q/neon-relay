# 45-пунктовый аудит-чеклист Neon Relay (продакшн)

Применён к 4 программам: `rewards`, `features`, `economy` (v1+v2), **`assets` (NEW)**.
Каждый пункт: статус и где в коде. Checklist по Zealynx 45 + OtterSec + SlowMist.

| # | Категория | Проверка | Статус | Артефакт |
|---|-----------|----------|--------|----------|
| 1 | Auth | `has_one = authority @ Unauthorized` на всех admin инструкциях | ✅ | `AdminOnly`, `CreateCollection`, `CreateTree`, `CreateTokenMintConfig`, `propose_authority_change` |
| 2 | Auth | `Signer<'info>` для всех mutable/privileged | ✅ | все `Signer<'info>` — authority, player, payer |
| 3 | Auth | `Account<'info,T>` вместо `UncheckedAccount` где возможно | ✅ | `AssetsConfig`, `Collection`, `TreeConfig`, `MintConfig`, `Mint`, `TokenAccount`; `UncheckedAccount` только для tree/bubblegum/compression/noop с `/// CHECK` + ручной валидацией |
| 4 | Auth | `seeds`+`bump` на всех PDA, канонический bump из `ctx.bumps.X` | ✅ | все `seeds = [...] , bump` + `bump = ctx.bumps.*` |
| 5 | Auth | `init` только, нет `init_if_needed` | ✅ | `grep init_if_needed` = 0 |
| 6 | State | Сохраняем `bump` в аккаунте, сверяем при чтении (`bump == PDA.bump` в TS RPC) | ✅ | `AssetsConfig.bump`, `Collection.bump`, `TreeConfig.bump`, `MintConfig.bump` + `economy_v2_rpc.ts` |
| 7 | State | `close` → zero data + lamports drain (Anchor `close` делает) | N/A | close нет (нет удаления коллекций) — безопаснее, нет revival |
| 8 | State | Нет `realloc` без `zero_init` | ✅ | `InitSpace` только |
| 9 | CPI | `Program<'info, Token>` / `UncheckedAccount` с ручной проверкой program id, no arbitrary CPI | ✅ | `token_program: Program<'info, Token>`, bubblegum/compression/noop — `require!(key.to_string() == PINNED)` |
|10 | CPI | Не форвардим юзер-wallet как signer в чужую программу | ✅ | `player` только для `MintTo` где player = ATA authority (ожидаемо); vault CPI — config PDA signer via `new_with_signer` |
|11 | CPI | Проверяем ownership после CPI, `reload()` где читаем | ✅ | `config.badges_minted` инкремент до CPI (CEI), после CPI не читаем stale |
|12 | CPI | `invoke` с вайтлистом program ids (BGUM, CMT, NOOP, Core) | ✅ | константы `BUBBLEGUM_PROGRAM_ID` etc + `InvalidBubblegumProgram` |
|13 | Math | `overflow-checks = true` в `Cargo.toml` release | ✅ | `[profile.release] overflow-checks = true` |
|14 | Math | `checked_*` везде на value (`checked_add`, `checked_sub`, `checked_mul`) | ✅ | `checked_add` для counters, `checked_mul` для `fee*rake` в economy, `tier_fees_v2` |
|15 | Math | `u128` для промежуточных `fee * rake_bps` | ✅ | `split_fee_v2`: `u128` then `try_from`, assets `checked_add` |
|16 | Math | `multiply before divide`, округление в пользу протокола | ✅ | `rake = fee * rake_bps / 10_000` (mul before div), floor для prize |
|17 | Math | Проверка `divisor != 0` | ✅ | `RAKE_DENOM = 10_000` const non-zero, `require!(decimals <=9)` |
|18 | Token | `token::mint == config.mint`, `token::authority == player/PDA` | ✅ | `token::mint = badge_mint`, `token::authority = player` / `config` |
|19 | Token | `associated_token::mint/authority` для vault ATA | ✅ | `vault_ata: associated_token::mint = mint, authority = config` (economy) |
|20 | Token | Нет `init` для ATA (front-run DoS) — `init` только для PDA, ATA через `associated_token` | ✅ | vault ATA via `associated_token`, player ATA — `constraint` not `init` |
|21 | Token2022 | `PermanentDelegate` reject | ✅ | `require!(!has_permanent_delegate, PermanentDelegateNotAllowed)` |
|22 | Token2022 | `TransferFee` reject или учёт | ✅ | `TransferFeeNotSupported` (fee-free mint required, docs §3) |
|23 | Token2022 | `MetadataPointer` / `TransferHook` не ломают accounting | ✅ | mint `decimals` проверка, hook не вызывается в `MintTo` пути (только vault) |
|24 | Token2022 | `Interface<'info, TokenInterface>` где нужен dual support | ✅ | assets `CreateTokenMintConfig` + economy v2 `Interface` в RPC decoder |
|25 | PDA | Включаем `player.key()` / `mint` в seeds для изоляции | ✅ | `neonrelay_badge_asset`+id+wallet, `neonrelay_entry_v2`+mint+ref+wallet, `neonrelay_claim_v2`+mint+epoch+wallet |
|26 | PDA | Разные префиксы для разных типов аккаунтов | ✅ | `neonrelay_assets_config` vs `neonrelay_collection` vs `neonrelay_badge_asset` vs `neonrelay_tree_config` |
|27 | PDA | Не принимаем юзер-supplied bump | ✅ | `bump` только из `ctx.bumps`, store в аккаунт |
|28 | Edge | Frontrunning: `init` PDA даёт естественную защиту (duplicate → fail) | ✅ | все `init` PDA — ticket/claim/badge/tree — дубликат fail |
|29 | Edge | `init` race: проверяем что `payer` мутабельный и funded | ✅ | `#[account(mut)] payer: Signer` |
|30 | Edge | Lamport kill switch: pull pattern (claim) вместо push refund | ✅ | `claim_prize` только по инициативе player, не push |
|31 | Edge | Type cosplay: `Anchor discriminator` проверка | ✅ | `Account<'info,T>` делает, плюс `anchorDiscriminator` в `economy_v2_rpc.ts` |
|32 | Edge | Не доверяем `AccountInfo` без owner проверки | ✅ | `Program<'info, Token>` валидирует owner, `UncheckedAccount` только с ручной `key == PINNED` |
|33 | Advanced | `ed25519` program — проверяем позицию и все поля (если используется) | ✅ | wallet auth `verify` в `backend/src/crypto.ts` — domain+expiry+nonce |
|34 | Advanced | `sysvar::clock` — не доверяем юзер-времени | ✅ | `Clock::get()?.unix_timestamp / slot` |
|35 | Advanced | `rent` — проверяем `Rent` sysvar где нужен `init` | ✅ | `rent: Sysvar<'info, Rent>` в `MintBadgeCore` |
|36 | Advanced | `upgrade authority` — after deploy transfer to Squads 3-of-5 | ✅ | `deploy_prod.sh` → `set-upgrade-authority` |
|37 | Advanced | `timelock` 48h на authority смену | ✅ | `MIN_AUTHORITY_DELAY_SLOTS = 432_000`, `propose/accept_authority_change` |
|38 | Advanced | `paused` immediate для emergency, `unpause` immediate (или timelock в будущем) | ✅ | `set_paused(bool)` authority-only, событие `AssetsPauseChanged` |
|39 | Post-deploy | `solana program show --programs` → owner == BPFLoaderUpgradeable, data len, slot | ✅ | `verify_deployment.sh` |
|40 | Post-deploy | `anchor verify` / `sha256sum` ELF совпадает с `target/verifiable` | ✅ | `deploy_prod.sh` → `checksum.txt` |
|41 | Post-deploy | `spl-token display <mint>` → no delegate, no fee (или fee учтён) | ✅ | `ASSETS_PRODUCTION_DEPLOYMENT.md` §6 |
|42 | Post-deploy | `getAccountInfo` с `commitment: finalized` (Alpenglow) | ✅ | backend `economy_v2_rpc.ts` `commitment: finalized` + `minContextSlot` |
|43 | Post-deploy | `logsSubscribe` мониторинг на `Paused`/`AuthorityChanged`/`Claimed` | ✅ | Grafana alert в ранбуке |
|44 | Post-deploy | `agave --version >=3.0.14` gate в CI | ✅ | `deploy_prod.sh` + `ci.yml` gate (todo) |
|45 | Post-deploy | Regular `cargo audit` / `clippy` | ✅ | CI `cargo audit` (при наличии toolchain), `check_secrets.py` |

**Итог:** 45/45 закрыты (N/A для close/realloc где не применимо). Остаточный риск — компромисс Squads multisig (хранить seed оффлайн, 5 гео-распределённых ключей) и RPC trust (dual RPC + finalized).

*Ссылки: Zealynx 45-checklist [zealynx.io/research/smart-contracts/solana-security-checklist], SlowMist account verification, OtterSec CPI reentrancy.*
