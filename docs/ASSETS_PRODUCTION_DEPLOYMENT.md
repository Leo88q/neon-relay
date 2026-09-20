# Продакшн-деплой Neon Relay: дешёвая чеканка + защита от взлома (уровень продакт-деплоя)

**Цель этого ранбука:** поднять контракты так, чтобы чеканка стоила <$0.01/юзер и взлом/кража контракта/средств были невозможны без физического компромисса multisig. Основан на ресерче `SOLANA_2026_PRODUCTION_RESEARCH.md`.

---

## 0. Что деплоим

4 программы (workspace `onchain`):

| Программа | ID placeholder | Назначение | Дешевизна |
|-----------|----------------|------------|-----------|
| `neonrelay-rewards` | `2RaaXKU...tmj` | epoch Merkle → claim | — (SPL vault) |
| `neonrelay-features` | `4PH1dHV...qYP` | badges/leaderboards/tournaments | — |
| `neonrelay-economy` (v1+v2) | `FZcLDdU...CV9` | pay_entry / publish_prizes / claim_prize (SKR/POTATO, 5/45 split, rake 10%) | — |
| **`neonrelay-assets` (NEW)** | `F5VhZx...q3oc` | **MPL Core + Bubblegum v2 cNFT бейджи (0.00001 SOL) + Token-2022 конфиг + timelock** | **10k бейджей 0.27 SOL vs 220 SOL (815× дешевле)** |

Все — devnet-only до BL-16 sign-off. Код — `onchain/programs/*/src/lib.rs`, TS-зеркала `onchain/src/*.ts`.

---

## 1. Требования к окружению (продакшн)

```
Rust 1.89 (rustup toolchain install 1.89.0)
Anchor 0.31.1 (было 0.30.1 — см. docs/ANCHOR_MIGRATION_0_31.md)
Agave validator >=3.0.14  (критический патч Jan 2026, иначе delegation Foundation снимается)
Firedancer mainnet 26.08.2 или Frankendancer 0.808.30014 (dual-RPC fallback обязателен)
Node 22, docker (для --verifiable)
Solana CLI, Helius DAS RPC (для Bubblegum proof), Squads multisig (3-of-5)
```

Проверка:

```bash
solana --version   # >=3.0.14
anchor --version   # >=0.31.1
solana config get  # url = https://api.devnet.solana.com (пока)
```

---

## 2. Дешёвая чеканка — как выбрать путь

| Юзкейс | Путь A (дорого) | Путь B (дёшево, рекомендован) | Когда какой |
|--------|-----------------|------------------------------|-------------|
| Бейдж достижения (soulbound, 256 id, supply-1) | `mint_badge_core`: SPL 0-decimal PDA mint, 1 акк, 0.0029 SOL + rent | `mint_badge_compressed`: CPI Bubblegum `BGUMAp9...`, лист в дереве, 0.00001 SOL | B сжатый для массовых сезонов (>1k юзеров), A для премиум 1/1 + листинг на Magic Eden (Bubblegum v2 пока не везде отображается) |
| Коллекция | Token Metadata (4 акка, 0.022 SOL) | MPL Core (`CoREEN...`, 1 акк, 17k CU) | Всегда Core + `BubblegumV2` plugin |
| Монеты (prize pool) | SPL Token | Light Compressed Token (90% дешевле при 100k холдеров) | Сейчас SPL/Token-2022 (топ-10 не нужен сжатый), Light — feature-flag для будущих loyalty дропов 1M |

**Дерево Bubblegum:** создаётся один раз `create_tree(depth, buffer, canopy)`. Rent:

- 16 384 cNFT (14/64/8) ~0.34 SOL
- 1 048 576 cNFT (20/256/13) ~8.5 SOL
- 16 777 216 cNFT (24/512/15) ~26 SOL

См. `onchain/scripts/create_compressed_tree.sh`.

---

## 3. Супербезопасность — что закрывает взлом

### 3.1 До деплоя — код

Все 45 чеков Zealynx/SlowMist/OtterSec применены (см. `docs/ASSETS_SECURITY_AUDIT_CHECKLIST.md`):

- `overflow-checks = true`, `checked_*`, `u128` для `fee*mul(rake)`.
- Нет `init_if_needed` — только `init` (reinit невозможен).
- Канонический bump: `bump = ctx.bumps.X`, store в аккаунте, PDA выведены только через seeds.
- `has_one = authority`, `Signer<'info>`, `Account<'info,T>` (типизированные), `Program<'info, Token>` — никакого `UncheckedAccount` без `/// CHECK`.
- CPI: вайтлист программ (`BGUMAp9...`, `cmtDvX...`, `CoREEN...`, `Tokenkeg...`), CEI (счётчики ++ до CPI), `reload()` после CPI где читаем.
- Token-2022: `PermanentDelegate` → `require!(!has_permanent_delegate)`, `TransferFee` → reject (или учёт fee), `Mint::decimals` проверка.
- Таймлок смены authority: `propose_authority_change` → `accept_authority_change` после 432 000 слотов (48h). `paused` — immediate.
- События Anchor на всё (`AssetsInitialized`, `BadgeMintedCompressed`, `AuthorityChanged`) для мониторинга.

### 3.2 При деплое — ключи и апгрейд

- `solana-keygen new` для operator authority — оффлайн, hardware (Ledger) или Squads.
- **Squads multisig 3-of-5** для `upgrade_authority`: `solana program set-upgrade-authority <id> --new-upgrade-authority <SQUADS_VAULT>` после деплоя. 48h timelock в Squads. После аудита — опционально `... --final` (renounce, immutable).
- `anchor keys list` → заменить placeholder в `Anchor.toml`, всех `lib.rs declare_id!`, `src/constants.ts`. `onchain/test/*.test.ts` упадёт если не совпадают.
- `anchor build --verifiable` (docker) → `sha256sum target/verifiable/*.so` → записать в релиз-ноты. Никогда не деплоить `target/deploy/*.so` без верификации.

### 3.3 После деплоя — мониторинг и операции

- RPC `commitment: finalized` (Alpenglow 150ms, но reorg окно ещё есть) для `publish_*`/`claim_*`. Бекенд уже делает `minContextSlot` + `finalized`.
- Dual RPC: primary Helius DAS, fallback Triton. Healthcheck `solana --version` + `getHealth`.
- `logsSubscribe` на `BadgeMinted*`, `Claimed`, `Paused`, `AuthorityChanged` → Grafana/Slack alert.
- `set_paused(true)` — emergency stop claims/mints без остановки `publish_*` (история не копится).
- Бекенд: `GET /v2/economy/market?currency=SKR` валидирует vault ATA, mint decimals, rake, pause, `reserved <= balance` (см. `economy_v2_rpc.ts`).

---

## 4. Пошаговый деплой (devnet, throwaway mint)

```bash
# 0. Клонируете и ставите тулчейн (см. §1)
git clone https://github.com/Leo88q/neon-relay && cd neon-relay
rustup toolchain install 1.89.0 && rustup default 1.89.0
npm --version # 22

# 1. Оффлайн гейты (должны пройти до деплоя)
./scripts/local_syntax_probe.sh
./scripts/neonrelay_signer_test.sh
(cd backend && npm test)   # 80/80
(cd onchain && npm test)   # 32/32 + новый assets (6/6)

# 2. Генерите ключи программ (один раз)
cd onchain
anchor keys list  # покажет 4 placeholder — сгенерите новые: solana-keygen new --outfile target/deploy/<prog>.json && anchor keys sync

# 3. Обновите Anchor.toml + lib.rs + constants.ts (anchor keys sync помогает)

# 4. Создайте throwaway test mint (НЕ SKR!)
./scripts/create_test_mint.sh   # экспорт NEONRELAY_TEST_MINT=...

# 5. Деплой (скрипт проверяет Agave version, делает verifiable build, сверяет checksum, ставит authority)
CLUSTER=devnet ./scripts/deploy_prod.sh
# или mainnet только после BL-16:
# CLUSTER=mainnet-beta UPGRADE_AUTHORITY=<SQUADS_VAULT_PDA> ./scripts/deploy_prod.sh

# 6. Инициализация (anchor shell)
# rewards: initialize(mint=NEONRELAY_TEST_MINT)
# features: initialize()
# economy: initialize(rake_bps=1000, fee_match=50*dec, fee_tournament=100*dec)
# economy v2: initialize_v2(rake_bps=1000) для каждого mint (SKR/POTATO)
# assets: initialize() -> create_collection("Neon Relay Badges","NRB","https://neonrelay.example/meta/") -> create_tree(14,64,5)

# 7. Фандинг vault (devnet!)
spl-token mint $NEONRELAY_TEST_MINT 1000000 <vaultATA>  # или через Token-2022
```

---

## 5. Дешёвая чеканка в действии (devnet dry-run)

### Bubblegum бейджи

```bash
# Создать дерево 16k (~0.34 SOL)
./onchain/scripts/create_compressed_tree.sh devnet 14 64 5

# Mint сжатого бейджа (TS, Umi)
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { mintToCollectionV1 } from "@metaplex-foundation/mpl-bubblegum";
await mintToCollectionV1(umi, {
  leafOwner: playerPubkey,
  merkleTree: treePubkey,
  collectionMint: coreCollectionPubkey,
  metadata: { name:"Neon Relay #42", uri:"https://...", sellerFeeBasisPoints:0, creators:[{address:umi.identity.publicKey, share:100, verified:true}] }
}).sendAndConfirm(umi);
# Проверка DAS:
curl -X POST $HELIUS_RPC -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getAsset","params":["<cNFT id>"]}'

# Альтернатива через наш assets программу (дешевле на CPI, но требует proof с DAS):
await program.methods.mintBadgeCompressed(new BN(42), metadataHash, creatorHash)
  .accounts({ merkleTree: treePubkey, collection: collectionPda, bubblegumProgram: BGUM, compressionProgram: CMT, noopProgram: NOOP })
  .rpc();
```

### Core fallback (премиум)

```ts
await program.methods.mintBadgeCore(new BN(42))
  .accounts({ collection: collectionPda, badgeMint: badgePda, playerBadgeAccount: ata })
  .rpc();
```

### Токены (Token-2022)

```bash
spl-token --program-2022 create-token --decimals 6  # или 9 для SKR
spl-token --program-2022 create-account <mint>
# Проверка что нет PermanentDelegate:
spl-token --program-2022 display <mint> | grep -i delegate  # должен быть empty
```

---

## 6. Проверка что не взломают

Чеклист перед `paymentsEnabled: true`:

- [ ] `solana program show --programs <id>` → `upgrade_authority` = Squads vault, не ваш hot wallet.
- [ ] `anchor verify <id>` или `sha256sum --check target/checksum.txt` — ELF совпадает с ревью.
- [ ] `spl-token display <vaultMint>` → `PermanentDelegate: None`, `TransferFee: None` (или fee BPS учтён).
- [ ] `GET /v2/economy/market?currency=SKR` → `paused:false`, `reserved <= balance`, `feesBase` = ["50000000",...] для 6 decimals.
- [ ] Попытка `mint_badge_compressed` с левым `BGUM` program id → `InvalidBubblegumProgram`.
- [ ] `propose_authority_change(new)` → `accept` до 48h → `TimelockNotExpired`.
- [ ] `set_paused(true)` → `mint_badge_core/compressed/pay_entry` → `Paused`.
- [ ] `solana --version` на RPC >=3.0.14, иначе — не деплоить.
- [ ] Helius DAS `getAssetProof` отвечает <500ms, fallback RPC green.

---

## 7. Сколько стоит эксплуатация

| Операция | CU | SOL (при 1000 lamports/CU) | Примечание |
|----------|----|----------------------------|------------|
| `create_collection` | ~25k | 0.000025 | 1 раз |
| `create_tree` (14/64/8) | ~50k | 0.00005 + 0.34 rent | 1 раз на 16k |
| `mint_badge_compressed` | ~35k | 0.000035 | vs 0.0029 Core, vs 0.022 Metadata |
| `mint_badge_core` | ~45k | 0.000045 + 0.0014 rent | fallback |
| `pay_entry_v2` | ~60k | 0.00006 | + token transfer |
| `claim_prize_v2` (proof 1) | ~25k | 0.000025 | capped 32 |

При 100k активных юзеров/месяц экономия на бейджах vs Metadata: ~2 200 SOL (~$300k по $150/SOL) — окупает аудит.

---

*Связанные доки: `SOLANA_2026_PRODUCTION_RESEARCH.md`, `ASSETS_SECURITY_AUDIT_CHECKLIST.md`, `REWARD_SECURITY.md`, `SOLANA_ARCHITECTURE.md`, `DEVNET_RUNBOOK.md`.*
