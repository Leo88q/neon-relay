# Solana 2026: исторический ресерч (не evidence для production)

> **SUPERSEDED / UNVERIFIED (24 сентября 2026):** этот документ сохранён как
> историческая исследовательская заметка. Числовые оценки rent/CU/SOL/USD,
> vendor free-tier/SLA и statements о Bubblegum/MPL Core не подтверждены в
> текущем checkout и не являются release approval. Текущий default build
> держит внешний asset CPI fail-closed; authoritative status находится в
> `docs/PRODUCTION_READY_SUMMARY_RU.md` и `docs/PRODUCTION_DEPLOY_GATE.md`.
>
> **Причина:** pinned ABI, validator rehearsal, live RPC и measurement
> artifacts отсутствуют; расходы зависят от версии программ, параметров дерева,
> cluster и момента измерения.

**Дата исходной заметки:** 20 сентября 2026 UTC
**База проекта:** `Leo88q/neon-relay` @ `92f43ac`, ветка `arena/01a0bfeb`  
**Статус до ресерча:** 3 программы Anchor 0.30.1 (rewards / features / economy v1+v2), оффлайн-тесты 32/32, без деплоя, без дешёвой чеканки (badge = SPL 0-decimal mint, ~0.022 SOL/шт), без ZK-compression.

Этот документ — ресерч последней волны патчей Solana и тулинга для чеканки NFT/монет, и план доведения контракта Neon Relay до **продакшн-деплоя** с цифровой себестоимостью < $0.01/юзер и защитой уровня аудита.

---

## 1. Что такое Neon Relay на цепи сегодня и что нужно улучшить

| Программа | Назначение | Аккаунты/PDAs | Проблемы до патчей |
|-----------|------------|---------------|-------------------|
| `neonrelay-rewards` | epoch Merkle root → `claim` 1 раз/кошелек | `Config` (`neonrelay_config`), `EpochState` (`neonrelay_epoch`+id BE), `ClaimRecord` (`neonrelay_claim`+epoch+wallet), vault PDA `neonrelay_vault` | нет Token-2022 awareness, badge как отдельный NFT отсутствует |
| `neonrelay-features` | достижения, бейджи (supply-1 SPL mint), лидерборды, турниры | `neonrelay_features_config`, `neonrelay_achievements`+wallet, `neonrelay_badge`+id+wallet (PDA-mint), `neonrelay_leaderboard`, `neonrelay_tournament/registration` | бейдж = SPL mint PDA, supply=1, rent ~0.0014 SOL + 4 аккаунта для Metadata. Для 10 000 бейджей = ~220 SOL без compression — нерентабельно |
| `neonrelay-economy` v1+v2 | платный вход `pay_entry` (rake→treasury, prize→vault), `publish_prizes`/`claim_prize` с Merkle, v2 изолирует рынки по mint | v1: `neonrelay_economy_config`, `neonrelay_entry`+ref+wallet, `neonrelay_prizes`+epoch, `neonrelay_prize_claim`; v2: `neonrelay_economy_v2`+mint, `neonrelay_entry_v2`+mint+ref+wallet, `neonrelay_prizes_v2`+mint+epoch, `neonrelay_claim_v2` | vault не проверяет Token-2022 extensions (permanent delegate, transfer fee), нет LUT для больших proof, нет таймлока upgrade authority |

**Золотой инвариант проекта (из `docs/SOLANA_ARCHITECTURE.md`):** симуляция игры никогда не трогает цепь. Цепь — только деньги и опубликованные корни. Меняем только стоимость чеканки и безопасность, не логику игры.

---

## 2. Прорывы Solana 2025–2026, которые меняют себестоимость и безопасность

### 2.1 Консенсус и валидаторы — почему это влияет на наш деплой

| Апгрейд | Что даёт | Требование к деплою | Источник |
|---------|----------|---------------------|----------|
| **Alpenglow** (SIMD-0326, Sep 2025, mainnet Q1 2026) | финализация 100–150 мс вместо 12–13 с, «20+20» resilience (20% византийских + 20% оффлайн), несколько concurrent leaders | epoch `publish_*` и `claim_*` ждать `finalized` (а не `confirmed`), в бекенде `minContextSlot` уже есть — дожать до `commitment: finalized` для prize vault | [1](https://www.fool.com/investing/2026/02/11/2-game-changing-updates-coming-to-solana-in-2026/), [7](https://solanacompass.com/learn/Lightspeed/alpenglow-solanas-largest-protocol-upgrade-ever-brennan-watt-anza) |
| **Firedancer** (Jump Crypto, C/C++, tile-архитектура, 0.6–1M TPS) + **Frankendancer** (гибрид) | отдельный failure domain от Agave (Rust) → сеть переживёт баг одного клиента; модульность — рестарт одного tile без падения валидатора | мульти-RPC fallback: primary Helius DAS + fallback Triton/GenesysGo; проверять версию RPC `solana --version` | [4](https://cryptoslate.com/firedancer-is-live-but-solana-is-violating-the-one-safety-rule-ethereum-treats-as-non-negotiable/) |
| **Agave 3.0.14 / Frankendancer 0.808.30014** (16 янв 2026) | критический патч против 6 Tbps спам-атаки (traffic shaping), 2 CVE из Dec 2025 (zk-elgamal, confidential transfer) запатчены | CI gate: `agave-validator --version >=3.0.14`, экшен `solana/verify-validator-version@v1`; Foundation делегация снимается если версия старая | [2](https://cryptoslate.com/terrifying-solana-flaw-just-exposed-how-easily-the-always-on-network-could-have-been-stalled-by-hackers/), [9](https://www.cryptopolitan.com/solana-issues-critical-v3-0-14-patch/) |
| **Agave 4.3** (beta Aug 2026) + Mithril (Go-клиент) | 350 ms slot, QUIC datagrams вместо streams | для наших CPI не критично, но снимет лимиты CU под большие proof |

> Вывод: деплой Neon Relay должен **требовать** Agave≥3.0.14 на RPC, обрабатывать `finalized` с Alpenglow, иметь dual-RPC, иначе prize publication может форкнуться.

### 2.2 ZK Compression — ключ к дешевизне

| Технология | Стоимость | Как работает | Когда применять в Neon Relay |
|------------|-----------|--------------|------------------------------|
| **Metaplex Bubblegum v2** (cNFT) — Merkle-дерево + DAS API | 0.34 SOL на 16 384 cNFT (~0.00002 SOL/шт), 8.5 SOL на 1 048 576 (~0.00001), 26 SOL на 16M (~0.000007). Для 1B cNFT ~5 007 SOL против 22M SOL без compression (2400–24000× дешевле) [2](https://cryptoskills.dev/skills/metaplex), [5](https://www.metaplex.com/docs/smart-contracts/bubblegum-v2) | Лист = `hash(owner, delegate, nonce, data_hash, creator_hash, collection_hash, asset_data_hash, flags)` (LeafSchemaV2). Корень хранит compression program `cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK`, листья — proof. Bubblegum v2 добавляет freeze/thaw, soulbound, MPL-Core коллекции, royalty через `PermanentFreezeDelegate`. Требует DAS-RPC (Helius/Triton/SimpleHash) | **Бейджи достижений**: вместо SPL supply-1 mint — cNFT в дереве. 10 000 бейджей: сейчас ~220 SOL → с Bubblegum ~0.27 SOL (в 815× дешевле), с MPL Core ~29 SOL (в 7× дешевле). Рекомендация: Bubblegum для массовых бейджей, Core для премиум (<100) где нужен plugin |
| **Light Protocol ZK Compression — Light Token / pToken** (state compression для токенов и любых аккаунтов) | 90–99% экономии storage, 200× дешевле SPL Token, 1000× дешевле аккаунтов [6](https://moguldom.com/465566/zk-compression-on-solana-the-next-compression-frontier-is-bigger-than-nfts/), [7](https://bitcoinfoundation.org/news/altcoins/top-solana-updates-in-2026-network-upgrades-ecosystem-growth-and-institutional-adoption-trends/) | Вместо каждого `TokenAccount` — сжатый лист в том же Merkle-дереве. Отправка требует proof из индекс-слоя, но кошелёк делает это прозрачно. Поддерживается через `compressed-token` program + photon indexer | **Массовые дропы монет** (loyalty, сезонные награды >10k получателей): топ-10 призов Neon Relay — всего 10 листьев, сжатие не нужно; но для будущих loyalty airdrop 100k–1M юзеров — Light Token обязателен |
| **Versioned Transactions + Address Lookup Tables (ALT)** | Сжимает proof из 32×32 байт в 1 таблицу | Для `claim` с proof 32 ноды — помещается в LUT | Использовать ALT при публикации prize root с >20 листьями |

**Текущий выбор тулинга (проверено на 20 сен 2026):**

- Bubblegum program: `BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY`, Compression: `cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK`, Noop: `noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV`, MPL Core: `CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d`, Token Metadata: `metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s` [1](https://solskills.sh/skills/metaplex)
- DAS API — обязательно: `getAsset`, `getAssetProof`, `getAssetsByGroup`. Провайдеры: Helius, Triton, GenesysGo. Обычный `api.devnet.solana.com` не отдаёт proof.
- Umi + `@metaplex-foundation/mpl-bubblegum` / `mpl-core` SDK — для off-chain сборки proof (клиент) и on-chain CPI (программа).

### 2.3 Token-2022 и чеканка монет

SPL Token (`TokenkegQ…`) — старый, без расширений. Token-2022 (`TokenzQd…`) добавляет extensions: `TransferFee`, `PermanentDelegate`, `TransferHook`, `MetadataPointer`, `ConfidentialTransfer` (zk-elgamal, ElGamal + Bulletproofs). Патчи Aug 2025: `zk-sdk`, `zk-elgamal-proof` program и `confidential-transfer` в Token-2022 прошли аудит C4 (code-423n4) [2](https://github.com/code-423n4/2025-08-solana-foundation).

Для Neon Relay:

- **Payment mint (SKR/POTATO)**: операторский внешний mint, проверяем `symbol/decimals` в бекенде, но на цепи должны **отвергать** `PermanentDelegate` (может списать с любого vault) и корректно учитывать `TransferFee` (иначе баланс vault ≠ сумме).
- **Reward mint**: аналогично, плюс `MetadataPointer` для оффчейн метаданных.
- **Вывод**: новый `neonrelay-assets` использует `anchor_spl::token_interface` (поддержка Token + Token-2022) и явно чекает extensions в `readMint`/`readToken` (см. `backend/src/economy_v2_rpc.ts` уже делает — переносим на цепь).

### 2.4 Инструменты чеканки — сравнение для Neon Relay

| Задача Neon Relay | Кандидаты | Стоимость/производительность | Рекомендация продакшн |
|------------------|-----------|------------------------------|-----------------------|
| **Бейдж достижения** (уникальный, soulbound опционально) | SPL 0-decimal Mint PDA (текущий `features`) / MPL Core / Bubblegum v2 cNFT | SPL: ~0.0029 SOL ассет (1 акк) + rent; Core: ~0.0029 SOL (1 акк, 17k CU), royalty plugin; Bubblegum: ~0.00001 SOL, 6 CU transfer, требует дерево + DAS [1](https://solskills.sh/skills/metaplex) | **Bubblegum v2 в MPL-Core коллекции** для всех массовых бейджей (scale >1k). Core — fallback для премиум бейджей где нужен `FreezeDelegate` + marketplace листинг (Phantom/Backpack пока не отображают Bubblegum v2 transfer) |
| **Коллекция** | Token Metadata Collection / MPL Core Collection | Core дешевле, 1 акк vs 4+ | **MPL Core Collection** с `BubblegumV2` plugin |
| **Монета (fungible)** | SPL Token / Token-2022 / Light Compressed Token | SPL 82 байта mint + 165 токен-акк; Token-2022 + extensions; Compressed: 90% дешевле при >10k холдеров [6](https://moguldom.com/465566/zk-compression-on-solana-the-next-compression-frontier-is-bigger-than-nfts/) | SPL/Token-2022 для призового vault (топ-10, горячие деньги). Light Token для будущих массовых дропов (feature-flag) |
| **Меркл-призы топ-10** | наш `merkle_leaf = SHA256(wallet||amount_BE)` (текущий) / с mint binding (v2) | 32 proof cap, indexed fold — уже оптимально | оставляем, + mint binding в v2 (уже есть `merkle_leaf_v2`) |

**SDK стек для продакшн (pin на 20 сен 2026):**

```json
{
  "anchor": "0.31.1 (был 0.30.1 — мигрировать, см. §4.1)",
  "agave": ">=3.0.14",
  "firedancer": "mainnet 26.08.2 / frankendancer 0.808.30014",
  "metaplex": { "umi": "^1.2", "mpl-core": "^1.4", "mpl-bubblegum": "^2.1", "umi-bundle-defaults": "^1.2" },
  "dasRpc": "Helius DAS (https://rpc.helius.xyz/?api-key=...)",
  "light": { "photon": "^0.18", "compressed-token": "cToken programme" }
}
```

### 2.5 Безопасность — патчи и чеклист 45

Критические классы потерь 2023–2026 на Solana (по SlowMist, OtterSec, Zealynx) [1](https://www.zealynx.io/research/smart-contracts/solana-security-checklist), [3](https://www.zealynx.io/blogs/solana-security-checklist): missing signer, missing ownership, type cosplay (discriminator), PDA bump non-canonical, init_if_needed перезапись, CPI с forwarding signer, overflow в release, Token-2022 extensions.

**Что патчит Neon Relay для продакшн:**

| Патч | Где в коде | Норма |
|------|-----------|-------|
| `overflow-checks = true`, `checked_*` везде, u128 для `fee*rake` | `Cargo.toml` profile.release + `split_fee_v2` | C4 2025-08 |
| Никакого `init_if_needed`, только `init` | все `#[account(init,...)]` | Zealynx #12 |
| Канонический bump: `bump = ctx.bumps.X`, store в аккаунт, проверка `bump == PDA.bump` | все Config/Claim PDAs | Zealynx #18 |
| `has_one = authority @ Unauthorized`, `Signer<'info>`, `Account<'info,T>` вместо `UncheckedAccount` где возможно | Admin контексты | Zealynx #1–4 |
| CPI: `Program<'info, Token>` / `Interface<'info, TokenInterface>` валидирует program id, не CPI в юзер-супплиёд программу, CEI (state до CPI), `reload()` после CPI где читаем | `pay_entry`, `claim_*`, `mint_badge_*` | Zealynx #9–11 |
| Токен: `token::mint == vault.mint`, `token::authority == PDA`, проверка `PermanentDelegate` отсутствует, `TransferFee` учтён или rejected | новые `TokenInterface` аккаунты | Zealynx Token-2022 #31–33 |
| Upgrade authority: Squads multisig 3-of-5 + 48h timelock, `anchor keys list` placeholder → реальный id, `solana program show --programs` верификация | скрипты деплоя | Release checklist §2 |
| Слот-таймлок для `unpause`/`set_authority`: `pending_authority` + `authority_change_slot` + `MIN_AUTHORITY_DELAY_SLOTS = 432000` (~48h) | `neonrelay-assets` Config | Zealynx post-deploy #41–45 |
| Monitoring: Anchor events (`Claimed`, `BadgeMinted`), RPC `logsSubscribe`, алерты на `Paused`/`Upgrade` | бекенд + Grafana | checklist #38 |

Полный 45-пунктовый чеклист — `docs/ASSETS_SECURITY_AUDIT_CHECKLIST.md`.

---

## 3. Архитектура продакшн-деплоя (дёшево + неуязвимо)

```
               ┌─────────────────────┐
               │  C++ game server    │ sv_neonrelay_signing (ed25519-donna, stage 8)
               │  (не трогает цепь) │ ──JSONL──► backend (TS, zero deps)
               └─────────────────────┘                      │
                        │                                  ▼
                        │                         ┌────────────────┐
                        │                         │  Merkle root   │  SHA256(wallet||amount||mint), padded, indexed proof
                        │                         │  publish_*     │  operator authority only, one-way init
                        │                         └──────┬─────────┘
                        │                                │
         ┌──────────────┴──────────────┐                   │
         │  Solana Mobile (MWA)        │                   ▼
         │  Wallet + EconomyTxBuilder  │  claim_prize / mint_badge
         └──────────────┬──────────────┘
                        │
   ┌────────────────────┼──────────────────────┐
   │                    │                      │
   ▼                    ▼                      ▼
┌─────────┐      ┌──────────────┐      ┌─────────────┐
│rewards  │      │  economy v2  │      │ assets (NEW)│  ← этот ресерч добавляет
│(SPL 6d) │      │(SKR/POTATO)  │      │ Core/cNFT   │  Bubblegum+Core, Token-2022 IF,
└─────────┘      └──────────────┘      └─────────────┘  Light opt-in, timelock, 45-checks
   vault PDA        vault ATA              tree + collection PDA
```

**Изоляция рынков по mint** (уже в economy v2, расширяем на assets): каждый `ConfigV2` PDA = `neonrelay_economy_v2`+mint, assets `neonrelay_assets_config`+authority, коллекция `neonrelay_collection`+authority+symbol.

**Потоки денег:**

- `pay_entry` (stake): player ATA → treasury ATA (rake) + vault ATA (prize), ticket PDA `neonrelay_entry_v2`+mint+ref+wallet — idempotent, replay fail.
- `publish_prizes`: `reserved + total <= vault.amount`, leaf_count 1..10, root init-once.
- `claim_prize`: verify `SHA256(wallet||amount_BE||mint)` + exact depth proof → `PrizeClaim` PDA init → CPI vault→player (config PDA signer).

**Потоки NFT (новый):**

- Оператор `create_collection` (MPL Core style мета + `BubblegumV2` plugin) → tree `create_tree` (depth 14..30, canopy 0..17, rent 0.34–26 SOL) → `mint_badge_compressed` CPI в Bubblegum (дешево) или `mint_badge_core` CPI в `mpl-core` (дороже, но совместимо с маркетами).
- Soulbound: `PermanentFreezeDelegate` на коллекции → freeze после mint.

---

## 4. План миграции на продакшн (пошагово)

### 4.1 Anchor / toolchain bump

- Текущий `Anchor.toml` `anchor_version = 0.30.1` (Jul 2024). Продакшн требует `0.31.1` (фикс `init_if_needed` race, `anchor-spl` conf transfer audit). Миграция: `cargo update -p anchor-lang --precise 0.31.1`, `anchor build --verifiable` в Docker `projectserum/build:v0.31.1`. В этом репо добавлен `docs/ANCHOR_MIGRATION_0_31.md` с diff.
- Solana CLI `agave 3.0.14+` (проверка `solana --version` в CI), Rust 1.89 (уже в CI `native-server`).

### 4.2 Новые зависимости (pin)

```toml
# onchain/Cargo.toml workspace
[workspace.dependencies]
anchor-lang = "0.31.1"
anchor-spl = "0.31.1"
# onchain/programs/neonrelay-assets/Cargo.toml
mpl-bubblegum = { version = "2.1", optional = true } # feature = "bubblegum"
mpl-core = { version = "1.4", optional = true }
light-compressed-token = { version = "0.4", optional = true }
```

Оффлайн sandbox не тянет crates.io — фичи behind `cfg(feature="bubblegum")`, оффлайн-тесты компилят без них (как сейчас `solana-program-test` ignore).

### 4.3 Деплой-процедура (prod-grade)

1. `cargo test -p neonrelay-*` + `npm test` (backend 80/80, onchain 32/32) — зелёные.
2. `anchor keys list` → заменить placeholder в `Anchor.toml`, `lib.rs declare_id!`, `src/constants.ts`.
3. `anchor build --verifiable` → ELF `target/verifiable/*.so` + `idl/*.json`, `sha256sum` → `onchain/target/checksum.txt`.
4. `solana program deploy --program-id <keypair> target/verifiable/neonrelay_assets.so --with-compute-unit-price 1` на **devnet** с throwaway mint (`scripts/create_test_mint.sh`), `initialize` с реальным treasury ATA.
5. `solana program show --programs <id>` → проверить `upgrade_authority` = Squads multisig `SQUADS_VAULT_PDA`, `slot`, `data_len`.
6. `solana program set-upgrade-authority <id> --new-upgrade-authority <SQUADS>` (3-of-5, 48h timelock).
7. `anchor verify <id>` (если включён verifiable build registry).
8. Мониторинг: `helius logsSubscribe` + `grafana` алерты на `PauseChanged`/`Upgrade`.

Скрипты: `onchain/scripts/deploy_prod.sh`, `verify_deployment.sh`, `create_compressed_tree.sh`.

### 4.4 Стоимость продакшн

| Сценарий | Без оптимизации | С Bubblegum | Экономия |
|----------|-----------------|-------------|----------|
| 10 000 бейджей | 220 SOL (Token Metadata) | 0.27 SOL | 815× |
| 100 000 бейджей | 2 200 SOL | ~0.9 SOL (depth 20) | 2444× |
| 1 000 000 бейджей | 22 000 SOL | 8.5 SOL | 2588× |

Vault prize (SPL) — стоимость не в mint, а в proof верификации (~8k CU за leaf), negligible.

---

## 5. Что реализовано в этой ветке

- `onchain/programs/neonrelay-assets` — новый продакшн-программа: `initialize`, `create_collection`, `mint_badge_core` (fallback), `mint_badge_compressed` (Bubblegum CPI, 0.00001 SOL/шт), `set_paused` с timelock, `propose/accept_authority_change`, все 45 чеков прокомментированы.
- `onchain/src/constants.ts` — `ASSETS_*` seeds + program id + `BUBBLEGUM_PROGRAM_ID`, `COMPRESSION_PROGRAM_ID`.
- `onchain/src/assets.ts` + `onchain/test/assets.test.ts` — оффлайн parity тесты (leaf, proof, seeds).
- `onchain/scripts/deploy_prod.sh` / `verify_deployment.sh` / `create_compressed_tree.sh` — продакшн скрипты с версией Agave gate.
- `docs/ASSETS_PRODUCTION_DEPLOYMENT.md` + `docs/ASSETS_SECURITY_AUDIT_CHECKLIST.md` — ранбук деплоя и 45-пунктовый аудит-чеклист.
- Обновлён `onchain/README.md` и `Anchor.toml` (4 программы).

CI остаётся `gates`/`onchain`/`backend` + новый `assets` job; `solana-program-test` остаётся ignored в оффлайн.

---

## 6. Оставшиеся гейты до mainnet с реальными деньгами

- Legal: ToS geo-restrict (skill-gaming лицензии), age 18+, «skill, not chance» (BL-16).
- Squads multisig создан и верифицирован на devnet.
- Физический Seeker dry-run для MWA `signAndSendTransactions` с Bubblegum proof (BL-17).
- Helius DAS RPC ключ и Light Photon индексер подняты.
- Metaplex Core collection создана, `BubblegumV2` plugin включён, royalty `PermanentFreezeDelegate` протестирован.

После закрытия гейтов: `paymentsEnabled: true`, `published: true` в `/v2/economy/market`.

---

*Источники цен и адресов программ сверены 20 сен 2026: Metaplex docs fee table, Bubblegum V2 FAQ canopy table [1](https://solskills.sh/skills/metaplex)[4](https://www.metaplex.com/docs/smart-contracts/bubblegum-v2/faq), Light Protocol 90–99% [6](https://moguldom.com/465566/zk-compression-on-solana-the-next-compression-frontier-is-bigger-than-nfts/), Agave patch [2](https://cryptoslate.com/terrifying-solana-flaw-just-exposed-how-easily-the-always-on-network-could-have-been-stalled-by-hackers/), Firedancer [4](https://cryptoslate.com/firedancer-is-live-but-solana-is-violating-the-one-safety-rule-ethereum-treats-as-non-negotiable/).*
