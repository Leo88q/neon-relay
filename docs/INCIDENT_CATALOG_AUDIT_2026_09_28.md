# Аудит по каталогу инцидентов 2026 (Части 5–6, пункты 94–130) — 28 сентября 2026

**Репозиторий:** `Leo88q/neon-relay`, ветка `arena/01a0e7d7-neon-relay`
**Основание:** сводка инцидентов июня–сентября 2026 (Часть 5, п. 94–113) и дополнения по всему
2026 году (Часть 6, п. 114–130).
**Предыдущие проходы:** Часть 0 (п. 1–30) — `docs/SECURITY_REVIEW_2026_09_26.md`;
Части 1–2 (п. 31–70) — `docs/SOLANA_CHECKLIST_AUDIT_2026_09_26.md`;
Часть 3 (п. 71–82) — `docs/AGENTIC_THREAT_AUDIT_2026_09_26.md`.

**Итог: 37 пунктов — 4 исправлено в этом проходе (с исполняемыми тестами), 9 закрыто
новыми гейтами, 13 переведено в операционные гейты с проверяемыми командами, 11 — N/A
по архитектуре (механики нет в системе; указано, почему и что включать, если она появится).**

Отличие этого прохода от предыдущих: атаки июня–сентября 2026 били не по контрактам, а по
**ключам, подрядчикам, инфраструктуре и фронтенду**. Поэтому здесь появились не только
on-chain-проверки, но и *внеполосный* (out-of-band) слой: независимый policy-движок переводов,
кворум чтения из нескольких RPC, ценовой предохранитель, гейты провенанса ключей и цепочки
поставок.

Легенда:

* 🛠 **ИСПРАВЛЕНО СЕЙЧАС** — найден конкретный разрыв, закрыт кодом, покрыт тестом;
* ✅ **ЗАКРЫТО** — защита была и подтверждается ссылкой/тестом;
* 📌 **MANAGED** — переведено в проверяемый операционный гейт (команда или документ);
* ⚪ **N/A** — механики в системе нет; указано, чем это свойство архитектуры подтверждается.

---

## 1. Сводная таблица

| № | Пункт | Статус | Ключевое доказательство |
| --- | --- | --- | --- |
| 94 | Захват governance через скупку голосов | ⚪ | Голосований/токен-голосов нет; казна — Squads, смена authority — 432 000 слотов (`onchain/programs/neonrelay-economy/src/lib.rs:68`) |
| 95 | Pump-and-borrow на тонком токене | 🛠 | `backend/src/oracle_guard.ts:markValueMicro` (лимит по глубине), тест «§95 recognized value is capped» |
| 96 | Целостность оракула (будущее/старое, один источник) | 🛠 | `oracle_guard.guardPrice` (future-timestamp, stale, minSources, divergence) |
| 97 | Фейковый токен со сфабрикованной историей | 📌 | Mint привязан к config-PDA и allowlist; листинг — только через upgrade/config (мультисиг + таймлок) |
| 98 | Депрекейтнутые/спящие программы | 📌 | `onchain/scripts/verify_deployment.sh` (программы+authority+минты), правило инвентаризации в `docs/OPERATOR_SECURITY.md` §5 |
| 99 | Слабая энтропия ключей | 🛠 | `scripts/check_key_provenance.py` (allowlist источников энтропии), `ops/key_provenance.example.json` |
| 100 | Секреты в публичном репозитории | 📌 | `scripts/check_secrets.py` + pre-commit + CI; история git — гейт оператора |
| 101 | Решения подписанта ограничены ончейн; KMS | 🛠 | Caps/pause/`reserved` в программах + `tx_policy` (лимиты, двойное одобрение) |
| 102 | Избыточность верификации тихо понижена | 🛠 | `rpc_quorum.MIN_VERIFIER_CONFIG`, `verifierDowngradeViolation` |
| 103 | Отравленный источник данных для подписанта | 🛠 | `rpc_quorum.quorumRead` (независимые хосты, finalized, расхождение — ошибка) |
| 104 | Сторонний скрипт на фронтенде | 🛠 | `scripts/check_landing_integrity.py` + `design/landing/INTEGRITY.json`; `onchain/test/client_policy.test.ts` |
| 105 | Watering hole и устройства игроков | 📌 | Нет сторонних SDK/WebView в клиенте (`client_policy.test.ts`), подпись — внутри кошелька; правила для игроков |
| 106 | Фальшивые рекрутеры и «партнёры» | 📌 | `.devcontainer/devcontainer.json` + `docs/OPERATOR_SECURITY.md` §1 |
| 107 | Расширения IDE, ключи ИИ, черви в npm | 🛠 | `scripts/check_supply_chain.py` (lockfiles, integrity, install-скрипты, `--ignore-scripts`), devcontainer |
| 108 | Honeypot для ваших ботов | 🛠 | `tx_policy`: обязательная симуляция для ботов, allowlist, лимиты; `client_policy.test.ts` |
| 109 | Confused deputy, session keys, делегаты | 🛠 | В клиенте нет delegate/approve-инструкций; `tx_policy` + `assertSerializedMatchesBatch` |
| 110 | Предохранители нужно тестировать состязательно | 🛠 | Тесты на обход (replay, дубль одобряющего, decode mismatch, divergence) + учения в `INCIDENT_RESPONSE.md` §6.2 |
| 111 | Нулевые и «пылевые» значения | 🛠 | `tx_policy` (0/dust/MAX), `oracle_guard` (положительные целые), on-chain «amount must be greater than zero» |
| 112 | Заражение через ваш токен и чужие токены | 📌 | SKR — только платёжный минт, залог не принимается; mint authority отозван (`verify_deployment.sh`) |
| 113 | Набор для инцидента заранее | 🛠 | `onchain/scripts/safe_harbor_memo.ts` (+6 тестов), `docs/INCIDENT_RESPONSE.md` §6 |
| 114 | Произвольный внешний вызов + бессрочные approve | 🛠 | **ProgramPolicy теперь вызывается билдерами** (было — только в тестах), `client_policy.test.ts` |
| 115 | Переполнение и «старый» код | 🛠 | **`overflow-checks = true` в корневом `Cargo.toml`** (было только в onchain), гейт `check_supply_chain.py` |
| 116 | Устаревшая версия общей программы | ⚪ | Сторонних программ-зависимостей нет: CPI только в token/ATA/system |
| 117 | Ошибка конфигурации, эксплуатируемая в одной транзакции | 🛠 | `oracle_guard.verifyConfigChangeAttestation` (форк-симуляция, fuzz, инварианты) + cap шага рейка |
| 118 | Оракул по последней сделке в «тихое» окно | 🛠 | `oracle_guard`: `minTrades`, `minWindowVolumeMicro` → «нет цены» |
| 119 | DNS-провайдер как цель | 📌 | Хэши бандла + CSP (`check_landing_integrity.py`), чек-лист домен-локов, `security.txt` |
| 120 | Казна и устройства руководителей | 📌 | Squads + аппаратные ключи + провенанс ключей; мониторинг `DeactivateStake` — гейт оператора |
| 121 | Multisig 3-из-5 тоже ломается | 🛠 | `check_key_provenance.py`: порог ≥2, разные вендоры/модели/локации |
| 122 | Аллокации команды/фонда на горячих ключах | 📌 | Правило on-chain vesting + таймлок; записано в `OPERATOR_SECURITY.md` §4 |
| 123 | Фейковый OTC/escrow и контрагенты | 🛠 | `tx_policy`: `offProtocolAlwaysDual`, уникальность одобряющих, лимиты |
| 124 | Имитация поддержки | 📌 | Правила комьюнити в `OPERATOR_SECURITY.md` §1 + `security.txt` |
| 125 | Wrench-атаки | 🛠 | `check_key_provenance.py`: ≥2 локации у подписантов; duress-протокол |
| 126 | Аппаратный кошелёк не гарантирует seed | 🛠 | Правило `known_bad_firmware` (Coldcard < 5.6.0), запись провенанса, ротация |
| 127 | Компрометация approval-бэкенда + скорость | 🛠 | `backend/src/tx_policy.ts` + `backend/scripts/transfer_preflight.ts` + 20 тестов |
| 128 | Тихий фикс в апстриме + отставание | 📌 | «Деплой раньше публикации», пин тулчейна, зачистка класса, задержка крупных операций |
| 129 | После первого инцидента бьют по «сестринским» | 📌 | Runbook §6.4 (класс-скан 48 ч, осушение депрекейтнутых) |
| 130 | Маркетплейсы навыков и плагинов ИИ | 📌 | Devcontainer без ключей + пины tool-описаний (`backend/tool_pins.json`), правила §2 |

---

## 2. Часть 5 — пункты 94–113

### AA. Governance и цена

**94. Захват DAO через скупку голосов и низкую явку (BonkDAO, Token of Power, Term Finance).**
⚪ Голосований, токен-голосов и «казны, управляемой предложениями» в Neon Relay нет:
распределением наград управляет двухключевой admin-plane (`backend/src/admin.ts`), а деньги —
Squads-мультисиг. Проверено: `grep -rn "governance|vote" onchain/programs` находит только
комментарии, on-chain-инструкций голосования нет. Если governance-модуль появится, он обязан
удовлетворять списку из п. 94: снимок голосов **до** создания предложения, voting delay, hold-up
(таймлок) между голосованием и исполнением, кворум от обращающегося предложения, veto-совет,
лимит выводов из казны за период, запрет create+vote+execute в одной транзакции. Этот список
зафиксирован здесь как преддеплойное требование к будущей фиче.

**95. Pump-and-borrow на тонком токене (Tectonic, 30.08.2026).** 🛠
Механик залога/кредитования в репозитории нет, но добавлен предохранитель на случай их появления:
`backend/src/oracle_guard.ts::markValueMicro` признаёт стоимость не по спот-цене, а с потолком
`depthCapBps` от **наблюдаемого объёма окна**. Тест: «§95 recognised value is capped by real
depth, not by the spot price» — номинал 1 000 000 000 при окне 160 000 000 и `depthCapBps=1000`
признаётся как 16 000 000, флаг `capped=true`. Тонкое окно → `no-price`, а не удобная цена.

**96. Целостность самого оракула (Ostium, Bonzo, Moonwell).** 🛠
`guardPrice` отклоняет: сэмплы «из будущего» (`maxFutureSkewMs`), устаревшие (`maxAgeMs`),
единственный источник/независимых меньше `minSources`, расхождение больше `maxDeviationBps`
(решение не усредняется, а отменяется). «Нет цены» — первоклассный результат: вызывающий код
не имеет права подставить последнее известное значение (`PriceDecision`). Смежные проверки
decimals уже есть в программах: `neonrelay-rewards` требует 6 decimals (`EXPECTED_DECIMALS`),
`neonrelay-assets` проверяет `decimals <= 9` и байты минта (`lib.rs:509-524`), экономика v2
считает тарифы от decimals (`tier_fees_v2`). Сторонний оракул как зависимость — правило
«минимум два независимых источника + выключатель при расхождении» (см. п. 103).

**97. Фейковый токен со сфабрикованной историей (Rhea, mySwap, Edel).** 📌
Цена пула нигде не используется (в репозитории нет ни одного чтения AMM-цены). Минты не
выбираются по факту: платёжный минт зашит в config-PDA экономики и сверяется с полем конфига
(`backend/src/economy_v2_rpc.ts::readConfig`), токен-аккаунты проходят `require_safe_token_account`
(нет делегатов, native, close-authority). Новый минт нельзя «подсунуть» пользовательским
вводом: листинг — это `initialize`/`set_params` через мультисиг, то есть с таймлоком и
человеческим ревью. Остаточное: если появится permissionless-листинг, обязателен период
остывания, минимум держателей/объёма и allowlist mint-адресов — записано как требование.

**98. Депрекейтнутые/спящие программы остаются целью (Raydium Legacy AMM, Aztec Connect).** 📌
`onchain/scripts/verify_deployment.sh` — read-only проверка манифеста: все программы (≥4),
их id, upgrade authority, два минта, отзыв mint/freeze authority, decimals. Манифест —
`onchain/deployment.example.json`. Правило инвентаризации добавлено в
`docs/OPERATOR_SECURITY.md` §5: реестр всех задеплоенных программ (включая beta и тестовые) с
балансами и authority, депрекейтнутые осушаются и закрываются, upgrade authority — в Squads.
Чего нет в песочнице: исполнения `verify_deployment.sh` против реального кластера (нет RPC) —
это релизный гейт оператора (`docs/DEVNET_RUNBOOK.md`).

**99. Слабая энтропия при генерации ключей (Ill Bloom, SecondFi/Yoroi).** 🛠
Новый гейт `scripts/check_key_provenance.py` требует для каждого привилегированного ключа
записанный источник энтропии из allowlist (`hardware-csprng`, `csprng`, `csprng+external-dice`,
`hardware-csprng+external-dice`); `software-prng` разрешён только для ролей `devnet-test`/
`local-only`. Пример манифеста — `ops/key_provenance.example.json`. Клиент ключей не создаёт:
подпись происходит в MWA-кошельке (`android/.../WalletManager.kt`), в приложении нет генерации.
Проверено отдельно: `scripts/gen_keys.py` — генератор *скан-кодов клавиш* для C++ (не крипто).

**100. Секреты в публичных репозиториях (Taiko).** 📌
`scripts/check_secrets.py` (PEM, AWS, GitHub/Slack/Google/OpenAI, Solana-keypair, hex-seed,
пути `.env*/id.json/*.pem`), self-test в pre-commit (`.githooks/pre-commit`) и в CI; `.gitignore`
закрывает `.env`, `*.pem`, `*.key`, `id.json`, `keypair*.json`. Репозиторий публичный, поэтому
вся история считается раскрытой: скан истории (`gitleaks --log-opts=--all`, `trufflehog`) и
включение push protection — гейт оператора (зафиксировано в `PROD_READINESS_AUDIT_2026_09_28.md`,
п. 1.2).

**101. Решения подписанта должны быть ограничены ончейн; KMS — не панацея (Resolv).** 🛠
Ончейн: `MAX_RAKE_BPS` + шаг ≤250 б.п. за вызов, `MAX_ENTRY_FEE`, пауза, инвариант
`vault.amount >= config.reserved` при публикации эпохи, `checked_*` в арифметике, mint authority
отозван. Внеполосно (для «человеческих» переводов и будущего approval-бэкенда) — `tx_policy`:
лимит на транзакцию, лимиты часа/суток, потолок горячего кошелька, обязательная симуляция для
ботов, двойное одобрение выше порога. KMS-правила (отдельный проект, key policy с условиями,
минимальные IAM-права, алерты на вызовы Sign, без долгоживущих access-ключей) —
`docs/OPERATOR_SECURITY.md` §4.

### AB. Устаревшие программы и ключи

**102. Избыточность верификации тихо понижена (KelpDAO: 2-of-2 → 1-of-1).** 🛠
`backend/src/rpc_quorum.ts`: `MIN_VERIFIER_CONFIG = {threshold:2, total:3, independentOperators:2}`
зашит в код; `verifierDowngradeViolation()` возвращает `threshold-below-code-minimum`,
`operators-not-independent`, `security-downgrade-requires-timelock-and-alert`. Тесты — в
`backend/test/rpc_quorum.test.ts` (последний кейс — точная реконструкция паттерна KelpDAO).
Ончейн-половина уже была: смена authority требует `propose` + `accept` не раньше
`MIN_AUTHORITY_DELAY_SLOTS` (432 000 слотов).

**103. Отравленный источник данных для офчейн-подписанта (KelpDAO: код в op-geth на двух
кластерах, DVN читал подделку, мониторинг — честные данные).** 🛠
`quorumRead()` читает значение у нескольких провайдеров, требует `finalized`, отказывается
работать, если два провайдера живут на одном хосте (`providers-not-independent` — «два API-ключа
одного провайдера не два верификатора»), сравнивает канонизированные ответы и падает
`quorum-divergence` с перечислением групп, а не «голосует большинством». Отдельно:
`commitment-not-finalized` (деньги считаются только по finalized), `quorum-unavailable`
(недоступность — это недоступность, а не значение). Уже было: пин genesis-хэша в `rpc.ts`,
строгая ABI-валидация аккаунтов (`economy_v2_rpc.ts`). Остаточное: модуль пока не является
дефолтным путём чтения — это пункт деплой-гейта (подключить к reconcile/индексатору до mainnet).

### AC. Верификаторы и источники данных

**104. Сторонний скрипт на фронтенде (Polymarket: ~$2,94 млн через скомпрометированного
вендора).** 🛠
`scripts/check_landing_integrity.py` (гейт в CI) проверяет: ни одного внешнего origin в
`script/iframe/img/link/form/source`, запрет `<iframe>`, запрет `eval`/`new Function`/
`document.write`/`innerHTML =`, обязательный строгий CSP в `design/landing/_headers`
(`default-src 'self'`, `connect-src 'none'`, `frame-ancestors 'none'`, `object-src 'none'`),
и совпадение хэшей отдаваемых файлов с `design/landing/INTEGRITY.json` (мониторинг состава
бандла). Проверено: внешних скриптов на лендинге нет (`gtag` — только stub в `dataLayer`,
внешний тег не подключается). Мобильная половина: `onchain/test/client_policy.test.ts`
запрещает сторонние аналитические/рекламные SDK в каталоге зависимостей Android.
Остаточное: `script-src` содержит `'unsafe-inline'` из-за inline-обработчиков; страниц
подписи на этом origin нет (подпись — в кошельке), но при выносе любых wallet-экранов
в веб `unsafe-inline` обязан быть устранён (nonce/hash).

**105. Watering hole: взломанный сайт как канал доставки на телефон (DarkSword).** 📌
Целостность фронтенда (п. 104) закрывает доставку через *наши* страницы. Клиент игры не
использует WebView и сторонние SDK (проверено `grep -rn "WebView|Firebase|Analytics" android/`
и конформанс-тестом), подпись происходит внутри кошелька игрока, игра никогда не запрашивает
seed-фразу (в приложении нет ни одного поля ввода seed: ключи — только MWA). Правила
комьюнити (обновление ОС, аппаратный кошелёк для крупных сумм, «поддержка не просит seed») —
`docs/OPERATOR_SECURITY.md` §3.

### AE. Команда и рабочее окружение

**106. Фальшивые рекрутеры, «партнёры», «инвесторы» (WaterPlum/Contagious Interview).** 📌
`.devcontainer/devcontainer.json`: контейнер для чужого кода — toolchain без ключей,
`NPM_CONFIG_IGNORE_SCRIPTS=true`, `--cap-drop=ALL`, `no-new-privileges`, выключенный автозапуск
задач VS Code, Workspace Trust включён, ни одного расширения по умолчанию. Плюс
`docs/OPERATOR_SECURITY.md` §1: чужой код — только в одноразовой среде без ключей; идентичность
собеседника подтверждается по независимому каналу; «тестовое задание» никогда не запускается на
машине с кошельком.

**107. Расширения IDE, ключи ИИ-сервисов и черви в пакетах.** 🛠
`scripts/check_supply_chain.py`: lock-файл обязателен, у каждой зависимости есть `integrity`,
ни один пакет не имеет install/postinstall/preinstall-скриптов, CI не вызывает голый
`npm install` (только `npm ci --ignore-scripts`, если ставит вообще; сейчас проект
zero-dependency). Правила по расширениям IDE, ключам ИИ-API (лимит расходов, минимальные права,
менеджер секретов, не `.env`) и задержке перед принятием новых версий —
`docs/OPERATOR_SECURITY.md` §2.

### AF. Боты и делегированные полномочия

**108. Honeypot для ваших собственных ботов (jaredfromsubway.eth).** 🛠
`tx_policy` требует для `origin: "bot"` (и при `simulationRequired`) успешной симуляции с
подтверждённой дельтой баланса: `simulation-required`. Плюс получатели — только из allowlist,
лимиты на контрагента/сутки/час, `halted` как выключатель. Конформанс-тест клиента фиксирует,
что приложение отправляет **только** собранное им сообщение
(`signAndSendTransactions(arrayOf(EconomyTxBuilder.unsignedTransaction(message)))`) и никогда
не подписывает полезную нагрузку, пришедшую от бота/сервера.

**109. Confused deputy в сторонних модулях и делегированных правах.** 🛠
В клиенте нет ни delegate/approve, ни session keys (проверяется `client_policy.test.ts`:
`Approve*`, `SetAuthority`, `Assign`, `CloseAccount` отсутствуют; System Program запрещён в
`compileMessage`). Для человеческого/серверного пути `tx_policy` ограничивает allowlist
получателей, сумму, срок (окно), а `assertSerializedMatchesBatch` отказывает, если
подписываемых инструкций больше, чем проверенных интентов (именно так в тракт пролезают
`Approve`/`SetAuthority`).

### AG. Предохранители, крайние значения и реакция

**110. Сами предохранители нужно тестировать состязательно (Gnosis Pay обошёл тайм-делей).** 🛠
Новые тесты атакуют предохранители, а не подтверждают их: повтор батча и интента
(`replayed-batch`, `replayed-intent`), двойной один и тот же одобряющий, расхождение декодера и
хэша подписи, превышение лимитов, `delay-not-elapsed` при попытке исполнить раньше срока,
истечение срока предложения (`admin.ts`: `proposal-expired`). Ончейн-пауза и таймлоки уже
покрыты `onchain/test/security_*.test.ts`. Учения «заморозка < 15 минут» с замером времени —
`docs/INCIDENT_RESPONSE.md` §6.2 (цель SEV-1, квартально).

**111. Нулевые и «пылевые» значения (Little Boy Plus, Thetanuts).** 🛠
`tx_policy`: `amountMicro` обязан быть положительным безопасным целым — `0`, дробные и
`Number.MAX_SAFE_INTEGER` дают `invalid-amount`/`per-tx-limit` (тест «§111 zero, dust and max
amounts»). `oracle_guard.markValueMicro` бросает на ≤0. Ончейн уже было:
`neonrelay-rewards` — «claim amount must be greater than zero» (`lib.rs:548`), экономика —
`amount === 0n` отбрасывается (`backend/src/economy.ts:165`), `checked_sub` на `remaining_micro`
и `reserved`.

**112. Заражение через ваш токен и чужие токены (Echo Protocol, Kelp).** 📌
SKR в проекте — только платёжный минт (входные билеты/призы); залог под него никто не выдаёт,
игра не принимает чужие/бриджнутые токены как обеспечение. Минты проверяются жёстко:
отзыв mint/freeze authority обязателен (`verify_deployment.sh` и `initialize` программ),
ассеты/бейджи — через собственные PDA с привязкой к конфигу. Если SKR появится на внешних
рынках как залог, обязательны кап предложения и мониторинг (правило записано); при появлении
в игре приёма чужих токенов — allowlist + дисконт + выключатель (готовый примитив —
`oracle_guard` + `tx_policy`).

**113. Набор для инцидента заранее (Aquifer).** 🛠
`onchain/scripts/safe_harbor_memo.ts`: детерминированный мемо-формат с проверкой политики
(минимум возврата 80%, баунти 20%, срок не меньше 72 часов, лимит SPL Memo 566 байт),
`verifySafeHarborMemo()` для проверки **входящих** предложений и CLI (`--verify`), отказ вместо
усечения. Тесты: `onchain/test/safe_harbor_memo.test.ts` (6 тестов, включая подделку условий).
`docs/INCIDENT_RESPONSE.md` §6 — контактная матрица, предавторизованная пауза, снимки
доказательств, шаблон предложения, зачистка класса. Уже было: `.well-known/security.txt`,
safe-harbor раздел в `SECURITY.md`.

---

## 3. Часть 6 — пункты 114–130

### AH. Solana-специфика 2026

**114. Произвольный внешний вызов + бессрочные approve (SwapNet, Aperture).** 🛠
**Найден и закрыт реальный разрыв:** allowlist программ (`ProgramPolicy`) существовал, но
вызывался только из тестов — то есть на пути построения транзакции защиты не было.
Теперь `ProgramPolicy.requireEconomyAllowed(programId)` вызывается первым делом в
`buildPayEntryMessage`/`buildClaimPrizeMessage`, а `requireRewardsAllowed(programId)` — в
`buildClaimMessage`. Fail-closed: без настроенного оператором allowlist ничего не подпишется.
Source-level конформанс-тест `onchain/test/client_policy.test.ts` (исполняется в песочнице)
падает, если проверка исчезнет, если появится `Approve`/`SetAuthority`/durable-nonce или если
в исходниках появится захардкоженный id программы. Ончейн-половина: CPI только в
token/ATA/system (grep по `invoke(`/`CpiContext` показывает единственный CPI — SPL Token),
данные инструкций от пользователя никогда не исполняются с подписью PDA.

**115. Переполнение и «старый» код (Truebit: 5-летний контракт, overflow).** 🛠
**Найден и закрыт реальный разрыв:** корневой `Cargo.toml` (rust-bridge игрового движка)
собирал release **без** проверок переполнения; в `onchain/` они были, в корневом workspace —
нет. Добавлено `overflow-checks = true` в `[profile.release]` (профили `relwithdebinfo` и
`minsizerel` наследуются). Гейт `scripts/check_supply_chain.py` проверяет это для всех
Cargo-профилей и ловит снятие флага (проверено отрицательным тестом: снятие флага → 3 FAIL,
exit 1). Остаточное: компиляция в песочнице невозможна (BL-01) — эффект подтверждается на
релизной машине.

**116. Устаревшая версия общей программы у интеграторов (Rain card contract: Avici, Tria).** ⚪
У Neon Relay нет сторонних on-chain-программ-зависимостей: программы вызывают только
SPL Token, ATA и System. Версионирование общей программы, от которой зависят интеграторы, в
системе отсутствует. Правило на будущее (если появится общий модуль): реестр версий,
подписка на security-объявления, привязка подписи к инструкции и аккаунтам, лимит скорости
выводов — зафиксировано в `docs/OPERATOR_SECURITY.md` §5.

**117. Ошибка конфигурации цены, эксплуатируемая ботами в одной транзакции (GoonFi v2).** 🛠
`oracle_guard.verifyConfigChangeAttestation()` требует перед выкаткой изменения
цены/комиссий: форк-симуляцию от свежего слота, покрытие fuzz ≥ `minFuzzCases`, отсутствие
нарушений инвариантов. Плюс уже существующий on-chain предел шага рейка (≤250 б.п. за вызов)
и пауза. Тесты — в `backend/test/oracle_guard.test.ts`.

**118. Оракул по последней сделке в «тихое» окно (YieldBlox, Stellar).** 🛠
`guardPrice` отказывает, если объём окна ниже `minWindowVolumeMicro` (`thin-liquidity`) или
сделок меньше `minTrades` (`too-few-trades`) — цена одной сделки в тихие 15 минут не
становится ценой протокола. Тест «§118 thin liquidity and quiet windows produce no price».

**119. DNS-провайдер как цель социальной инженерии (BONKfun).** 📌
Технически закрыто то, что можно проверить в репозитории: хэши отдаваемых файлов
(`design/landing/INTEGRITY.json`), строгий CSP, отсутствие внешних origin, `security.txt` с
контактом. Организационно — чек-лист `docs/OPERATOR_SECURITY.md` §3: registry/transfer lock,
аппаратный ключ и отдельная парольная фраза для поддержки регистратора, мониторинг NS/WHOIS,
резервный домен, заранее прописанные контакты команд кошельков/блок-листов.

**120. Казна и устройства руководителей (Step Finance: 261 854 SOL).** 📌
Правила: казначейство — Squads на аппаратных ключах, подписанты на изолированных машинах,
никаких казначейских ключей на рабочих ноутбуках; ранний сигнал `DeactivateStake` с
казначейских аккаунтов (Solana-специфика из разбора Step) — гейт мониторинга оператора,
инструментарий описан в `docs/OPERATOR_SECURITY.md` §4. Проверяемая часть —
`check_key_provenance.py` (устройство, прошивка, локация, ротация).

**121. Multisig 3-из-5 тоже ломается (Dominion Market).** 🛠
`check_key_provenance.py` для каждого мультисига требует: порог ≥ 2, ≥ 2 разных вендора
устройств, ≥ `min(threshold, активные)` разных (вендор, модель) и ≥ 2 разных локации — то есть
один компрометирующий фактор (вендор, модель, офис, похищение человека) не даёт порог.
Пример манифеста и self-test покрывают оба нарушения. Задержка на вывод из казны —
`approval.delayAboveMicro/delayMs` в `tx_policy`. Обоюдоострость freeze authority
задокументирована в `docs/INCIDENT_RESPONSE.md`.

**122. Аллокации команды и фонда на «горячих» ключах (Fogo Foundation: 400 млн FOGO).** 📌
В репозитории нет токеномики/аллокаций (токена проекта не существует), поэтому механики нет.
Правило на будущее: аллокации команды/фонда — только в on-chain vesting с лимитом
высвобождения за период, крупные переводы — через таймлок с возможностью отмены; ключи
аллокаций — в реестре провенанса с ротацией (`docs/OPERATOR_SECURITY.md` §4).

**123. Фейковый OTC/escrow и контрагенты казначейства (Meteora).** 🛠
`tx_policy`: `approval.offProtocolAlwaysDual = true` требует двух **разных** одобряющих для
любой сделки вне протокола; дубликат одобряющего отклоняется (`duplicate-approver`); лимиты
на сделку, на контрагента и сутки; получатель — только из allowlist; причина обязательна для
аудита. Плюс организационные правила (проверенный посредник, проверка адреса по независимому
каналу, тестовая сумма) — `docs/OPERATOR_SECURITY.md` §1.

### AI. Люди, контрагенты и физическая безопасность

**124. Имитация поддержки (10.01.2026, ~$282 млн).** 📌
Правила комьюнити и команды: официальная поддержка — только перечисленные каналы,
«поддержка никогда не просит seed-фразу и не пишет первой», модерация блокирует ссылки в DM,
команда минимизирует публичные персональные данные. Контакт для сообщений о безопасности —
`.well-known/security.txt` (RFC 9116, `Expires: 2027-09-28`). Реализовано в
`docs/OPERATOR_SECURITY.md` §1/§3.

**125. Wrench-атаки (52 случая за H1 2026, 20 домашних вторжений).** 🛠
Геометрия мультисига проверяется кодом: `check_key_provenance.py` требует ≥ 2 локаций у
подписантов одного мультисига, чтобы один физический инцидент не дал порог. Duress-протокол
(кто и как сообщает о принуждении, задержка на крупные выводы с отменой, разделение личных и
проектных активов) — `docs/OPERATOR_SECURITY.md` §1. Публичный след (реестры, WHOIS) —
квартальный аудит.

**126. Аппаратный кошелёк не гарантирует хороший seed (Coldcard).** 🛠
`ops/key_provenance.example.json` содержит правило `known_bad_firmware` для Coldcard
(Mk2–Mk5/Q, прошивка < 5.6.0, откат генератора на слабый software PRNG): активный ключ на
затронутой прошивке валит гейт; ключ со статусом `compromised` обязан иметь `rotated_at`.
Гейт также требует записанных устройства/прошивки/даты/источника энтропии и не даёт
«забыть» про миграцию. Правило: обновление прошивки не лечит уже созданные сиды — только
миграция ключа.

### AJ. Инфраструктура, бэкенд и цепочка поставок

**127. Компрометация approval-бэкенда без кражи ключей + скорость (Bitget: 15 переводов,
7 сетей, < 20 минут).** 🛠
Новый независимый policy-движок `backend/src/tx_policy.ts` и операторский CLI
`backend/scripts/transfer_preflight.ts`:

* allowlist получателей с областями назначения (per-chain, per-purpose);
* лимит на транзакцию, на получателя в сутки, на час и на сутки — **суммарно по всем сетям**
  (именно это ломает схему Bitget «по лимиту на сеть»);
* жёсткий потолок горячего кошелька (`warmWalletCapMicro`);
* батчинг и обязательная задержка выше порога (`delayAboveMicro` + `delayMs`), с очередью
  (`--queue --out`), которую нельзя исполнить раньше срока;
* двойное одобрение выше порога и для всех off-protocol переводов, дубликаты одобряющих
  отклоняются;
* независимый декодер: `decodedText` обязан совпадать с канонической расшифровкой полей, а
  `signedIntentHash` — с хэшем этих полей; `assertSerializedMatchesBatch` дополнительно
  сверяет инструкции, которые увидит подписант, с проверенными интентами;
* идемпотентность: повтор батча/интента и `Number.MAX_SAFE_INTEGER`-суммы отклоняются;
* `halted` — выключатель на весь движок.

Тесты: `backend/test/tx_policy.test.ts` (15) + `backend/test/transfer_preflight.test.ts` (5,
запускают реальный CLI: cross-chain лимит, отказ до истечения задержки, расхождение
сериализованной инструкции, `halted`). Примеры политики/батча — `ops/transfer_policy.example.json`,
`ops/transfer_batch.example.json`.

**128. Тихий фикс в открытом репозитории до релиза + отставание от апстрима (Liquid Network:
~$320 млн).** 📌
Правила: исправление деплоится, потом публикуется (публичный diff — готовая инструкция для
атакующего, в том числе ИИ); апстрим-релизы отслеживаются с ответственным; «смерженное» ≠
«задеплоенное». Проверяемая часть: пин тулчейна (`check_supply_chain.py`), пин апстрима
(`UPSTREAM_BASE.md`), аномально крупные операции не исполняются автоматически —
`tx_policy` задержка и двойное одобрение. Раздел §6.5 в `docs/INCIDENT_RESPONSE.md`.

**129. После первого инцидента бьют по «сестринским» компонентам (Aztec, Transit Finance).** 📌
Runbook «зачистка класса» (`docs/INCIDENT_RESPONSE.md` §6.4): в 48 часов после закрытия
инцидента проверить тот же баг во всех программах, старых версиях и форках, депрекейтнутые
компоненты осушить и закрыть. Инвентаризация — `verify_deployment.sh` + правило реестра
(`docs/OPERATOR_SECURITY.md` §5).

**130. Маркетплейсы навыков и плагинов ИИ-агентов (ClawHub, Snyk: 36% навыков с изъянами).** 📌
Агенты и плагины — это код и промпт: `devcontainer` без ключей и с `--cap-drop=ALL`,
`--ignore-scripts`, закрепление версий/хэшей; описания инструментов уже запинены
(`backend/src/tool_registry.ts`, `backend/tool_pins.json`, CI-гейт `npm run check:tool-pins`);
правила «навык проверяется как код, агент с внешними расширениями — без кошельков и `.env`» —
`docs/OPERATOR_SECURITY.md` §2.

---

## 4. Что реально исполнено в этой песочнице

Все команды ниже выполнены на этом дереве (Node 22.22.3, Python 3.11, без сети):

| Команда | Результат |
| --- | --- |
| `cd backend && npm test` | **343 теста, 0 fail** (305 до прохода + 38 новых) |
| `cd onchain && npm test` | **123 теста, 0 fail** (111 до прохода + 6 safe-harbor + 6 conformance) |
| `python3 scripts/check_supply_chain.py --self-test && python3 scripts/check_supply_chain.py` | `ok` (снятие `overflow-checks` даёт 3 FAIL, exit 1 — проверено) |
| `python3 scripts/check_key_provenance.py --self-test && python3 scripts/check_key_provenance.py --now 2026-09-28` | `ok` (self-test покрывает 8 нарушений) |
| `python3 scripts/check_landing_integrity.py --self-test && python3 scripts/check_landing_integrity.py` | `ok` (хэши бандла совпадают с `INTEGRITY.json`) |
| `node --experimental-strip-types backend/scripts/transfer_preflight.ts …` | `AUTHORISED`, exit 0 на примере; `REFUSED/hour-budget-exceeded` на нарушении |
| `node --experimental-strip-types onchain/scripts/safe_harbor_memo.ts …` | мемо 299 байт из 566, exit 0; `--verify` подтверждает мемо |

## 5. Гейты оператора (то, что нельзя проверить в песочнице)

1. **`check_key_provenance.py` на реальном манифесте** — заполнить `ops/key_provenance.json`
   (не `.example`) перед mainnet и после каждой церемонии ключей.
2. **Подключить `quorumRead` к денежному пути чтения** (reconcile/индексатор) и включить
   минимум 2 независимых провайдера + собственную ноду.
3. **Прогнать `verify_deployment.sh` против финализированного RPC**, зафиксировать authority в
   Squads, подтвердить отзыв mint/freeze authority.
4. **Сканирование истории git** (gitleaks/trufflehog) и включение push protection.
5. **Домен**: registry/transfer lock, отдельная фраза поддержки, мониторинг NS/WHOIS,
   резервный домен, контакты кошельков/блок-листов.
6. **Учения «инцидент/заморозка»** с замером времени и записью в журнал (цель SEV-1 < 15 мин).
7. **Юридические тексты** safe harbor и политика баунти — утвердить до mainnet.

## 6. Верификационный статус (что не запускалось)

* Rust-сборка (`cargo build`/`anchor build`) в песочнице невозможна (BL-01/BL-03): изменение
  `overflow-checks` и все Anchor-тесты подтверждаются на релизной машине; здесь они закрыты
  статическим гейтом и source-level тестами.
* Kotlin/Android не компилируется (BL-02): правки `ProgramPolicy` в билдерах и новые Kotlin
  тесты исполняются в Android CI; в песочнице исполняется их source-level конформанс-проверка
  (`onchain/test/client_policy.test.ts`).
* `verify_deployment.sh`, DNS-чеки, сканирование истории git — только с сетью/реальным
  кластером; это релизные гейты.

## 7. Ссылки

* `docs/OPERATOR_SECURITY.md` — операционные правила (люди, казна, домен, ключи, реакция).
* `docs/INCIDENT_RESPONSE.md` §6 — набор для инцидента, контакты, safe harbor, зачистка класса.
* `backend/src/tx_policy.ts`, `backend/src/rpc_quorum.ts`, `backend/src/oracle_guard.ts` —
  внеполосные предохранители.
* `scripts/check_supply_chain.py`, `scripts/check_key_provenance.py`,
  `scripts/check_landing_integrity.py` — CI-гейты этого прохода.
* `onchain/scripts/safe_harbor_memo.ts` — шаблон ончейн-предложения.
