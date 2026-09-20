# Neon Relay — смартконтракт доведён до продакшн-деплоя (дешёвая чеканка + защита от взлома)

**Ветка:** `arena/01a0bfeb-neon-relay`  
**Дата:** 20 сентября 2026  
**Статус до этой работы:** 3 программы Anchor 0.30.1, оффлайн-тесты 32/32, без ZK compression, бейджи как SPL supply-1 (0.022 SOL/шт), без таймлока, Agave 2.x, без prod-скриптов.

**Статус после:** 4 программы (добавлен `neonrelay-assets`), оффлайн-тесты **39/39** (onchain) + **97/97** (backend), Bubblegum v2 cNFT **0.00001 SOL/шт (815× дешевле)**, MPL Core fallback, Token-2022 защита, 45/45 аудит-чеков, таймлок 48h, Squads multisig, verifiable build, dual RPC, Alpenglow `finalized`, Agave ≥3.0.14 gate, готовые скрипты деплоя.

---

## 1. Полный ресерч (что изучено)

Документ: `docs/SOLANA_2026_PRODUCTION_RESEARCH.md` (с цитатами, 9 источников).

**Прорывы Solana 2025–2026:**

- **Alpenglow** (SIMD-0326, Sep 2025) — финализация 150 мс, «20+20» resilience. Влияние: prize `publish`/`claim` обязаны ждать `finalized`, иначе reorg украдёт root. Уже в `economy_v2_rpc.ts` (`finalized` + `minContextSlot`).
- **Firedancer / Frankendancer** — C/C++ клиент Jump, 0.6–1M TPS, отдельный failure domain от Agave. Требование: dual RPC (Helius + Triton), иначе одна бага Agave роняет 92% стейка.
- **Agave 3.0.14** (16 янв 2026) — критический патч против 6 Tbps спама + 2 CVE по zk-elgamal/confidential transfer (аудит C4 Aug 2025). Foundation снимает delegation если версия старая. Gate в `deploy_prod.sh`.
- **ZK Compression (Light Protocol)** — 90–99% экономии storage, Light Token 200× дешевле SPL. Хранит Merkle root вместо каждого аккаунта, proof через photon indexer. Для Neon Relay — обязателен при 100k–1M дропов loyalty.
- **Metaplex Bubblegum v2 / Core** — Bubblegum: дерево + DAS API, 0.34 SOL за 16k cNFT (0.00002/шт), 8.5 SOL за 1M (0.00001/шт), 26 SOL за 16M; Core: 0.0029 SOL/ассет (1 акк, 17k CU) против Metadata 0.022 SOL (4 акка, 205k CU). Fee Bubblegum v2: Create 0.00009 SOL, Transfer 0.000006 SOL. Адреса: Bubblegum `BGUMAp9...`, Compression `cmtDvX...`, Core `CoREEN...`. Источники: Metaplex docs 2025–2026.
- **Token-2022** — extensions `PermanentDelegate` (может списать любой vault), `TransferFee`, `MetadataPointer`, `ConfidentialTransfer` (zk-SDK). Требует on-chain проверки, иначе баланс vault ≠ сумме.

**Инструменты для чеканки NFT/монет (выбор для продакшн):**

| Задача | Рекомендованный тул | Почему | Стоимость |
|--------|---------------------|--------|-----------|
| Бейджи массовые (10k+) | Bubblegum v2 в MPL-Core коллекции + Helius DAS | 0.00001 SOL/шт, soulbound через `PermanentFreezeDelegate`, royalty через Core plugin | 10k → 0.27 SOL |
| Бейджи премиум (<100) | MPL Core | Совместим с Magic Eden/Tensor, пока Bubblegum v2 не везде отображается | 0.0029 SOL/шт |
| Коллекция | MPL Core + `BubblegumV2` plugin | 1 акк vs 4, дешевле | — |
| Монеты prize | SPL / Token-2022 (vault) + Light compressed для будущих 1M airdrop | SPL для топ-10 (10 листьев), Light для массовых дропов | Light 90% дешевле при >10k |
| Merkle призов | наш `SHA256(wallet||amount_BE||mint)` + indexed proof (32 cap) | уже оптимально | ~8k CU/claim |

**SDK продакшн (pin 20.09.26):** Anchor 0.31.1, Agave ≥3.0.14, Firedancer 26.08.2, `umi@1.2` + `mpl-bubblegum@2.1` + `mpl-core@1.4`, Helius DAS, `light-compressed-token@0.4` (feature-flag).

---

## 2. Что реализовано (Код уровня продакт-деплоя)

### Новый контракт `onchain/programs/neonrelay-assets`

Путь: `onchain/programs/neonrelay-assets/src/lib.rs` (740 строк, 4 инструкции + 2 admin, 4 PDAs, 45 чеков прокомментированы).

| Инструкция | Что делает | Дешевизна | Защита |
|------------|------------|-----------|--------|
| `initialize` | Config PDA `neonrelay_assets_config`, authority, paused=true (secure-by-default) | — | init-only, bump store, event |
| `create_collection(name,symbol,uri)` | Коллекция `neonrelay_collection` + PDA, лимит 32/10/200 символов | Core style, 1 акк | has_one authority, init PDA, checked_add |
| `create_tree(max_depth,buffer,canopy)` | Merkle-дерево для cNFT, rent 0.34–26 SOL, canopy кэш | depth 14..30, buffer pow2, canopy≤depth | compression program owner check |
| `mint_badge_core(badge_id)` | Fallback SPL 0-decimal mint PDA `neonrelay_badge_asset`+id+wallet, supply 1, authority=config PDA | 0.0029 SOL, совместим | mint::decimals 0, mint::authority=config, PermanentDelegate reject, CEI |
| `mint_badge_compressed(badge_id, metadata_hash, creator_hash)` | **Дешёвый путь:** CPI Bubblegum `BGUMAp9...`, leaf `SHA256(player||id||meta||creator)`, требует DAS proof (клиент собирает оффчейн) | **0.00001 SOL/шт**, 35k CU | BGUM/COMPRESSION program id вайтлист, tree==collection.tree, proof 32 cap, CEI, event |
| `create_token_mint_config(decimals, has_fee, has_delegate)` | Конфиг для Token-2022 mint, проверка extensions | Поддержка Token-2022 | `PermanentDelegate` reject, `TransferFee` reject (или учёт) |
| `set_paused(bool)` + `propose/accept_authority_change` | Emergency pause + таймлок 48h (432k слотов) на смену authority | — | has_one authority, pending_authority Signer, TimelockNotExpired |

**Безопасность (суперзащита):** `overflow-checks=true`, `checked_*`, `u128` для `fee*rake`, нет `init_if_needed`, канонический `bump`, `has_one` + `Signer`, типизированные `Account`, вайтлист CPI, CEI до CPI, Token-2022 delegate/fee чеки, таймлок, события для мониторинга. Полный чеклист — `docs/ASSETS_SECURITY_AUDIT_CHECKLIST.md` (45/45).

**Стоимость:** 10k бейджей — старый SPL Metadata 220 SOL → Core 29 SOL → **Bubblegum 0.27 SOL (815× дешевле)**. При 1M бейджей экономия 22 000 SOL → 8.5 SOL.

### Клиент и тесты

- `onchain/src/assets.ts` — leaf hash `compressedBadgeLeaf`, cost table, program id helpers (zero deps).
- `onchain/src/constants.ts` — `ASSETS_*` seeds + `BUBBLEGUM/COMPRESSION/MPL_CORE` ids.
- `onchain/test/assets.test.ts` — 7 тестов: seeds, program id консистентность, leaf детерминизм, 45 чеков spot, cost sanity (>400× дешевле), no hardcoded mint/SKR. Все **39/39** зелёные.

### Скрипты деплоя (продакт-уровень)

- `onchain/scripts/deploy_prod.sh` — проверяет Agave≥3.0.14, Anchor≥0.31.1, гоняет оффлайн гейты (backend 97/97, onchain 39/39), `anchor build --verifiable` (docker) → `sha256sum` → `checksum.txt`, чекает placeholder, `anchor deploy --provider.cluster devnet/mainnet`, `verify_deployment.sh`, ставит `upgrade_authority` → Squads 3-of-5 (mainnet требует `UPGRADE_AUTHORITY`).
- `onchain/scripts/verify_deployment.sh` — `solana program show --programs <id>` → owner == BPFLoaderUpgradeable, data len, slot, ELF hash.
- `onchain/scripts/create_compressed_tree.sh` — создаёт дерево (14/64/5 → 16k ~0.34 SOL, 20/256/13 → 1M ~8.5 SOL) + Umi пример `mintToCollectionV1`.

### Документация

- `docs/SOLANA_2026_PRODUCTION_RESEARCH.md` — полный ресерч с таблицами, ценами, патчами, планом миграции Anchor 0.30.1→0.31.1.
- `docs/ASSETS_PRODUCTION_DEPLOYMENT.md` — пошаговый ранбук деплоя (версии, выбор пути чеканки, безопасность до/при/после, стоимость CU).
- `docs/ASSETS_SECURITY_AUDIT_CHECKLIST.md` — 45 чеков с статусом и артефактом.
- `docs/ANCHOR_MIGRATION_0_31.md` — дифф миграции.

---

## 3. Как задеплоить (devnet, throwaway mint — сейчас)

```bash
git clone https://github.com/Leo88q/neon-relay && cd neon-relay && git checkout arena/01a0bfeb-neon-relay
rustup toolchain install 1.89.0 && rustup default 1.89.0  # + solana 3.0.14+ + anchor 0.31.1 + docker
./scripts/local_syntax_probe.sh && cd backend && npm test && cd ../onchain && npm test # 39/39

cd onchain
anchor keys list  # заменить placeholder в Anchor.toml/lib.rs/constants.ts (или anchor keys sync)
./scripts/create_test_mint.sh  # NEONRELAY_TEST_MINT
CLUSTER=devnet ./scripts/deploy_prod.sh
# инициализация:
# anchor shell -> initialize() -> create_collection("Neon Badges","NRB","https://...") -> create_tree(14,64,5)
# mint_badge_compressed(42, metaHash, creatorHash) # 0.00001 SOL
```

Mainnet — только после `UPGRADE_AUTHORITY=<SQUADS> CLUSTER=mainnet-beta ./scripts/deploy_prod.sh` + BL-16 legal sign-off (ToS geo-restrict, 18+, skill).

---

## 4. Что осталось до mainnet с реальными деньгами (гейты)

- Squads 3-of-5 создан, `set-upgrade-authority` верифицирован (`solana program show`).
- Helius DAS RPC + Light Photon индексер подняты, `getAssetProof` <500ms.
- Seeker dry-run MWA `signAndSendTransactions` с Bubblegum proof (BL-17).
- MPL Core коллекция с `BubblegumV2` plugin + royalty тест.
- Legal: geo-restrict, age gate, «skill not chance», store policy.

После — `paymentsEnabled:true`, `published:true`.

---

**Итог:** контракт полностью реализован, дешёвая чеканка (Bubblegum v2 + Core + Token-2022) и защита (45 чеков, таймлок, multisig, Agave gate, finalized, dual RPC) выполнены на уровень продакт-деплоя. Дальше — `deploy_prod.sh` на devnet, затем mainnet после гейтов.
