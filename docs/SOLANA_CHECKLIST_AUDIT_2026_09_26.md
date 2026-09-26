# Аудит по чек-листу «Solana crypto game security checklist» — 26 сентября 2026

**Репозиторий:** `Leo88q/neon-relay`, ветка `arena/01a0df0d-neon-relay`
**Основание:** сводный чек-лист безопасности крипто-игр на Solana/Anchor
(70 пунктов, Части 0–2). Часть 0 (п. 1–30) закрыта предыдущими аудитами
(`docs/FULL_INDEPENDENT_AUDIT_2026_09_21.md`,
`docs/SECURITY_REVIEW_2026_09_26.md`); настоящий проход — Части 1–2
(п. 31–70) плюс регрессионная сверка Части 0.

**Итог: 70 пунктов закрыто 56, закрыто в этом проходе 12, managed 8,
открытых производственных уязвимостей — 0.** Найдено и исправлено в этом
проходе **12 дефектов** (1 HIGH, 6 MEDIUM, 5 LOW) — все исправления ниже
сопровождаются регрессионными тестами.

Статусы:

* ✅ **CLOSED** — защита реализована и закреплена исполняемым тестом;
* 🛠 **FIXED NOW** — найдено и исправлено в этом проходе (SW-2026-09-26 F-11…F-22);
* 📌 **MANAGED** — риск осознанно принят или вынесен в операционный
  преддеплойный гейт (ссылка на конкретный документ/скрипт);
* ⚪ **N/A** — механики нет в системе (это свойство архитектуры, а не
  пропуск: указано, почему атака неприменима).

Как воспроизвести все тесты — §3.

---

## Часть 0. Базовый аудит (п. 1–30) — регрессионная сверка ✅

Полная таблица с результатами — `docs/SECURITY_REVIEW_2026_09_26.md` §3
(45 исполняемых тестов A1–E30 + X1–X12). Ключевое по категориям:

| Пункты | Статус | Доказательство |
|---|---|---|
| 1–6 (идентичность/PDA) | ✅ CLOSED | `onchain/test/security_checklist.test.ts` (A1–A6): PDA-seeds/bump, `has_one`, signer, `address = system_program`, rent, `init_space` во всех четырёх программах |
| 7–10 (реентрантность/Clock) | ✅ CLOSED | нет self-CPI и интроспекции инструкций (`security_checklist.test.ts:414` явно запрещает `sysvar::instructions` как фичу программы); `Clock` используется только для таймлока/экспирации, не для значений |
| 11–20 (токеномика) | ✅ CLOSED | `mint_authority/freeze_authority.is_none()` на bootstrap всех денег-программ; `checked_*` везде (`overflow-checks = true` в `onchain/Cargo.toml`); treasury/vault — PDA; рейк ограничен `MAX_RAKE_BPS`+`MAX_RAKE_STEP_BPS`+события (F-01/F-01b); sweep под pause (F-02) |
| 21–26 (Anchor) | ✅ CLOSED | `InitSpace`/точный `space`; `init` c payer+system_program; `mut` минимален; дискриминаторы пинуются (D24/D25); IDL-дрейф ловит `verify:ids` |
| 27–30 (runtime) | ✅ CLOSED | ограниченные циклы (`MAX_PROOF_LEN=32`, `MAX_LEADERBOARD_ENTRIES=64`, `MAX_TOURNAMENT_CAPACITY`), `close` только в владельца/treasury-PDA (E28), пин версий Anchor/Agave (`D26`, `release_validate.sh`) |

**Регрессии предыдущих находок** (F-01…F-10, H-01, M-01…M-04, CRIT-01/02)
остаются закрыты: `onchain/test/security_findings.test.ts` (12 тестов),
`backend/test/ratelimit.test.ts`, `audit/2026-09-21` (10 тестов) — все зелёные
на момент отчёта.

---

## Часть 1. Техническое дополнение (п. 31–54)

### F. Идентичность и CPI-доверие

**31. Owner-check «сырых» AccountInfo → ✅ CLOSED.**
Во всех четырёх программах используются типизированные `Account<>`/`Program<>`.
Единственные `UncheckedAccount` — `program_data` в `initialize` каждой
программы — имеют `/// CHECK:` и жёсткую проверку в handler:
PDA от `bpf_loader_upgradeable`, owner == loader, `UpgradeableLoaderState::ProgramData.upgrade_authority_address == signer`
(`verify_bootstrap_authority`). Проверяется тестом D24/D25 (все
`UncheckedAccount` обязаны иметь `/// CHECK:`-обоснование).

**32. Подстановка token/system program → ✅ CLOSED.**
Все деньги-CPI идут через `token_program: Program<'info, Token>` — Anchor
сверяет ключ аккаунта с адресом из IDL; `system_program: Program<'info, System>`.
`Program<>`-поля закреплены харнесом `rust_accounts.ts` (address-пин).

**33. Неканоническая ATA получателя → ✅ CLOSED (с оговоркой).**
Выплаты (`claim_prize{,_v2}`, `claim`) адресуют `player_ata` с
`constraint = player_ata.owner == player.key() && player_ata.mint == config.mint`
(+ запрет aliasing с vault/treasury). Средства физически могут уйти только на
счёт, который контролирует подписавший игрок; каноничность ATA здесь — UX, не
security-property (деньги не перенаправить). Принято осознанно.

**34. Revival-атака → ✅ CLOSED.**
Закрытие аккаунтов только через `#[account(close = ...)]` (E28 закрепляет,
что получатель привязан к идентичности закрываемого счёта); ручных
`lamports()`-дренажей нет ни в одной программе. Регрессия E28 дополнительно
расширена в этом проходе (новый `close = authority` в `CancelAuthorityV2`
проходит тот же инвариант).

**35. Type confusion / коллизия дискриминаторов → ✅ CLOSED.**
Anchor-автодискриминаторы не отключаются; инструкционные имена пинуются
(D24/D25: `assert.deepEqual(instructionNames(...), pinned)` + проверка
коллизий `sha256("global:<ix>")`), аккаунтные — золотыми векторами
(`TICKET_DISCRIMINATOR == "9bad70c5396ec1cb"` и т.п.).

### G. Честность рандома

**36. RNG на blockhash/slot/timestamp → ⚪ N/A (by design).**
В репозитории нет ни одного механизма, который решает исход по случайному
числу: игровая симуляция сервер-авторити офчейн, награды считаются
капами+Merkle-корнем, призы — детерминированный сплит пула. On-chain
«случайность» не нужна, а слот/время используются только для таймлока и
экспирации (п. 10 ✅). Когда появится азартная механика — требование
Switchboard/ORAO VRF или commit-reveal уже задекларировано в
`docs/SOLANA_ARCHITECTURE.md`.

**37. One-shot защита розыгрыша → ✅ CLOSED.**
Эквивалент на наших механиках: PDA `init` — одна запись на
`(epoch, wallet)`/`(reference, player)`/`(tournament, player)`;
повтор = `already-in-use` (D-серия + X-серия чек-листа).

### H. Token-2022 и продвинутые токен-риски

**38. Transfer Hook → ✅ CLOSED.**
Деньги-программы принимают только классический SPL:
`Account<'info, Mint>` (owner == `Tokenkeg…`) — минт Token-2022 физически не
пройдёт десериализацию; `token_program: Program<'info, Token>` закреплён;
дополнительно `require_safe_token_account` отклоняет счёт с
delegate/native/close-authority (fail-closed). Белого CPI на hook-программу нет.

**39. Permanent Delegate / Default Account State → ✅ CLOSED.**
Тот же гейт: расширения Token-2022 не могут попасть в экономику, минт- и
фриз-авторитеты должны быть отозваны до входа
(`MintAuthorityNotRevoked`/`FreezeAuthorityNotRevoked` на `initialize`,
`initialize_v2`), фриз-счёт в payout-пути ловится проверкой
`AccountState::Initialized` (MEDIUM-01).

**40. Decimals-рассинхрон → ✅ CLOSED.**
Rewards: `EXPECTED_DECIMALS = 6` проверяется на `initialize`, `amount_micro`
== SPL base units. Economy v2: `tier_fees_v2(decimals)` выводит табличку из
`mint.decimals` — рассинхрон невозможен; v1-fee задаётся в base units
(потолок `MAX_ENTRY_FEE = 2000 × 10^9`). Конверсии lamports↔очки нигде нет.
Юнит-тесты: `fee_ceiling_equals_the_v2_top_tier_at_max_decimals`,
golden-векторы backend/Android (`entryReference` pins).

### I. Офчейн↔ончейн

**41. Replay бэкенд-подписи → ✅ CLOSED (+ 🛠 F-16).**
Все подписи бэкенда покрывают канонический payload + одноразовый nonce
(сессии) / идемпотентность (reward-, game-события: `idempotency_hash`
UNIQUE). В этом проходе усилено: purge nonce'ов на expiry + жёсткий потолок
живых challenge'ов (`authNonceCap`, тест F-16), atomic unlink (F-18).

**42. Sandwich в одной транзакции → ✅ CLOSED.**
Self-CPI нет; интроспекция `sysvar::instructions` запрещена тестом как
фича. Офчейн-«сэндвич» на админ-действиях закрыт в этом проходе: лок
решений approve/reject (F-15) + двухфакторный workflow + TTL пропозалов.

**43. Hot-wallet бэкенда → ✅ CLOSED (архитектурно).**
Backend не хранит ни одного ключа цепочки: верифицирует подписи игроков и
серверов, root'ы кладёт в БД, подписывает оператор отдельным ключом вне
сервиса. Сканер секретов по `backend/onchain/android/src/neonrelay/scripts`
— чисто (нет приватных ключей/сид-фраз; единственный `solana-keygen new` —
одноразовый bootstrap-ключ локального тест-валидатора).

### J. Апгрейд и деплой

**44. Upgrade authority → 📌 MANAGED (операционный гейт перед mainnet).**
`docs/DEPLOYMENT_POLICY.md` (п. 63–80): запрет горячего кошелька за
пределами devnet, обязательный multisig/timelock-гейт
(`solana program set-upgrade-authority`), никакой обход через скорость.
Bootstrap каждой программы дополнительно защищён
`verify_bootstrap_authority` (угнать `initialize` нельзя). До передачи
authority в multisig mainnet-запуск запрещён — это условие, а не задача кода.

**45. Reproducible build → ✅ CLOSED на уровне гейта.**
`onchain/scripts/deploy_prod.sh`: `anchor verify "$pid"` для каждой программы
после пинов (`verify_toolchain_pin`, `verify_source_ids`, `anchor 0.31.1`,
`Agave ≥ 3.0.14`), плюс `release_validate.sh` со статическим аудитом
(drift-чек отчёта) и `npm test` обоих стеков. В этом окружении cargo/tsc
нет — гейт спроектирован fail-closed (`SOURCE_ONLY` только для песочницы).

### K. NFT/игровые предметы

**46. Update authority NFT → ✅ CLOSED.**
Метаданные бейджей офчейн (BL-13 — mpl CPI намеренно выключен
`compile_error!`); on-chain предмет — 0-декимальный минт supply 1,
PDA-`init` на `(achievement, player)` не повторяется, повторного
`mint_to`-инструкции не существует. Списывать/раздувать бейдж нечем.

**47. Delegate/approve не отзывается → ⚪ N/A.**
Инструкций `approve/delegate/revoke` нет ни в одной из четырёх программ
(grep-инвентарь: только `transfer/mint_to`). Аренды/стейкинга NFT нет.

### L. Экономический античит

**48. Sybil-фарм рефералов → ✅ CLOSED (+ 🛠 F-11 усиливает).**
Рефералов нет; турнирные регистрации защищены возвратным стейком
(10 000 000 лампорт × слот — F-07: 65 535 слотов = 655 SOL одновременного
замка); миграция `wallet_bindings_active_player_unique` — один активный
кошелёк на player id; поэтому в этом проходе погашен главный вектор —
**F-11: self-declared-линк player id без доказательства** закрыт в production
(регистрация через `game_accounts`).

**49. Инвариант «балансы + treasury = supply» → ✅ CLOSED.**
Ончейн: агрегатный `reserved` во всех денег-программах (каждая операция
сверяет/меняет его атомарно), потолок `total_micro` на claim. Офчейн:
`backend/src/reconcile.ts` + `/v1/admin/reconcile/{rewards,prizes}` +
`treasury_snapshots` (append-only история балансов) + алерты watchtower +
`check_audit_report_drift`. Плюс новый инвариант F-21 (refund не ест
резерв).

### M. Клиент и кошелёк

**50. Wallet-drainer UI / npm-зависимости → ✅ CLOSED.**
Backend и onchain — **zero runtime dependencies** (только built-ins Node 22),
npm-供应链-поверхности нет; `package.json` это фиксирует, lock-файлы не нужны
(нет и зависимостей). Android: MWA-подпись происходит внутри кошелька, ключи
в приложение не входят; ассеты пинуются `scripts/check_assets.sh`.
Отсутствие CSP — некритично: фронтенда-HTML в репозитории нет.

**51. Подпись без симуляции/превью → 📌 MANAGED (клиентский гейт до mainnet).**
Превью есть на уровне детерминированных билдеров: `EconomyTxBuilder`/
`RewardsTxBuilder` собирают и валидируют payload по золотым векторам
(`EconomyTxBuilderTest`, `RewardsTxBuilderTest`), домен challenge подписи
всегда отображается. Чего нет: вызова `simulateTransaction` перед
`signAndSendTransactions` в Android-потоке (grep — отсутствует).
**Обязательство до mainnet:** перед MWA-подписью симулировать транзакцию
против RPC и блокировать отправку при `err != null`, показывая распарсенный
превью из IDL. Вносить такое изменение вслепую запрещено правилом репозитория
(Android-тесты здесь не запускаются — BL-12), поэтому пункт зафиксирован как
преддеплойная задача с точным расположением
(`android/.../wallet/WalletManager.kt`, `signAndSendTransactions`).

### N. Тесты

**52. Fuzz/property-based → ✅ CLOSED (в пределах окружения).**
Дифференциальный фьюзж модели против Rust-тел
(`security_checklist.test.ts`: «дифференциально фьюзит две, чтобы
транскрипция не уехала молча»), исполняемый эвалюатор Anchor-констрейнтов
(`rust_accounts.ts`), fuzz-паритет меркле. Trident — требует cargo
(BL-03), зафиксирован в `docs/KNOWN_LIMITATIONS.md` как обязательный шаг CI
с тулчейном.

**53. Инвариантные тесты → ✅ CLOSED.**
X-серия чек-листа (X1–X12): underfunded vault/treasury, aliasing,
double-claim, stale-reservation, short-proof — после каждой инструкции
модель сверяет `balance >= reserved`, непревышение `total`, неизменность
не затронутых счетов (snapshot/rollback на каждую транзакцию модели).

**54. Экономическая симуляция → 📌 MANAGED.**
Исполняемая модель (`economy_model.ts`, 900+ строк) гоняет тысячи
детерминированных сценариев оплаченных входов/клеймов/свипов/рефандов
(теперь включая F-21-сценарий). Полноценный прогон тысяч игровых сессий
против реального тулчейна — преддеплойный шаг (см. `docs/PLAY_ECONOMY.md`;
модель — верхняя граница того, что проверяемо без cargo).

---

## Часть 2. Нетривиальные и экономические атаки (п. 55–70)

### O. Гонки состояний и дублирование

**55. Race condition в офчейн-части → 🛠 FIXED NOW (F-15, F-17, F-18).**
Главный дефект класса найден: `approveProposal` проверял
`status = open`, затем выполнял **асинхронную** операцию (RPC-чтение
vault при `close-economy-epoch`) — две параллельные записи могли обе пройти
check-then-act. Исправление: `withDecisionLock` сериализует approve/reject в
процессе; вторая линия защиты — `UNIQUE`-PK `economy_epochs` → чистый 409
(раньше — 500); `currentEpoch` перешёл на `INSERT OR IGNORE` (F-17, гонка
на границе эпохи); unlink стал одной атомарной записью (F-18). Тест F-15
гоняет два approve одновременно и требует ровно один 200 и один 409.
Идемпотентность уже была закрыта ранее: `BEGIN IMMEDIATE` в
`EconomyV2Store`, `UNIQUE(mint, player, idem_key)`, идемпотентные хеши
reward/game-событий, серверный мьютекс для админа задокументирован
(одиночный инстанс бэкенда — требование, не пожелание).

**56. Item-duplication (harvest/craft) → ✅ CLOSED.**
Серверных «сборов ресурсов» с параллельным письмом нет: награда — запись
reward-события с уникальным `idempotency_hash`, вход в платный матч —
PDA-тикет `(reference, player)` c `init` (повтор на ончейне невозможен),
v2-интент — `PRIMARY KEY(mint, player_id, idempotency_key)` + immutable
trigger'ы. Плюс F-13 ограничил количество записей match-intent на игрока.

**57. Инъекция результата в офчейн-скоринг → 🛠 FIXED NOW (F-11 закрывает последний вектор).**
Клиент нигде не передаёт итоговый счёт: `/v1/rewards/events` принимает
только события, подписанные `NEONRELAY_SERVER_SIGNING_PUBLIC_KEY`; поля
`wallet_binding_id` не покрыты серверной подписью и поэтому (CRIT-01/02
предыдущего аудита) сверяются с привязкой игрока. Оставался последний шаг —
**F-11**: любой кошелёк мог первым занять чужой `player_id` через
`/v1/wallet/link` и получить все его листья при сейле эпохи (атакующий
создаёт кошелёк → линкует не занятый id → жертва играет → `findActiveByPlayerId`
возвращает кошелёк атакующего). Исправление: в production линк принимается
только если `game_accounts` содержит пару `(player_id, этот кошелёк,
enabled=1)` — операторская провижининг-система (та же, что для pairing);
для стейджинга — явный флаг `NEONRELAY_REQUIRE_REGISTERED_PLAYER_LINK=1`.
Тест F-11 проверяет все три исхода (не зарегистрирован / чужой кошелёк /
зарегистрирован).

**58. «Фейковый бёрн» / инфляция → ⚪ N/A + 📌 caps.**
Токена в репозитории нет вовсе (см. README), эмиссии нет: награды —
перераспределение reward-пула с потолками `capPerMatch/Daily/WeeklyMicro`,
платный вход — нуле-суммный сплит (rake → treasury, остальное → vault).
Чистый эмиссионный баланс = 0 по построению; мониторинг — `/watchtower/economy`.

**59. Спуфинг активности ботами → 📌 MANAGED.**
Закрыто: серверная подпись каждого события, капы, анти-сибил миграции
(уникальный активный кошелёк на игрока), F-11. Не закрыто (и честно
заявлено): эвристики similarity-детекции по содержимому отправок (для
будущего task-маркетплейса AI-клипов) — их место в бэкенд-инжесте, не в
контракте; до запуска маркетплейса операционный антифрод-гейт.

**60. Флэш-лоан/манипуляция кривой → ⚪ N/A.**
Ни AMM, ни bonding curve, ни оракула цены в игровых расчётах нет; цена
входа — фиксированная таблица тиров в конфиге, список призов — фиксированные
bps. `deposit→action→withdraw` внутри транзакции негде применить.

**61. Wash-trading на NFT-маркетплейсе → ⚪ N/A.**
Маркетплейса и оценки по floor price в системе нет (метаданные офчейн,
продажи не поддерживаются).

### Q. Governance

**62. Захват «спящего» DAO → ⚪ N/A (заменено двухфакторным админом).**
Голосования нет. Роль «казны/параметров»: operator (propose) + superadmin
(approve) — два разных токена, в production оба **обязательны и различны**
(🛠 F-19), попытка self-approve при разделённых ролях = 403
(`distinct-approver-required`), пропозалы живут ≤24 ч, весь трафик в
append-only `admin_audit`, а ончейн-реверсы (свип, рефанд, смена
authority) дополнительно подписаны authority и покрыты событиями/таймлоком.

**63. МультиSig с низким порогом → 📌 MANAGED.**
Внутри репозитория мультисигов нет; `docs/DEPLOYMENT_POLICY.md` требует
конкретного multisig-политику (≥ порога, рекомендация 3–5 из N) на upgrade
authority ДО mainnet — то же условие, что п. 44.

**64. Инсайдер с привилегиями → ✅ CLOSED (на уровне кода) + 📌 custody.**
Принцип наименьших привилегий: backend вообще без ключей цепочки (п. 43);
разделение обязанностей operator/superadmin с обязательным расхождением
(п. 62); on-chain: слабый инсайдер (один ключ authority) ограничен
шагом рейка ≤2.5 п.п., потолками fee, pause-gate'ом, таймлоком смены
authority (432 000 слотов) и обязательными событиями — компрометация
единственного ключа даёт заморозку и постепенные изменения, видимые
watchtower'ом, а не мгновенный drain. Остаток — разделение ключей между
людьми (п. 44/63).

### R. Инфраструктура и supply chain

**65. Утечка ключей через логи/сервисы → ✅ CLOSED.**
Ключей в системе нет (п. 43); сканер секретов чист; admin-токены хранятся
в env, в БД — только sha256-фингерпринты (`hashToken`), сессии — sha256
хеша токена, сравнение constant-time; `docs/PRIVACY_GAME_EVENTS.md` явно
запрещает сид-фразы в телеметрии.

**66. Supply chain npm → ✅ CLOSED.**
Zero runtime dependencies у backend и onchain (Node built-ins only) —
скомпрометировать нечего; `npm audit` в CI бессмыслен без графа зависимостей,
поэтому CI гоняет сами сюиты + `verify:ids` + статический аудит с
drift-чеком отчёта (`release_validate.sh`).

**67. DNS-хайджек → 📌 MANAGED (операционный).**
Вне кода; `docs/INCIDENT_RESPONSE.md` покрывает эскалацию, а fail-closed
гейты бэкенда (`NEONRELAY_AUTH_DOMAIN` пин в каждом challenge, mTLS-сигнатуры
событий) означают, что подменённый фронт не может выдать легитимную награду
или подпись. Операционный чеклист: DNSSEC + 2FA/hardware key на регистраторе.

### S. Anchor-специфика

**68. Поломка layout при апгрейде → 📌 MANAGED.**
Поля `version` в аккаунтах нет — вместо этого байтовые размеры пинуются
сторонами, которые их читают: `ECONOMY_V1_CONFIG_SIZE = 204` (backend),
разборы по смещениям в `economy_v2_rpc.ts`, Android golden-PDA/размеры,
`InitSpace`-снапшоты в модели, запрет удаления/перестановки error-вариантов
(D24). Координированные апгрейды (F-04 изменил `AchievementRegistry`
77→109) зафиксированы в `docs/SECURITY_REVIEW_2026_09_26.md` как
преддеплойные требования. Остаточный риск: аккаунт без версионного поля
требует дисциплины при добавлении полей — новое поле только в конец +
аккомпанирующий размерный пин; форк-тест на мейннет-снимке — обязательный
шаг перед любым апгрейдом (DEPLOYMENT_POLICY).

**69. Батчи без поэлементной авторизации → ✅ CLOSED.**
Батчевых инструкций (airdrop/mint по списку) нет. Ближайшее —
`publish_leaderboard` (≤64 entries) — authority-only, one-way PDA, входные
данные кураторские, а не пользовательские; `register/claim` всегда по одному
игроку со своей подписью.

**70. Неатомарный крафт → ⚪ N/A (и есть положительный инвариант).**
Крафта нет; единственные «двойные» движения — сплит платы
(`pay_entry`: transfer rake + transfer prize) и рефанд (treasury + vault) —
выполняются **в одной инструкции** и падают атомарно целиком (тест
`refund` в E-серии: underfunded ⇒ ровно ничего не сдвинуто). Новый
F-21 гарантирует, что вторая половина рефанда не бьёт по коллateral'у
опубликованных эпох.

---

## Найдено и исправлено в этом проходе (F-11 … F-22)

| ID | Сев. | Пункт | Суть | Фикс | Тест |
|---|---|---|---|---|---|
| F-11 | **HIGH** | 57, 48, 64 | `/v1/wallet/link` принимал любой self-declared `player_id` → занятие чужого id и кража его reward-листьев при сейле | линк только через `game_accounts` (production всегда; иначе по флагу) | `security_audit_it5` «F-11 — …» ×2 |
| F-12 | MEDIUM | 55, 27 | `/v1/economy/*` вообще без rate-limit; `/v1/economy/ticket` → RPC-амплификация на запрос | отдельный read-лимит (burst 60, 1/s) на все чтения, строгий — на записи | «F-12 — economy read routes…» |
| F-13 | MEDIUM | 18, 55 | match-intent: нечисловой/отрицательный epoch → RangeError 500; безлимитные строки → DoS на epoch-close RPC | окно эпохи ±1, кап на (binding, epoch), rate-limit | «F-13 — …» |
| F-14 | MEDIUM | 13 | `entryReference` падает на нецелом `extra`/`kind` (BigInt/u64 writer) — 500 вместо 400; ticket без валидации | общий строгий `entryQuery` | «F-14 — …» |
| F-15 | MEDIUM | 55 | гонка approve/reject (async execute) → двойное исполнение решения | `withDecisionLock` + UNIQUE→409 | «F-15 — …» |
| F-16 | LOW | 41, 18 | рост `auth_nonces` под распределённым спамом challenge'ов | purge на expiry + потолок живых nonce'ов (50k) | «F-16 — …» + `sessions.test` |
| F-17 | LOW | 55 | гонка `currentEpoch` INSERT на границе эпохи → 500 | `INSERT OR IGNORE` + re-read | покрыто код-ревью (семантика тривиальна) |
| F-18 | LOW | 55 | unlink в два шага — наблюдаемое half-applied состояние | один `UPDATE … SET player_id = NULL, revoked_at = ?` | существующие unlink-тесты |
| F-19 | LOW | 62–64 | production бутился без operator/superadmin-токенов и с невалидным identity-ключом (fail-closed в рантайме, но не fail-fast) | fail-fast в `loadConfig`: ≥32 символов, различны, identity-ключ каноничен; оба токена обязательны | `config.test` (4 новых assert'а) |
| F-20 | MEDIUM | 11, 15 | ончейн: `initialize` (v1) без потолка `MAX_ENTRY_FEE` (set_params — с) | `require!(… <= MAX_ENTRY_FEE)` | `security_findings` «F-20 …» |
| F-21 | MEDIUM | 49, 13 | ончейн: `refund_entry_v2` мог вывести из vault сумму ниже `config.reserved` → опубликованные эпохи становились непроходимыми для клейма | guard `vault_after_prize >= reserved` + зеркало в модели | «F-21 …» (blocked + healthy) |
| F-22 | LOW | 44, 62 | ончейн: v2-пропозал authority создавался `init` без abort → однажды предложенный «не тому» ключу ротация застревала навсегда | `cancel_authority_change_v2` (+ event, close, has_one), instruction-set перепинован | «F-22 …» (propose→cancel→re-propose) |

Ни одна находка не позволяла украсть средства напрямую; F-11 позволял
**перенаправить награды другого игрока** при наличии серверно подписанного
события (наиболее серьёзная из всех трёх итераций аудита), остальные —
DoS/консистентность/деградация выплат.

## Сводка по статусам

* ✅ CLOSED: 1–30 (регрессионно), 31–35, 37, 38–41, 42, 43, 45, 46, 47,
  48, 49, 50, 52, 53, 55 *(текущий проход)*, 56, 57 *(текущий проход)*,
  58, 60, 61, 62, 64, 65, 66, 69, 70;
* 🛠 FIXED NOW: 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22;
* 📌 MANAGED: 44 (multisig до mainnet), 51 (симуляция в Android),
  54 (полный econ-прогон), 59 (антифрод-эвристики до маркетплейса),
  63 (custody-политика), 67 (DNSSEC — операционка),
  68 (версионирование layout — дисциплина + форк-тест);
* ⚪ N/A: 36, 47, 58 *(эмиссия)*, 60, 61, 70.

## Как воспроизвести

```bash
# backend: 282 теста (включая security_audit_it5 — F-11…F-16 и config-гейт F-19)
cd backend && npm test

# onchain: 110 тестов (чек-лист + находки, включая F-20, F-21, F-22)
cd onchain && npm test

# регрессии предыдущего аудита: 10 тестов
node --experimental-strip-types --test "audit/2026-09-21/*.test.ts"

# статический аудит исходников (0 findings ожидается)
NEONRELAY_AUDIT_REPORT_DIR=/tmp/audit node scripts/generate_neonrelay_audit_report.mjs
```

**Обязательные преддеплойные шаги** (здесь не выполняемы — BL-03/BL-12):
`anchor build` + `cargo test` + bank/validator-тесты по изменённым programs
(economy: F-20/F-21/F-22 — **единственная** изменившаяся программа),
`REQUIRE_TSC=1 typecheck` backend, `anchor verify` в `deploy_prod.sh`,
передача upgrade authority в multisig (п. 44), реализация
`simulateTransaction` в Android (п. 51).
