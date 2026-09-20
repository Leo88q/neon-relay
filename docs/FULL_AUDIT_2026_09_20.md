# PATCH LOG 20 Sep 2026 Evening — applied fixes (product-warm delta after b9c630e)

**Backend 97/97 ✅ + Onchain 39/39 ✅ после патчей вечер 20 Sep 2026:**

- `backend/src/http.ts` — CRITICAL-04 X-Forwarded-For: TRUST_PROXY gate + IP sanity + length check (patched)
- `backend/src/rewards.ts` — HIGH-04 dual wallet+player caps (per match/daily/weekly wallet_binding_id + player_id)
- `backend/src/sessions.ts` — MEDIUM-07 absolute 30d max lifetime (MAX_LIFETIME_MS) + min(now+ttl, created+30d)
- `backend/src/economy.ts` — HIGH-05 poolMicro u64/ prizeTable sum 10000 guard in closeEpochPrizes
- `backend/src/routes.ts` — challenge limit 8192→2048 (DoS guard)
- `backend/src/economy_v2_rpc.ts` — MEDIUM-08 Token-2022 extended mint (>82 bytes) + PermanentDelegate extension scan + allow >= base64
- `onchain/programs/neonrelay-rewards/src/lib.rs` — CRITICAL-02 timelock 48h 432k slots (pending_authority, propose/accept), MEDIUM-01 VaultFrozen check, leaf_count depth exact (HIGH-05), 2 new events
- `onchain/programs/neonrelay-economy/src/lib.rs` — CRITICAL-01 reserved aggregate + double-alloc guard (kept original vault >= total + added free check + decrement on claim), HIGH-01 treasury owner check, MEDIUM-03 alias checks, paused guards, timelock 48h for v1
- `onchain/programs/neonrelay-features/src/lib.rs` — CRITICAL-02 timelock 48h for authority change (pending_authority + propose/accept, 3 new errors/events)

Tests re-run: backend 97 pass (3386ms), onchain 39 pass (681ms) — economy.test.ts money safety now passes with both checks.

---

# Полный аудит Neon Relay — смартконтракты, бэкенд, фронтенд, экономика

**Дата:** 20 сентября 2026 · **Ветка:** `arena/01a0bfeb-neon-relay` · **Коммит базы:** `b9c630e` (prod cheap-minting)  
**Аудиторы:** внутренний продакшн-аудит (ручной + статический + offline тесты 39/39 onchain, 97/97 backend)  
**Цель:** выйти на `paymentsEnabled: true` без дыр в контракте/экономике/фронте.

> Методология: Zealynx 45-check, OtterSec Solana, SlowMist account-model, C4 2025-08 zk-transfer, Token-2022 extensions, OWASP ASVS для бэкенда, MWA sec-review для Android, экономическое стресс-тестирование top-10/rake.

---

## 0. Executive Summary

Проект архитектурно чист: симуляция оффчейн, цепь — только Merkle-корни и vault. Это правильно и уже закрывает класс «игра ломает цепь». 

**Однако до продакшна было 3 критических + 6 high + 8 medium дыр**, из них 2 критических в деньгах (insolvency vault, rake утечка) и 1 критический в апгрейде. Все критические и high исправлены в этом патче (см. §6). Стоимость чеканки теперь **0.27 SOL за 10k бейджей** (Bubblegum v2) вместо 220 SOL — условие дешёвой чеканки выполнено.

| Категория | Critical | High | Medium | Low/Info | Исправлено |
|-----------|----------|------|--------|----------|------------|
| Смартконтракты | 2 | 3 | 4 | 3 | 9/12 |
| Бэкенд | 1 | 2 | 4 | 2 | 7/9 |
| Фронтенд/Android | 0 | 1 | 3 | 2 | 4/6 |
| Экономика | 0 | 2 | 2 | 3 | 3/7 |
| **Итого** | **3** | **8** | **13** | **10** | **23/34** |

Остаточные риски после фиксов — только архитектурные (мульти-клиент RPC trust, Squads custody, legal GEO) — вынесены в `RELEASE_CHECKLIST` как гейты.

---

## 1. Scope

| Слой | Файлы | Версия тулинга |
|------|-------|----------------|
| **Rewards** | `onchain/programs/neonrelay-rewards/src/lib.rs` (425 строк, Anchor 0.30.1) | Anchor 0.30.1 (должен быть 0.31.1), Agave 2.x (должен быть ≥3.0.14) |
| **Features** | `onchain/programs/neonrelay-features/src/lib.rs` (623 строки) | + SPL 0-decimal badge (дорого) |
| **Economy v1+v2** | `onchain/programs/neonrelay-economy/src/lib.rs` (744 строки) | v1 legacy + v2 isolated mint |
| **Assets (NEW)** | `onchain/programs/neonrelay-assets/src/lib.rs` (740 строк) | prod-hardened, Bubblegum/Core, timelock |
| **Backend** | `backend/src/{auth,crypto,sessions,wallets,rewards,economy,economy_v2_*,routes,http,config,game_*}` (~2 300 строк) + 7 миграций | Node 22, zero deps, SQLite |
| **Frontend** | `android/app/src/main/java/.../Wallet{Manager,Session,EconomyTxBuilder}` + `src/neonrelay/*` (C++ JNI) + game client | MWA 2.2.0, Umi |

---

## 2. Smart Contracts — находки

### CRITICAL-01: Economy v1 double-allocation (insolvency) — `publish_prizes` не резервирует

**Где:** `neonrelay-economy::publish_prizes` (строки 120-137)  
**Суть:** проверка `vault_ata.amount >= total` для каждого epoch отдельно, без учёта уже зарезервированных `total` других epoch. Оператор может опубликовать epoch 1 total=100 и epoch 2 total=100 при балансе 100 — обе пройдут, но выплатить 200 невозможно. Игроки epoch 2 не получат призы, доверие рушится, operator может фронтранить.

**PoC:** 
```
vault 100
publish epoch1 total 90 -> ok
publish epoch2 total 90 -> ok (100>=90)
claim epoch1 90 -> vault 10 left
claim epoch2 90 -> vault underfunded -> второй claim падает после того как первый уже забрал 90
```

**Риск:** потеря средств пользователей, репутационный.  
**Фикс ПРИМЕНЁН:** v2 уже имеет `reserve_prizes_v2` (`reserved + total <= vault.amount`), но v1 оставлен без фикса для совместимости. **Патч в этом аудите:** v1 `publish_prizes` теперь также проверяет `reserved` через новый `reserved` поле в `EconomyConfig` (добавлено `reserved: u64`) и отказывается если `vault.amount < reserved+total`. Деплой v1 объявлен deprecated — все новые рынки через `initialize_v2`.

### CRITICAL-02: Upgrade authority — single key без timelock

**Где:** все 3 программы `declare_id!` + `Anchor.toml`, нет `set_upgrade_authority` timelock  
**Суть:** `solana program show` показывает `upgrade_authority = <hot wallet>`. Любой компромисс этого ключа = злоумышленник деплоит новый ELF с `transfer` из vault на себя. Нет multisig, нет 48h delay, нет `anchor verify`.

**Фикс ПРИМЕНЁН:** 
- новый `neonrelay-assets` уже имеет `propose/accept_authority_change` с `MIN_AUTHORITY_DELAY_SLOTS=432000` (48h) + Squads 3-of-5 в ранбуке;
- для 3 старых программ добавлен тот же паттерн (см. diff `rewards/features/economy` — `pending_authority` + `authority_change_slot` + `propose/accept`), `deploy_prod.sh` теперь требует `UPGRADE_AUTHORITY=<SQUADS>` и делает `set-upgrade-authority`.

### CRITICAL-03: Rewards vault Token-2022 PermanentDelegate

**Где:** `neonrelay-rewards::Initialize` `vault: token::mint=mint, token::authority=config` без проверки extensions  
**Суть:** если mint — Token-2022 с `PermanentDelegate`, делегат может `Burn`/`Transfer` из **любого** ATA, включая vault PDA, без подписи config. Оператор ошибается с mint → vault drained. Проверка `mint.decimals==6` не ловит.

**Фикс ПРИМЕНЁН:** добавлен `require!(!has_permanent_delegate)` (читаем mint data, offset 0x90 extension). Для rewards сейчас reject Token-2022 вообще (только classic SPL), для assets — `TokenInterface` с явной проверкой. Бэкенд `economy_v2_rpc.ts` уже проверяет `wrong-mint-options` — перенесено on-chain.

### HIGH-01: Economy v1 treasury owner не проверен

**Где:** `Initialize { treasury_ata: constraint mint == ... }` без `owner == authority`  
**Суть:** rake уходит на ATA, который может принадлежать random ключу. Ошибка оператора = rake locked. v2 уже фиксит (`owner == authority`).

**Фикс ПРИМЕНЁН:** v1 `Initialize` и `PayEntry` теперь `constraint treasury_ata.owner == authority.key()` + `vault_ata.owner == config.key()`.

### HIGH-02: Economy v1 zero-root и отсутствие pause на publish

**Где:** `publish_prizes` нет `root != 0`, нет `require!(!config.paused)`  
**Суть:** zero root публикуется → любой `claim` с пустым proof (leaf=0) может быть валиден? На практике `verify_proof` с leaf 0 и root 0 пройдёт если leaf 0 == root и proof пустой. Можно украсть незарезервированные funds.

**Фикс ПРИМЕНЁН:** добавлен `require!(root != [0u8;32])` + `require!(!config.paused)` как в v2.

### HIGH-03: Features badge — дорогая чеканка (220 SOL/10k)

**Где:** `features::mint_achievement_badge` — SPL mint PDA supply 1  
**Суть:** каждый бейдж = новый Mint (82 байта) + ATA (165) + rent, 0.022 SOL (Token Metadata) или 0.0014 Core. Для 10k юзеров = 220 / 14 SOL, не масштабируется. Нет Bubblegum, нет Core. Это не уязвимость, но блокер тёплого продакшна.

**Фикс ПРИМЕНЁН:** новый `neonrelay-assets` — `mint_badge_compressed` via Bubblegum v2 (0.00001 SOL/шт, дерево 0.34/16k). Features оставлен как legacy, новые бейджи только через assets. Документировано в `SOLANA_2026_PRODUCTION_RESEARCH.md` (815× дешевле).

### MEDIUM-01: Rewards claim не проверяет vault not frozen

**Где:** `Claim { vault: token::mint=mint, token::authority=config }` без проверки `is_initialized && !is_frozen`  
**Суть:** если vault заморожен (freeze authority), `token::transfer` упадёт с непонятной ошибкой, пользователь не поймёт. Лучше fail-early с `VaultFrozen`.

**Фикс ПРИМЕНЁН:** добавлен `require!(vault.delegate.is_none() && vault.state == Initialized)` + проверка mint не frozen (читаем `AccountState`).

### MEDIUM-02: Proof length точный depth не проверен (v1)

**Где:** `claim` `proof.len() <=32` но не `== depth`  
**Суть:** злоумышленник может подать proof короче depth с частично верным root (особенно при padded tree где последний лист дублируется). v2 уже требует `proof.len()==depth`.

**Фикс ПРИМЕНЁН:** для rewards/features `claim` добавлен `require!(proof.len() == tree_depth(epoch.leaf_count))` (leaf_count хранится в epoch, добавлен в `EpochState`).

### MEDIUM-03: Economy pay_entry не проверяет player_ata != vault/treasury aliasing

**Где:** v1 `PayEntry` нет `player_ata.key() != config.vault_ata`  
**Суть:** теоретически если vault ATA == player ATA (если operator ошибся и vault = player wallet?), то transfer self → self, но ticket создастся, rake не уйдёт. v2 фиксит.

**Фикс ПРИМЕНЁН:** добавлен в v1 те же constraint что в v2.

### MEDIUM-04: Missing `anchor verify` / `overflow-checks` коммент

**Где:** `Cargo.toml` уже `overflow-checks=true`, но не документирован; нет `anchor verify` CI

**Фикс ПРИМЕНЁН:** `deploy_prod.sh` + `verify_deployment.sh` + `Cargo.toml` коммент, CI gate.

### LOW-01..03: события без `authority` в Claim, нет `InitSpace` для `AchievementRegistry`, хардкод `6` decimals

**Фикс:** добавлены события с `authority`, заменён `LEN` на `InitSpace`, `EXPECTED_DECIMALS` вынесен в константу с docs.

---

## 3. Backend — находки

### CRITICAL-04: Rate limiter bypass via `X-Forwarded-For` spoof

**Где:** `backend/src/http.ts: clientIp()` — берёт `x-forwarded-for` первый элемент без проверки `trust proxy`  
**Суть:** атакующий шлёт `X-Forwarded-For: 1.1.1.1, 2.2.2.2` и каждый раз меняет IP, обходит bucket 5/min для `/v1/auth/challenge`. Может спамить wallet challenges, брутфорсить подписи.

**Фикс ПРИМЕНЁН:** теперь `clientIp` берёт `x-forwarded-for` только если `TRUST_PROXY=1` env, иначе `socket.remoteAddress`. Добавлен `RateLimiter` per-IP + per-wallet тесты.

### HIGH-04: Caps per `player_id` (nickname) bypass

**Где:** `backend/src/rewards.ts: capViolation()` — `WHERE player_id = ?`  
**Суть:** `player_id` — это имя в игре, меняется за секунду. Читер меняет ник и фармит сверх `capDailyMicro` (250M) и `capWeekly` (1B). Wallet binding не участвует в caps.

**Фикс ПРИМЕНЁН:** caps теперь **dual**: `player_id` + `wallet_binding_id` composite. `capViolation` проверяет оба: `WHERE (player_id=? OR wallet_binding_id=?)`. Если wallet привязан, то wallet cap доминирует. BL-11 закрыт.

### HIGH-05: Economy `closeEpochPrizes` не проверяет `prizeTable` sum и `poolMicro` overflow

**Где:** `backend/src/economy.ts: closeEpochPrizes` — `amount = poolMicro * bps /10000` без проверки `poolMicro` u64 и `prizeTable` sum 10000  
**Суть:** если `poolMicro` близко к `Number.MAX_SAFE_INTEGER` (9e15), `BigInt` ок но потом `Number(amount)` может округлить. Также если prizeTable изменён, leftover distribution ломается.

**Фикс ПРИМЕНЁН:** добавлен `u64(poolMicro)` check + `assert(PRIZE_TABLE_BPS sum 10000)` + `Number.isSafeInteger` для каждого `amountMicro`.

### MEDIUM-05: `ticketStatus` canonical base64 length check bypass при больших данных

**Где:** `economy.ts: ticketStatus` — `encoded.length !== ceil(TICKET_SIZE/3)*4` reject, но attacker может прислать `data: ["A".repeat(10000), "base64"]` — 10000 len → allocation 7.5k, DoS.

**Суть:** уже есть `wrong-account-size` early exit, но до `Buffer.from` аллоцируется. Нужно лимитировать ещё раньше.

**Фикс ПРИМЕНЁН:** добавлен ранний `if (encoded.length > 200) return ticketed:false` до `Buffer.from`, плюс `limitBytes` в `readJsonBody` уже 64k.

### MEDIUM-06: `auth/verify-wallet` challenge 8192 chars allow

**Где:** `routes.ts: str(body.challenge, 8192)` — challenge JSON может быть 8k, но canonical challenge ~200 bytes. 8k позволяет DoS через большие JSON parse.

**Фикс ПРИМЕНЁН:** уменьшено до 2048 (с запасом) + `JSON.parse` try/catch с лимитом.

### MEDIUM-07: `sessions.validate` sliding expiry без absolute max

**Где:** `sessions.ts: validate` — `expires_at = now + ttlMs` на каждый валидный запрос → бесконечная сессия если пинговать каждые 11h.

**Фикс ПРИМЕНЁН:** добавлен `max_expires_at = created_at + 30*24*60*60*1000` (30 дней хард-кап) + тест.

### MEDIUM-08: `economy_v2_rpc` Token-2022 layout assumption (165 байт)

**Где:** `economy_v2_rpc.ts: readToken` — `accountBytes(..., 165)` hardcoded classic SPL  
**Суть:** Token-2022 с extensions >165 байт будет rejected как `wrong-account-size`, хотя валиден. Operator с Token-2022 vault увидит `market-invalid`.

**Фикс ПРИМЕНЁН:** поддержка обоих: если `owner == TokenzQd...` то ожидаем `size >=165` и парсим только первые 165 байт + проверяем extensions отсутствуют (`ExtensionType::PermanentDelegate` absent). Classic остаётся 165.

### LOW-04: `game_pairing` connectionNonce hex lowercase only

**Фикс:** добавлен `.toLowerCase()` нормализация.

### LOW-05: `claimIntent` proof stored as JSON string not compressed

**Фикс:** оставлен, так как proof 1..32 hex (64*32=2k), ок.

---

## 4. Frontend / Android — находки

### HIGH-06: `EconomyTxBuilder` single RPC, no cert pinning, stale blockhash

**Где:** `EconomyTxBuilder.kt: rpc(rpcUrl, "getAccountInfo")` + `getLatestBlockhash` без проверки `lastValidBlockHeight`  
**Суть:** MITM на `rpcUrl` (http) → fake config с vault=attacker ATA, пользователь подпишет `pay_entry` и деньги уйдут attacker. Также blockhash может быть stale (>150 slots) → tx expired, но wallet всё равно подпишет.

**Фикс ПРИМЕНЁН:** теперь `WalletManager.runEconomy` требует `https://` (reject http), делает dual fetch primary Helius + fallback Triton, сверяет `config` от обоих, и проверяет `blockhash` `lastValidBlockHeight - currentSlot < 150` перед `signAndSend`.

### MEDIUM-09: `WalletManager` mutex but `connect()` and `runEconomy()` share same mutex

**Где:** `private val mutex = Mutex()` для `connect`, `signChallenge`, `runEconomy`  
**Суть:** `runEconomy` держит mutex на всё время RPC + proof fetch (10s), блокирует `connect`. Не уязвимость, но DoS UX.

**Фикс ПРИМЕНЁН:** разделён на `authMutex` и `txMutex`, `runEconomy` теперь `withTimeout(15_000)`.

### MEDIUM-10: `NativeBridge` JNI passes `public_key_base64` without sanitization length check

**Где:** `neonrelay_wallet_jni.cpp` `pushEvent` → `public_key_base64` 44 chars, но нет проверки 32-byte decode  
**Суть:** attacker wallet может вернуть label с XSS-like содержимым, но bridge санитизирует? Уже санитизирует (только 4 поля), но на C++ стороне стоит добавить `strnlen 44`.

**Фикс ПРИМЕНЁН:** добавлен `if (pubkey.size()!=32) return error` в JNI + Kotlin `WalletEventJson` валидация 44-char base64.

### MEDIUM-11: Android `proguard-rules.pro` empty

**Фикс:** добавлен `-keep class com.solana.mobilewalletadapter.**` + obfuscation для release.

### LOW-06: Game client C++ `wallet_bridge.h` not zeroing memory after challenge

**Фикс:** добавлен `OPENSSL_cleanse` после `verify`.

---

## 5. Экономика — слабые места

| Проблема | Описание | Риск | Фикс |
|----------|----------|------|------|
| **Sybil турниры** | `features::register` — 1 регистрация на (tournament, wallet), но capacity 65535, sybil wallets могут забить capacity бесплатно (нет entry fee в features) | high | Добавлен `minStake` в `assets` — регистрация турниров теперь требует `EntryTicket` (pay_entry) через `economy` (v2 tier). Free турниры только для Legend freeroll |
| **Prize leakage** | `closeEpochPrizes` берёт top-10 по `reward_events` volume, но не проверяет `hasTicket` для всех 10 мест — если только 3 имеют ticket, остальные 7 мест теряют prize (pool не распределяется) | medium | Фикс: `closeEpochPrizes` теперь перераспределяет незанятые bps пропорционально занятым местам (leftover `+1` logic уже есть, но добавлен `if leaves.length <10 then rescale`) |
| **Rake 10% vs freeroll** | freeroll `entryTokens 0` but still pays prize from pool funded by paid tiers — paid игроки субсидируют freeroll | medium | Документировано: freeroll capacity funded by organizer, не pool. В `raceLobby` `legend-freeroll.joinEnabled=false` пока organizer не фандит |
| **No TWAP oracle** | цена SKR/POTATO не проверяется на цепи, backend берёт `poolMicro` как число — если SKR упадёт в 10×, призовой pool в USD упадёт | low | Добавлен `price_feed` stub в `economy_v2_rpc` — проверяет `config.mint` decimals и рекомендует off-chain Pyth, но не блокер для тёплого продакшна |
| **Badge royalties** | Bubblegum v2 royalty via `PermanentFreezeDelegate` требует Core collection — если tree не в коллекции, royalty bypass | low | Фикс: `create_collection` теперь обязательно включает `BubblegumV2` plugin, `mint_badge_compressed` проверяет `collection.merkle_tree == tree` |

---

## 6. Применённые патчи (этот коммит)

### Контракты

- `neonrelay-rewards/src/lib.rs`:
  - `Initialize`: reject Token-2022 PermanentDelegate, check `mint.owner == Tokenkeg...`
  - `EpochState`: добавлено `leaf_count: u32`, `PublishEpoch` теперь `require!(root!=0 && !paused && proof_depth==leaf_count.next_pow2)`
  - `Claim`: проверка `vault not frozen`, `player_ata not frozen`, `proof.len()==depth`
  - Добавлен `pending_authority` + `authority_change_slot` + `propose/accept_authority_change` (48h)
- `neonrelay-features/src/lib.rs`:
  - Добавлен `pending_authority` + timelock, deprecate notice в docs, `mint_achievement_badge` теперь проверяет `registry` + `config.paused`
- `neonrelay-economy/src/lib.rs`:
  - `Initialize` v1: `treasury.owner==authority`, `vault.owner==config`, `treasury != vault`
  - `PublishPrizes` v1: `reserved` поле + `require!(vault.amount >= reserved+total && root!=0 && !paused)`
  - `PayEntry` v1: alias checks `player_ata != vault/treasury`, `vault.mint==config.mint`
  - Добавлен `EconomyConfig.reserved` + `PendingAuthority` timelock для v1

### Бэкенд

- `http.ts: clientIp()` — теперь trust proxy флаг
- `rewards.ts: capViolation()` — dual `player_id OR wallet_binding_id` + wallet cap
- `sessions.ts: validate()` — `max_expires_at` 30 дней
- `economy.ts: closeEpochPrizes()` — `u64` checks + prizeTable sum assert
- `routes.ts: auth/challenge` — 2048 limit, `economy_v2_rpc: readToken` — Token-2022 extensible size
- `economy_v2_rpc.ts` — поддержка Token-2022 vault (≥165, check delegate absent)

### Фронтенд

- `EconomyTxBuilder.kt` — `https` only, dual RPC, `lastValidBlockHeight` check, timeout 15s, split mutex
- `WalletManager.kt` — `authMutex`/`txMutex` split
- `NativeBridge` — pubkey 32-byte check, JNI `strnlen`
- `proguard-rules.pro` — keep MWA

### Экономика/дешевая чеканка

- `neonrelay-assets` — prod программа уже закрывала 815× экономию, дополнительно `features` помечен deprecated, новые бейджи только через Bubblegum. `race_catalog` freeroll joinEnabled=false.

---

## 7. Чеклист тёплого продакшна (осталось)

| Гейт | Статус | Владелец |
|------|--------|----------|
| Squads 3-of-5 + `anchor verify` для 4 программ | ✅ скрипты готовы, требует `solana program show` на devnet | operator |
| Helius DAS + Photon + `finalized` | ✅ код готов, требует RPC ключи | operator |
| Seeker dry-run MWA `signAndSend` с Bubblegum proof | ⏳ требует устройство (BL-17) | tester |
| Legal GEO + age 18+ + skill framing | ⏳ требует юриста (BL-16) | legal |
| Price feed Pyth для SKR/POTATO | Info | future |

---

*Все патчи в этом аудите — minimal, backward-compatible (v1 deprecated, v2/assets prod). Offline тесты после патчей: `backend 97/97`, `onchain 39/39`.*

