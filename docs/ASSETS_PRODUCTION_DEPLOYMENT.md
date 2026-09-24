# Source-gated deployment runbook Neon Relay: assets and custody

Этот файл описывает порядок проверки, а не подтверждённый production deploy.
В текущем checkout Bubblegum/MPL Core CPI paths compile-time disabled до pinning
upstream ABI/account metas и validator coverage. Ниже не следует считать
доказательством цены, совместимости или безопасности live-контракта. Основан
на ресерче `SOLANA_2026_PRODUCTION_RESEARCH.md`.

---

## 0. Что деплоим

4 программы (workspace `onchain`):

| Программа | Source ID (live status unverified) | Назначение | Дешевизна |
|-----------|----------------|------------|-----------|
| `neonrelay-rewards` | `2RaaXKU...tmj` | epoch Merkle → claim | — (SPL vault) |
| `neonrelay-features` | `4PH1dHV...qYP` | badges/leaderboards/tournaments | — |
| `neonrelay-economy` (v1+v2) | `FZcLDdU...CV9` | pay_entry / publish_prizes / claim_prize (SKR/POTATO, 5/45 split, rake 10%) | — |
| **`neonrelay-assets` (source-gated)** | `F5VhZx...q3oc` | **classic SPL badge fallback and achievement proof in source; Bubblegum/MPL Core CPI disabled by default** | **live cost/compatibility unverified** |

Все четыре программы остаются непроверенными до Rust/Anchor build, validator run,
real IDs, custody approval и finalized RPC verification. Код —
`onchain/programs/*/src/lib.rs`, TS-зеркала `onchain/src/*.ts`.

---

## 1. Требования к окружению (продакшн)

```
Rust 1.89 (rustup toolchain install 1.89.0)
Anchor 0.31.1 (checked-in lockfile refresh remains a connected release gate; см. docs/ANCHOR_MIGRATION_0_31.md)
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

| Юзкейс | Verified default build | Статус production path |
|--------|-----------------------|------------------------|
| Бейдж достижения (supply-1) | `mint_badge_core` с classic SPL и on-chain achievement registry proof | Доступность коллекции и runtime CPI не подтверждены; `create_collection`/Bubblegum path fail-closed |
| Коллекция / cNFT | Нет enabled CPI path | MPL Core/Bubblegum ABI, account metas и validator coverage не проверены |
| Монеты (prize pool) | Classic SPL only; Token-2022 extensions rejected | Light Compressed Token не реализован и не является release evidence |

**Дерево Bubblegum:** в verified default build этот путь не включён. Размер
дерева, rent и фактическая стоимость должны быть измерены отдельным
validator/CPI rehearsal после pinning upstream ABI; `create_tree` не является
доказательством этих параметров. См. `onchain/scripts/create_compressed_tree.sh`
только как внешний экспериментальный helper.

---

## 3. Супербезопасность — что закрывает взлом

### 3.1 До деплоя — код

Часть source-level controls из checklist Zealynx/SlowMist/OtterSec
зафиксирована в default build; post-deploy, CPI ABI, validator и custody
пункты остаются gated/unverified (см.
`docs/ASSETS_SECURITY_AUDIT_CHECKLIST.md`):

- `overflow-checks = true`, `checked_*`, `u128` для `fee*mul(rake)`.
- Нет `init_if_needed` — только `init` (reinit невозможен).
- Канонический bump: `bump = ctx.bumps.X`, store в аккаунте, PDA выведены только через seeds.
- `has_one = authority`, `Signer<'info>`, `Account<'info,T>` (типизированные), `Program<'info, Token>` — никакого `UncheckedAccount` без `/// CHECK`.
- CPI: вайтлист программ (`BGUMAp9...`, `cmtDvX...`, `CoREEN...`, `Tokenkeg...`), CEI (счётчики ++ до CPI), `reload()` после CPI где читаем.
- Token-2022: `PermanentDelegate` → `require!(!has_permanent_delegate)`, `TransferFee` → reject (или учёт fee), `Mint::decimals` проверка.
- Authority change uses a 432,000-slot minimum delay. Wall-clock duration is
  cluster-dependent and unverified here; `paused` is immediate.
- События Anchor на всё (`AssetsInitialized`, `BadgeMintedCompressed`, `AuthorityChanged`) для мониторинга.

### 3.2 При деплое — ключи и апгрейд

- `solana-keygen new` для operator authority — оффлайн, hardware (Ledger) или Squads.
- Для `upgrade_authority` оператор должен предоставить concrete custody
  policy (например, внешний multisig) и проверить её отдельным read-only gate.
  В этом checkout custody, signer quorum и wall-clock timelock не
  подтверждены; `--final`/renounce не выполнять без отдельного approval.
- `anchor keys list` → compare live program accounts with the pinned
  `Anchor.toml`, `lib.rs declare_id!` and `src/constants.ts` IDs; record the
  finalized comparison in the external deployment manifest. The conformance
  tests fail if source files drift.
- `anchor build --verifiable` (docker) → `sha256sum target/verifiable/*.so` → записать в релиз-ноты. Никогда не деплоить `target/deploy/*.so` без верификации.

### 3.3 После деплоя — мониторинг и операции

- RPC `commitment: finalized` для `publish_*`/`claim_*`; latency and reorg
  behavior remain live measurements. Backend requests finalized snapshots where
  the money-path verifier requires them.
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
(cd backend && npm test)   # 257/257
(cd onchain && npm test)   # 50/50

# 2. Генерите ключи программ (один раз)
cd onchain
anchor keys list  # сравнить live accounts с pinned source IDs; не считать
                    # список ключей доказательством deploy

# 3. Обновите Anchor.toml + lib.rs + constants.ts (anchor keys sync помогает)

# 4. Создайте throwaway test mint (НЕ SKR!)
./scripts/create_test_mint.sh   # экспорт NEONRELAY_TEST_MINT=...

# 5. Деплой (скрипт проверяет Agave version, делает verifiable build, сверяет checksum, ставит authority)
CLUSTER=devnet ./scripts/deploy_prod.sh
# или mainnet только после BL-16:
# CLUSTER=mainnet-beta UPGRADE_AUTHORITY=<SQUADS_VAULT_PDA> ./scripts/deploy_prod.sh

# 6. Инициализация (только после успешной миграции и отдельного live gate)
# rewards: initialize(mint=NEONRELAY_TEST_MINT)
# features: initialize()
# economy: initialize(rake_bps=1000, fee_match=50*dec, fee_tournament=100*dec)
# economy v2: initialize_v2(rake_bps=1000) для каждого mint (SKR/POTATO)
# assets: initialize() starts paused; create_collection records the internal
# bounded collection descriptor. create_tree/mint_badge_compressed return
# AssetPathNotConfigured in the verified default build and must not be enabled
# without a separately reviewed upstream CPI implementation.

# 7. Фандинг vault (devnet!)
spl-token mint $NEONRELAY_TEST_MINT 1000000 <vaultATA>  # или через Token-2022
```

---

## 5. Непроверенные внешние примеры (не часть enabled default build)

Следующие команды требуют отдельного внешнего Metaplex/Bubblegum проекта и
DAS/validator verification; они не доказывают работоспособность CPI в
`neonrelay-assets`.

### Bubblegum бейджи

```bash
# Экспериментальный helper; размер дерева и rent должны быть измерены отдельно.
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
- [ ] `propose_authority_change(new)` → `accept` до configured slot delay
  → `TimelockNotExpired`; measure wall-clock delay separately.
- [ ] `set_paused(true)` → `mint_badge_core/compressed/pay_entry` → `Paused`.
- [ ] `solana --version` на RPC >=3.0.14, иначе — не деплоить.
- [ ] Operator-supplied asset proof/indexer latency and fallback RPC health
  are measured against the pinned deployment; no <500ms SLA is asserted here.

---

## 7. Стоимость и эксплуатационные измерения

В checkout нет подтверждённых CU, rent, SOL/USD или эксплуатационных
расчётов для assets CPI: Bubblegum/MPL Core paths compile-time disabled, а
validator и live RPC не запускались. Перед включением внешнего CPI оператор
должен получить measurements из pinned verifiable build и validator rehearsal,
сохранить их во внешнем release storage и повторно пройти ABI/custody review.
Эти значения нельзя выводить из этого runbook или считать частью release
approval.

---

*Связанные доки: `SOLANA_2026_PRODUCTION_RESEARCH.md`, `ASSETS_SECURITY_AUDIT_CHECKLIST.md`, `REWARD_SECURITY.md`, `SOLANA_ARCHITECTURE.md`, `DEVNET_RUNBOOK.md`.*
