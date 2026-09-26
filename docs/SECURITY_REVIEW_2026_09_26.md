# Security review Neon Relay — 26 сентября 2026

**Репозиторий:** `Leo88q/neon-relay`
**Ветка:** `arena/01a0db8d-neon-relay` (база `d3fd501`, `main`)
**Заказчик:** «проверь, защищена ли игра и смарт-контракт, и напиши тесты на эти темы» + чек-лист из 30 пунктов (категории A–E)
**Статус тестов на момент отчёта:**

| Сюита | Результат | Было до работы |
|---|---|---|
| `backend` (`npm test`) | **275 / 275 passed** | 267 |
| `onchain` (`npm test`) | **107 / 107 passed** | 51 |
| `audit/2026-09-21` (регрессии H-01, M-01…M-04) | **10 / 10 passed** | 10 |

Новые файлы: `onchain/test/security_checklist.test.ts` (45 тестов, 1721 строка),
`onchain/test/security_findings.test.ts` (11 тестов), `backend/test/ratelimit.test.ts` (7 тестов),
харнес `onchain/test/helpers/rust_accounts.ts` (1068 строк) и
`onchain/test/helpers/economy_model.ts` (894 строки).

> **Обновление от 2026-09-26, итерация 2 — MEDIUM-находки.** Исправлены
> **F-01/F-01b** (шаговый потолок рейка `MAX_RAKE_STEP_BPS = 250`, абсолютный
> потолок v1-fee `MAX_ENTRY_FEE`, события `ParamsChanged`/`ParamsChangedV2`,
> зеркальная проверка политики в `backend/src/economy_v2_rpc.ts`) и **F-04**
> (пин `features_authority` в `AssetsConfig`, штамп `config_authority` в
> `AchievementRegistry`, живая сверка с features-config PDA, инструкции
> `set_features_authority` / `restamp_registry`).
>
> **Обновление от 2026-09-26, итерация 3 — short-term-план закрыт целиком.**
> Исправлены: **F-02** (оба sweep'а теперь под pause-гейтом — пауза стала
> полной экономической заморозкой, включая случай скомпрометированного ключа
> authority), **F-03** (economy эмитит `AuthorityChangeProposed{,V2}` /
> `AuthorityChanged{,V2}` с ротируемым treasury в событии accept),
> **F-05** (дублирующиеся account-атрибуты на `collection` слиты в
> один в обеих структурах, handler-дубль сохранён как defence in depth),
> **F-08** (idle-buckets evicted после окна полного восстановления + жёсткий
> потолок `maxBuckets` в `RateLimiter`), **F-09** (док-указатель rewards
> переведён на реальный `onchain/src/constants.ts`) и пункт E29
> (`ClaimPrizeV2.player_ata` получил симметричный `!= config.treasury_ata`).
> Из находок остаются открытыми только **F-07** (LOW — продуктовое решение о
> stake за регистрацию турнира) и **F-10** (INFO — сознательно отложено:
> унификация endianness должна атомарно пройти 4 стека, включая Android-билдер
> с запиненными golden-PDA, который в этом окружении не запускается).
> **Обновление от 2026-09-26, итерация 4 — закрыта и F-07; открытым остался
> только F-10 (MANAGED).** F-07: регистрация на турнир больше не «бесплатная
> при балансе 0.01 SOL» — теперь каждый слот **блокирует** возвратный стейк
> 0.01 SOL в registration-PDA (заполнить все 65 535 слотов = связать 655.35
> SOL одновременно); `cancel_registration` возвращает стейк в окне,
> новая `reclaim_stake` — после конца турнира, у оператора нет инструкции
> забрать стейк; надгробие остаётся rent-exempt, повторная регистрация
> невозможна. Это capital lock, а не fee — продуктовое решение о форфейте
> не потребовалось. F-10: миграция endianness по-прежнему отложена (4 стека,
> Android-тесты здесь не запускаются), но конвенция теперь **декларирована**
> у seed-констант каждой программы и инвентарь всех u64-seed проверяется
> машиной — новый seed с «чужим» порядком байтов роняет тест.
>
> Rust в этом окружении не компилировался (§0), поэтому до деплоя обязателен
> `anchor build` + Rust-тесты: правки F-04 меняют layout `AchievementRegistry`
> (77 → 109 байт) и аргументы `initialize`/`mint_badge_*` в assets, а F-07
> меняет поведение register/cancel и добавляет `reclaim_stake` в features —
> программы features и assets должны обновляться **скоординированно**.
>
> **Обновление от 2026-09-26, итерация 5 — полный проход по чек-листу
> 31–70 (Части 1–2).** Найдено и исправлено **12 дефектов** (F-11 … F-22;
> 1 HIGH, 6 MEDIUM, 5 LOW), каждый закрыт регрессионным тестом. Самое
> серьёзное — **F-11 (HIGH)**: `/v1/wallet/link` позволял любому кошельку
> первым занять ещё не занятый `player_id` и получать его reward-листья при
> сейле эпохи; в production линк теперь требует провижининга
> `(player_id, wallet)` в `game_accounts`. Далее: rate-лимиты и валидация
> всех `/v1/economy/*` маршрутов (F-12…F-14), сериализация админ-решений
> (F-15), потолок живых auth-nonce'ов (F-16), атомарный unlink (F-18),
> fail-fast производственного конфига — обязательные роль-токены и
> identity-ключ (F-19), ончейн (только economy): потолок fees на
> `initialize` (F-20), защита `reserved`-коллateral'а при рефандах (F-21),
> отмена «застрявшего» v2-пропозала authority — `cancel_authority_change_v2`
> (F-22; добавление инструкции не меняет layout существующих аккаунтов, но
> требует перепиновки instruction-set — сделано). Итог по всем 70 пунктам
> чек-листа — `docs/SOLANA_CHECKLIST_AUDIT_2026_09_26.md` (56 CLOSED,
> 12 FIXED NOW, 8 MANAGED, открытых уязвимостей — 0). Сюиты:
> backend **282/282**, onchain **110/110**, audit/2026-09-21 **10/10**.

---

## 0. Методология и её границы (читать обязательно)

В этом окружении **нет `cargo`/`rustc`**, и `crates.io` недоступен (SSL), поэтому
Rust-код **не компилировался**, а `programs/neonrelay-economy/tests/*.rs`
(`v2_runtime.rs`, `v2_unit.rs`, `v2_validator.rs`) **не запускались**. Чтобы не
превращать ревью в чтение глазами, был построен исполняемый харнес:

* `rust_accounts.ts` — парсер Anchor-атрибутов (`#[account(...)]`, `seeds`,
  `bump`, `has_one`, `constraint`, `token::mint/authority`, `init`, `space`,
  `close`, `address`, `Program<>`, `Signer<>`) и **эвалюатор** этих ограничений:
  он выводит PDA настоящими `findProgramAddress`/off-curve проверками, проверяет
  подписантов, владельца, rent, дискриминаторы и порядок `init`/`close` так, как
  это делает Anchor runtime.
* `economy_model.ts` — по-строчное зеркало handler'ов economy-программы
  (арифметика комиссий, резервы, Merkle, sweep, timelock, refund) поверх этого
  эвалюатора: каждая «транзакция» атомарна (снапшот мира + откат при ошибке).

Из этого следуют два важных ограничения отчёта:

1. **Всё, что утверждается про economy/rewards/features/assets, проверено на
   уровне source + семантики ограничений, а не на уровне скомпилированного
   бинаря.** Реальный `anchor build` + `bank`/validator-тест по-прежнему
   обязательны перед деплоем (см. §8).
2. **Compute-unit бюджет, rent в реальном runtime и поведение CPI не измерялись**
   — только статически (ограниченные циклы, отсутствие сканирования, точные
   `space`).

Покрытие модели economy-программы полное: 16 accounts-структур, 19 инструкций,
все константы и все pure-хелперы (`split_fee_v2`, `reserve_prizes_v2`,
`tier_fees_v2`, `proof_depth`, `merkle_leaf{,_v2}`, `verify_proof{,_v2,_indexed}`).
Для rewards/features/assets проверены source-инварианты и accounts-структуры
(их handler'ы в модель не переносились — там нет движения средств, кроме
`rewards::claim`, который проверен статистически по тому же чек-листу).

---

## 1. Вердикт

**Контракт защищён существенно выше среднего уровня для self-audited проекта, и
ни одной критической или высокой уязвимости в текущем checkout не найдено.**
Классы атак, которые обычно убивают такие программы — подделка config/PDA,
type cosplay, повторный claim, кража rent через `close`, aliasing vault/treasury,
переполнение комиссий, token-2022 permanent delegate, короткий Merkle-proof,
захват `initialize` случайным вызывающим — **закрыты, и каждый закрыт
исполняемым тестом** (§3, §4).

Найдено **10 дефектов**: 2 MEDIUM, 5 LOW, 3 INFO. **В тот же день исправлены
девять из десяти: F-01, F-01b, F-02, F-03, F-04, F-05, F-07, F-08, F-09** плюс
пункт E29 — см. врезки в шапке. Единственная оставшаяся — **F-10** (INFO,
сознательно переведена в Managed-статус: сплит остаётся, конвенция задекларирована
и машинно-проверяется, миграция — задача преддеплойного окна). Ни одна из находок
не позволяла украсть средства игрока или отпечатать токен внешнему атакующему;
все они про админ-плоскость, наблюдаемость, кросс-программное доверие и
гигиену. Самые содержательные (обе теперь закрыты):

* **F-01 (MEDIUM, ИСПРАВЛЕНО)** — оператор мог мгновенно поднять рейк с 0% до
  20% (`MAX_RAKE_BPS`) без единого on-chain события и без timelock. Теперь:
  шаг ≤ 2,5 п.п. за вызов (`MAX_RAKE_STEP_BPS`), событие
  `ParamsChanged{,V2}` на каждое принятое изменение, потолок v1-fee.
* **F-04 (MEDIUM, ИСПРАВЛЕНО)** — выдача бейджей в `assets` доверяла битам из
  `features`, не проверяя, что `features` управляется тем же оператором: две
  программы бутстрапятся независимо, и владелец `features` мог выдать себе
  любой из 256 ачивментов и отчеканить бейдж через `assets` вообще без участия
  assets-authority. Теперь оператор пинится в `AssetsConfig`, реестр несёт
  штамп оператора, и оба mint-пути сверяются с живым features-config PDA.

Отдельно: **в самом тестовом харнесе репозитория и в моих ранних черновиках было
найдено 6 дефектов, каждый из которых давал ложную уверенность** (неверная
формула rent, неверная семантика `has_one`, алиасинг слоёв Merkle, `close` до
тела инструкции, неверный `legacy_config` в `initialize_v2`, общая таблица
seed-констант на 4 программы). Они перечислены в §7 — их стоит прочитать, потому
что часть из них (`rentExempt`, `has_one`) выглядела как «пройденный тест».

---

## 2. Матрица находок

| ID | Находка | Компонент | Severity | Confidence | Закрепляющий тест |
|---|---|---|---|---|---|
| **F-01** | `set_params`/`set_params_v2`: смена рейка без события и без timelock, без ограничения дельты — **исправлено 2026-09-26**: `MAX_RAKE_STEP_BPS` + `ParamsChanged{,V2}` (economy:51,152,576,842) | `economy/src/lib.rs` | **MEDIUM → FIXED** | High | `security_findings` F-01 (регрессия) |
| **F-01b** | v1 `fee_match`/`fee_tournament` не имеют верхней границы — **исправлено**: `MAX_ENTRY_FEE` + `FeeAboveCeiling` (economy:57) | `economy/src/lib.rs` | LOW → FIXED | High | F-01b (регрессия) |
| **F-02** | sweep не покрыт pause-гейтом — **исправлено**: `require!(!paused)` первым утверждением обоих sweep-хендлеров (economy:400,578) | `economy/src/lib.rs` | LOW/MED → FIXED | High | F-02 (регрессия + X6-матрица) |
| **F-03** | Ротация authority в economy не эмитит событий — **исправлено**: `AuthorityChangeProposed{,V2}` / `AuthorityChanged{,V2}` с treasury_ata в accept (economy:205,226,622,642) | `economy/src/lib.rs` | LOW → FIXED | High | F-03 (регрессия, исполняемо) |
| **F-04** | `mint_badge_core` доверяет реестру `features`, не сверяя authority двух программ — **исправлено**: пин `features_authority` + штамп реестра + живая сверка config PDA (assets:73,174,554,625; features:116,156,366) | `assets`, `features` | **MEDIUM → FIXED** | High | F-04 (регрессия + зеркало гарда) |
| **F-05** | `MintBadge{Core,Compressed}.collection` несли по два атрибута account-атрибута — **исправлено**: слиты в один, handler-дубль сохранён | `assets/src/lib.rs` | LOW → FIXED | High | F-05 (регрессия) |
| **F-06** | `create_collection`: seed переменной длины (`name`) безопасен **только** потому, что последним идёт 32-байтовый pubkey | `assets/src/lib.rs:636` | LOW | High | F-06 (guard) |
| **F-07** | Регистрация бесплатна при балансе 0.01 SOL — **исправлено**: возвратный стейк-лок `REGISTRATION_STAKE_LAMPORTS` в registration-PDA + `reclaim_stake` (features) | `features/src/lib.rs` | LOW → FIXED | High | F-07 (регрессия) |
| **F-08** | `RateLimiter.buckets` никогда не чистился — **исправлено**: idle-eviction после окна полного восстановления + жёсткий `maxBuckets` | `backend/src/http.ts` | LOW → FIXED | High | `backend/test/ratelimit.test.ts` F-08 (регрессия) |
| **F-09** | Док-комментарий ссылался на несуществующий `onchain/src/pda.ts` — **исправлено**: указывает на `onchain/src/constants.ts` | `rewards/src/lib.rs` | INFO → FIXED | High | F-09 (регрессия) |
| **F-10** | Разная endianness u64-seed между программами (economy LE; rewards/features/assets BE) | `rewards` / `economy` / `features` / `assets` | INFO → **MANAGED** | High | F-10 (инвентарь + декларации) |

### F-01 (MEDIUM) — экономические параметры меняются молниеносно и невидимо

`set_params_v2` целиком:

```rust
require!(rake_bps <= MAX_RAKE_BPS, EconomyError::InvalidRake);
let config = &mut ctx.accounts.config;
config.rake_bps = rake_bps;
Ok(())
```

Никакого `emit!`, никакого `Clock`, никакого ограничения на дельту. Исполняемая
проверка (`security_findings.test.ts`, F-01): рынок с `rake_bps = 0`, один вызов
`adminV2({ rakeBps: 2000 })` → `config.rake_bps == 2000`, **число событий в мире
не изменилось**. Для контраста тот же тест показывает, что `set_paused_v2`
событие эмитит (`AdminPausedV2`) — именно это и делал фикс SW027 из прошлого
аудита, но на экономически более сильную инструкцию он распространён не был.

*Что НЕ пострадает:* уже купленные билеты защищены — `refund_entry_v2`
возвращает **сохранённый** в билете сплит (`ticket.rake`/`ticket.prize`), а не
текущий рейк; это проверено в X7, включая попытку подменить сохранённый сплит
(`rake + prize != amount` → `InvalidAmount`). То есть ретро-кража невозможна,
риск — prospective: игрок платит 20% рейк, не имея способа это обнаружить.

**Remediation (выполнено в тот же день).** Выбран потолок дельты вместо
timelock: timelock потребовал бы PDA «pending params», т.е. изменение layout'а
аккаунтов, а размеры `EconomyConfig`/`EconomyConfigV2` должны остаться
байтово-идентичными (их по оффсетам читают backend и SDK). Что сделано:

* `MAX_RAKE_STEP_BPS = 250` (2,5 п.п. за вызов; понижения не ограничены —
  `saturating_sub`) в `set_params` **и** `set_params_v2` (economy:51,152,576);
* `emit!(ParamsChanged { .. })` / `ParamsChangedV2` на каждое принятое
  изменение — со старыми и новыми значениями всех параметров (economy:842,853);
* F-01b: `MAX_ENTRY_FEE = 2_000 * 1_000_000_000` (топ-тир v2 при максимуме
  decimals) и ошибка `FeeAboveCeiling` для v1-fee (economy:57);
* зеркальная офчейн-проверка: `rakeStepViolation()` в
  `backend/src/economy_v2_rpc.ts` — индексатор, наблюдающий два снапшота
  конфига, флагнет скачок даже если программу апгрейдят с вырезанным гейтом.

Остаточный риск зафиксирован в коде явно: добросовестный оператор всё равно
дойдёт до кэпа за `2000/250 = 8` подписанных транзакций — но каждая теперь
видна на цепи. Регрессия `security_findings` F-01 исполняемо проверяет: прыжок
0→2000 отклоняется (`RakeStepTooLarge`), шаг 0→250 принимается и логируется,
понижение до 0 мгновенно, постепенный путь из 8 шагов доходит до кэпа,
событие есть на каждом принятом изменении и нет на отклонённых.

### F-04 (MEDIUM) — кросс-программная выдача бейджей без сверки операторов

`require_achievement_registry` (assets) проверяет ровно то, что нужно для защиты
от type cosplay: PDA выводится из `FEATURES_ACHIEVEMENTS_SEED || player` под
`FEATURES_PROGRAM_ID`, владелец аккаунта — `FEATURES_PROGRAM_ID`, дискриминатор
`account:AchievementRegistry`, `data[8..40] == player`, и нужный бит установлен.
Это хорошо. Но **нигде не сверяется, что `features` и `assets` управляются одним
оператором**: обе программы проходят `verify_bootstrap_authority` независимо,
значит их `config.authority` могут быть разными ключами.

`mint_badge_core` подписывается **игроком** (`payer = player`, `player: Signer`),
так что цепочка привилегий такая: владелец `features` → `create_registry`
(игрок не подписывает, `UncheckedAccount`) → `record_achievement` (любой из 256
битов, любому wallet) → игрок сам вызывает `assets::mint_badge_core`. Authority
`assets` в этой цепочке не участвует вообще; единственные гейты — `!paused`,
`badge_id < 256`, safe token account, бит в реестре и
`collection.authority == config.authority`.

**Remediation (выполнено в тот же день).** Реализован вариант «пин оператора»:

* `AssetsConfig` получил поле `features_authority` (assets:625): задаётся при
  `initialize` (новый аргумент), ротируется только assets-authority через
  новую инструкцию `set_features_authority` с событием
  `FeaturesAuthorityChanged` (assets:554,897); `Pubkey::default()` = все
  achievement-пути закрыты (fail-closed);
* `AchievementRegistry` в features получил штамп `config_authority`
  (features:366): `create_registry` проставляет его, `record_achievement`
  требует совпадения с текущим оператором, новая инструкция `restamp_registry`
  позволяет новому оператору явно перевыдавить существующие реестры после
  ротации (повторный `init` PDA невозможен). Layout: 77 → 109 байт —
  **координированный апгрейд features + assets обязателен**;
* `require_achievement_registry` (assets:73) теперь: (1) сверяет штамп реестра
  с пином из `AssetsConfig` → `FeatureAuthorityMismatch`; (2) оба mint-пути
  (`mint_badge_core` и disabled-путь `mint_badge_compressed`) передают живой
  features-config PDA — owner/discriminator сверяются, текущая authority
  features должна совпадать со штампом реестра. Старый layout (77 байт)
  отвергается по длине, а не читается как мусор.

Регрессия `security_findings` F-04 проверяет всё вышеперечисленное по исходникам
плюс исполняемое 1:1-зеркало нового гарда на байтовых буферах: исходная атака
(роуг-оператор features штампит свой реестр) умирает на
`FeatureAuthorityMismatch`; честный флоу проходит; устаревшие биты после
ротации features отвергаются; legacy-аккаунт отвергается по длине.

### F-05 (LOW) — два `#[account(...)]` на одном поле

```rust
#[account(seeds = [COLLECTION_SEED, collection.name.as_bytes(), collection.authority.as_ref()],
          bump = collection.bump)]
#[account(constraint = collection.authority == config.authority @ AssetsError::Unauthorized)]
pub collection: Account<'info, Collection>,
```

Поведение Anchor при повторяющихся атрибутах `#[account]` зависит от версии
парсера; для ревьюера намерение нечитаемо. Это было LOW исключительно потому,
что handler дублировал проверку (`require!(collection.authority ==
config.authority)`).

**Remediation (выполнено).** Атрибуты слиты в один (seeds + bump + constraint)
в обеих структурах — `MintBadgeCore` и `MintBadgeCompressed`; handler-дубль
**сохранён** как defence in depth (регрессия F-05 фиксирует и слияние, и
handler-проверку, и неизменность seeds). Тот же двойной паттерн во второй
структуре был найден при исправлении — в исходной находке фигурировала только
`MintBadgeCore`.

Дополнительно: seeds здесь **самореференциальные** (`collection.name`,
`collection.authority` — поля самого проверяемого аккаунта), поэтому PDA-проверка
не привязывает коллекцию к данному config; единственная реальная привязка —
constraint/handler-проверка authority. Это стоит закомментировать в source.

### F-06 (LOW, guard-тест) — порядок seed'ов

`[COLLECTION_SEED, name.as_bytes(), authority.key().as_ref()]`: `find_program_address`
конкатенирует байты seed'ов **без разбиения по длинам**, поэтому seed переменной
длины опасен. Здесь коллизии невозможны, потому что переменный `name` (≤32 байт,
`MAX_COLLECTION_NAME`) стоит **перед** фиксированным 32-байтовым pubkey: равные
конкатенации ⇒ равные длины `name`. Тест F-06 — guard: он упадёт, если порядок
изменится или если в любой из 4 программ последний seed окажется переменной длины.

### F-08 (LOW) — не очищаемая карта buckets в rate limiter

`RateLimiter.buckets: Map<string, {tokens, updated}>` рос на одну запись на
каждый новый IP и не чистился никогда. Экспозиция ограничена числом реальных
source IP (`TRUST_PROXY` по умолчанию выключен, ключ — socket peer), поэтому
это медленная утечка (≈100 байт/запись), а не attacker-controlled
amplification: LOW.

**Remediation (выполнено).** Два механизма, оба семантически невидимы для
клиента: (1) bucket, простоявший idle дольше окна полного восстановления
(`capacity / refillPerMs`), неотличим от нового — он удаляется при первом же
обращении после окна; (2) жёсткий потолок `maxBuckets` (по умолчанию 10 000):
при устойчивом давлении активными ключами удаляются наименее свежие —
удалённый клиент получает «новый bucket», то есть ровно те же права, что уже
имеет любой новый ключ, так что eviction не расширяет бюджет атакующего.
В режиме `refillPerMs = 0` idle-eviction отключён (перманентно запрещённый
ключ не должен сбрасываться) — действует только потолок. Регрессия F-08
проверяет все три сценария исполняемо.

---

## 3. Чек-лист 30 пунктов: результат по каждому

Тесты: `onchain/test/security_checklist.test.ts`. «PASS» = утверждение выполняется
и закреплено тестом; «PASS+note» = выполняется, но с оговоркой, вынесенной в §2.

### A. Identity / accounts

| # | Пункт | Вердикт | Evidence |
|---|---|---|---|
| A1 | Все создаваемые аккаунты — seed-PDA с bump | **PASS+note** | 45 инструкций: каждый `init` имеет `seeds`+`bump`+`payer`; `space` точный либо SPL (`token::`/`mint::` ⇒ 165/82 байта). Note: `CreateTree.collection` — program-аккаунт без seeds, привязан `constraint = collection.authority == authority.key()` |
| A1b | PDA off-curve, namespaces не пересекаются | **PASS** | Все v2-namespace заканчиваются на `_v2`, v1-seed'ы заморожены (`neonrelay_economy_config`, `neonrelay_entry`, `neonrelay_prizes`, `neonrelay_prize_claim`); все 4 программы используют префикс `neonrelay_` |
| A2 | Каждое отношение mint/authority/owner закреплено | **PASS** | `has_one`/`address`/`token::mint`/`token::authority` на всех денежных путях; `Initialize.mint` намеренно без constraint'а — operator выбирает mint, он привязан косвенно (`treasury_ata.mint == mint.key()`) и усилен в handler'е (обе authority отозваны) |
| A3 | Payer подписывает, денежные инструкции именуют подписанта | **PASS** | + исполняемо: чужой payer → `missing-signer`, повтор того же reference → `already-initialized`; **своя** оплата чужим кошельком легальна и безопасна, т.к. билет keyed by payer |
| A4 | System/Token программы типизированы | **PASS** | `Program<'info, System/Token/AssociatedToken>` везде, подменить программу нельзя |
| A5 | Создаваемые аккаунты rent-exempt ровно на свой размер | **PASS** | `space = 8 + T::INIT_SPACE` ⇒ rent по формуле runtime; см. §7 про исправленную формулу |
| A6 | Нет zero/default-состояния: handler инициализирует всю структуру | **PASS** | Каждое поле каждого `#[account]`-стата присваивается в handler'е |

### B. State / re-entrancy

| # | Пункт | Вердикт | Evidence |
|---|---|---|---|
| B7 | Всё состояние записано до внешнего CPI | **PASS** | `pay_entry*`, `claim_prize*`, `sweep*`, `refund_entry_v2`, `rewards::claim`, `features/assets::mint_*` — все пишут до `token::transfer`/`mint_to`. Исполняемо: replay claim невозможен |
| B8 | Нет self-CPI, нет доверия к instruction introspection, нет рекурсии | **PASS** | Ни одного `sysvar::instructions`, ни одного вызова самого себя |
| B9 | Нет кешированных глобалов | **PASS** | Нет `static mut`/`OnceCell`; config читается из аккаунта каждый раз |
| B10 | Использование Clock ограничено и проверено | **PASS** | `Clock::get()?` (не `unwrap`), все временные сравнения через `checked_add` |

### C. Token / economic

| # | Пункт | Вердикт | Evidence |
|---|---|---|---|
| C11 | Обе mint-authority отозваны до bootstrap | **PASS** | `mint_authority.is_none()` + `freeze_authority.is_none()` в economy (v1+v2) и rewards; исполняемо: живой mint authority → `MintAuthorityNotRevoked` |
| C12 | Token-2022 extension / delegate / native → fail closed | **PASS** | `require_safe_token_account`: `state == Initialized && delegate.is_none() && is_native.is_none() && close_authority.is_none()`; вызывается для каждого token-аккаунта в `pay_entry{,_v2}`, `claim_prize{,_v2}`, `refund_entry_v2`. `assets::create_token_mint_config` **читает сырые 82 байта** classic-SPL mint и требует нули в словах mint/freeze authority — operator-флаги не являются доказательством |
| C13 | Checked-арифметика везде | **PASS** | `u128` для `fee * bps`, `checked_div`, `u64::try_from`, `checked_sub`; ни одного `as u64` для сумм |
| C14 | Отсутствие переполнения при любых входах | **PASS** | Property-тест на 500 случайных `(fee, bps)` включая `u64::MAX`: `rake + prize == fee` всегда |
| C15 | Округление комиссии не в пользу дома | **PASS** | floor-деление: пыль остаётся в призовом пуле (`split(1, 500) → rake 0`); рейк никогда не выше `MAX_RAKE_BPS` |
| C16 | Vault принадлежит программе, произвольный вывод невозможен | **PASS** | `address = config.vault_ata` + `token::authority = config`; ни одна инструкция не принимает произвольный destination. Исполняемо: vault/treasury нельзя передать как player-аккаунт |
| C17 | Replay / front-running | **PASS** | Билет keyed by `(mint, reference, player)`; claim keyed by `(mint, epoch, player)`; leaf v2 = `SHA256(wallet ‖ amount_be ‖ mint)` ⇒ кросс-рыночный replay невозможен (X3) |
| C18 | Ограниченная работа (bounded loops/allocations) | **PASS** | `proof.len() <= MAX_PROOF_LEN(32)`, `leaf_index < leaf_count`, `leaf_count ≤ 10` в v2, leaderboard `1..=64`, tournament capacity `1..=65535`, badge_id `< 256` |
| C19 | События нельзя weaponize | **PASS** | Все `emit!` с фиксированными полями, без `Vec` переменной длины в event'ах денежных путей |
| C20 | Admin power ограничен, timelock'нут, наблюдаем | **PASS** | Cap: `MAX_RAKE_BPS = 2000` (20%) + пошаговый потолок `MAX_RAKE_STEP_BPS = 250` и события `ParamsChanged{,V2}` (фикс F-01); timelock: `MIN_AUTHORITY_DELAY_SLOTS = 432 000` во всех 4 программах, новая authority обязана подписать accept; sweep-delay `PRIZE_SWEEP_DELAY_SECONDS = 604 800` (7 дней); ротация authority наблюдаема во всех 4 программах (фикс F-03); sweep под pause-гейтом (фикс F-02) |

### D. Anchor-specific

| # | Пункт | Вердикт | Evidence |
|---|---|---|---|
| D21 | `space` точный | **PASS** | `8 + T::INIT_SPACE` либо `T::LEN`; сверено со всеми 14 структурами: EconomyConfigV2=172, EntryTicketV2=131, PrizeEpochV2=101, PrizeClaimV2=89, PendingAuthorityV2=73, EconomyConfig=196, EntryTicket=82, PrizeEpoch=61, PrizeClaim=57, EntryRefundedV2=104, PrizeClaimed=48, PrizeSwept=48, AdminPaused=33, AdminPausedV2=33 |
| D22 | Каждый `init` именует payer + system program | **PASS** | Без исключений; `init_if_needed` не используется нигде |
| D23 | `mut` только там, где реально пишем | **PASS** | Сверено по телам handler'ов |
| D24 | Типизированная десериализация | **PASS** | `Account<'info, T>`/`Box<Account<..>>`; `UncheckedAccount` только с `/// CHECK:` и с последующей проверкой в handler'е |
| D25 | `/// CHECK:` задокументированы | **PASS** | Каждый CHECK объясняет, чем аккаунт будет проверен |
| D26 | Пины тулчейна и зависимостей | **PASS** | `verify:ids`, `verify:toolchain` скрипты и Anchor.toml-пины на месте |

### E. Runtime

| # | Пункт | Вердикт | Evidence |
|---|---|---|---|
| E27 | Compute budget: ограниченные аллокации | **PASS** | Статически: нет циклов по неограниченным коллекциям, нет `Vec::with_capacity` от user input без bound |
| E28 | Rent от `close` уходит только в привязанный аккаунт | **PASS** | `close = player` в `refund_entry_v2` при `constraint = ticket.player == player.key()`; `close = new_authority` в accept при `pending_authority.new_authority == new_authority.key()`. Исполняемо: impostor не получает rent и не закрывает чужой билет |
| E29 | Aliasing config/treasury/vault исключён | **PASS+note** | vault_ata `token::authority = config` и treasury_ata `token::authority = config.authority` ⇒ один token-аккаунт не может быть обоими; `player_ata != config.vault_ata` во всех v2-денежных путях; `new_treasury_ata != config.vault_ata` в обоих accept. Note: `ClaimPrizeV2` не несёт `!= config.treasury_ata` (симметрия ради симметрии, не эксплуатируемо) |
| E30 | Нет deprecated sysvar, `unsafe`, паник | **PASS** | По всем 4 программам (с исключением `#[cfg(test)]`-модулей): 0 `unsafe`, 0 `panic!`, 0 `init_if_needed`, 0 deprecated sysvar; все `.unwrap()` — это `try_into().unwrap()` на срезе с только что проверенной длиной (infallible, error type `()`) |

### 31. Дифференциальный fuzz (модель ↔ Rust ↔ backend ↔ клиент)

* `split_fee_v2`, `tier_fees_v2`, `reserve_prizes_v2`, `proof_depth` — 500+ случайных
  входов, полное совпадение с телами Rust-функций (включая `u64::MAX`).
* `merkle_leaf{,_v2}` и `verify_proof{,_v2,_indexed}` — 200 случайных троек
  `(wallet, amount, mint)` против `backend/src/merkle.ts` и
  `backend/src/economy_v2_codec.ts`, плюс случайные деревья на 1/2/3/5/10 листьев
  с проверкой каждого индекса: **байт-в-байт идентично**.
* `tier_fees_v2(6) == [50e6, 100e6, 500e6, 2e9]` — совпадает с `readSnapshot`
  в backend (расхождение из прошлого аудита **не подтвердилось**, это не finding).

---

## 4. Исполняемая матрица атак (X1–X12)

Каждая строка — реальная попытка атаки в харнесе, а не assert по тексту. Все 12 отбиты.

| # | Атака | Результат |
|---|---|---|
| X1 | Передать поддельный config-аккаунт в любую инструкцию | `pda-mismatch` / `wrong-owner` |
| X2 | Сохранённый bump ≠ канонический | `bump-mismatch` |
| X3 | Cross-market replay: билет/proof одного mint в другом | Билеты и epoch-PDA различаются; proof рынка A → `ProofInvalid` на рынке B; корректный proof B при этом работает |
| X4 | Двойная публикация / двойное резервирование vault | `already-initialized`; `VaultUnderfunded`; rejected-публикация не резервирует ничего (атомарность) |
| X5 | Claim с неверным index/amount/epoch, коротким или длинным proof, нулевой суммой, повтор | `ProofInvalid` / `ProofTooLong` / `ZeroAmount` / `missing-account` / `already-initialized`; отклонённый claim не двигает ни vault, ни кошелёк, ни `remaining`, ни `reserved` |
| X6 | Действия во время pause | `pay_entry_v2`, `publish_prizes_v2`, `claim_prize_v2` → `Paused`. **См. F-02: sweep не покрыт** |
| X7 | Refund: чужой, повторный, с подменённым сплитом | Чужой authority → `has-one-mismatch`; повтор → `missing-account`; `rake+prize != amount` → `InvalidAmount`; rent возвращается игроку, vault и treasury обнуляются ровно на сохранённый сплит |
| X8 | Недофинансированный vault/treasury | Атомарный отказ (`insufficient funds`), **никаких частичных выплат**; после докапитализации тот же claim проходит |
| X9 | Sweep раньше срока / повторный | `PrizeNotExpired` до 7 дней, success после, `NothingToSweep` при повторе, средства уходят строго в treasury |
| X10 | Открыть рынок v2 не legacy-оператором | `verify_bootstrap_authority` против `bpf_loader_upgradeable` ProgramData → отказ |
| X11 | Выбрать более дешёвый/бесплатный tier | Fee-таблица выводится из decimals в коде, аргумент tier только индексирует её |
| X12 | v1-путь: aliasing, чужой mint, перерасход резерва | `WrongVault`/`WrongTreasury`/`WrongMint`/`VaultUnderfunded` |

Timelock проверен исполняемо: `propose` → accept на `slot = deadline - 1` →
`TimelockNotExpired`; на `slot = deadline` → success, config.authority и
treasury_ata обновлены; повтор → `missing-account` (pending PDA закрыт).

---

## 5. Что действительно сильно (и чем это доказано)

1. **Bootstrap защищён от захвата.** Во всех 4 программах `initialize` вызывает
   `verify_bootstrap_authority`: PDA от `[program_id]` под `bpf_loader_upgradeable`,
   владелец — loader, `upgrade_authority_address == authority`. Случайный первый
   вызывающий не может стать оператором.
2. **Mint «мёртв» до запуска.** Обе authority отозваны (economy v1/v2, rewards);
   decimals фиксируются (`EXPECTED_DECIMALS = 6` в rewards). Допечатать токен нельзя.
3. **Token-2022 отсечён по факту, а не по флагу.** `create_token_mint_config`
   читает сырые 82 байта и требует `len == 82 && data[44] == decimals && data[45] == 1`
   и нули в словах mint/freeze authority; `has_permanent_delegate`/`has_transfer_fee`
   — operator-вход, которому программа **не верит**. Плюс
   `require_safe_token_account` на всех денежных аккаунтах закрывает
   delegate/native/close_authority векторы.
4. **CEI соблюдён везде**, включая CPI с signer-seeds от config-PDA.
5. **Арифметика комиссий не переполняется** и округляется в пользу игроков.
6. **Replay-защита структурная**, а не флаговая: уникальность дают `init` на PDA,
   ключеванных полным набором идентичностей. В v1 дополнительно маркеры
   `PrizeClaimed`/`PrizeSwept`/`EntryRefundedV2`.
7. **Двухсторонняя ротация authority с timelock'ом** во всех 4 программах; в v2
   pending-состояние вынесено в отдельный PDA и закрывается при accept
   (one-shot), в rewards/features/assets accept обязан подписать **новый** ключ.
8. **Непроверенные внешние CPI физически недостижимы**: `compile_error!` на
   фичах `core`/`bubblegum`, а `create_tree`/`mint_badge_compressed` возвращают
   `AssetPathNotConfigured` **первым** оператором (проверено тестом F-XX).
9. **Off-chain периметр**: SQL полностью параметризован (единственная
   интерполяция — WHERE из хардкоженных предикатов + allowlist `event_type`);
   `clientIp` доверяет XFF только при `TRUST_PROXY=1` **и** socket из
   `TRUSTED_PROXIES`, **и** значении, прошедшем `isIP()`; admin-плоскость —
   role-split токены, constant-time compare, distinct-approver, полный audit log
   с fingerprint актора и IP.
10. **C++ signer**: `CanonicalEventJson` экранирует `"`,`\` и все байты `< 0x20`
    как `\u00xx` — побайтово совпадает с `JSON.stringify`, поэтому hostile
    `player_id` не даёт ни malleability, ни коллизии канонической строки.
    `LoadSeedHex` валидирует длину (ровно 64) и каждый hex-символ.

---

## 6. Off-chain / game surface — коротко

| Поверхность | Статус | Комментарий |
|---|---|---|
| SQL-инъекции | **чисто** | Все значения через `?`; `game_events.list` интерполирует только предикаты из хардкоженных колонок |
| Rate limiting | **F-08** | Семантика bucket корректна (тесты 1–4), но Map не чистится |
| IP-атрибуция | **чисто** | CRITICAL-04/MED-02 фикс на месте и теперь закреплён тестами |
| Admin-плоскость | **чисто** | distinct-approver + `self_approved` флаг в single-token режиме |
| Reward caps | **чисто** | Капы считаются по **обеим** осям (player_id и wallet_binding_id), CRIT-02 фикс закреплён регрессиями |
| C++ signer | **чисто** | Детерминированная каноническая сериализация, валидация seed |
| C++ game server | **не проверено** | Не компилировалось; входная валидация событий проверена только на стороне backend-инжеста |

---

## 7. Дефекты, найденные в самом харнесе (ложная уверенность)

Это стоит отдельного раздела: шесть багов выглядели как «зелёные тесты».

| # | Дефект | Эффект | Фикс |
|---|---|---|---|
| H-1 | `rentExempt` считал `((space+128) * 3_480e6 * 2) / 1 MiB` — «mebi» перепутано с константой 3480 | Все rent-числа занижены на ~4.6% (0 → 849 609 вместо **890 880**; 165 → 1 950 000 вместо **2 039 280**); любой assert про «достаточно lamports» проходил ложно | Формула runtime: `(space + 128) * 3480 * 2`. Тест H44 теперь сверяет оба эталонных числа |
| H-2 | `has_one = authority` резолвил ожидаемое значение как **ключ самого аккаунта**, а не его сохранённое поле | Любая проверка authority проходила даже при чужом подписанте — то есть **главный auth-гейт харнеса не работал** | `has_one` читает `acc.data[field]`; добавлен тест «незнакомцу нельзя предложить ротацию» |
| H-3 | `layers.push(next); layer.length = 0; layer.push(...next)` — `layers` хранил ссылки на один и тот же массив | Все слои Merkle схлопывались в корень ⇒ **сгенерированные proof'ы не верифицировались против своего же корня** при leaf_count > 1 | Переприсваивание `current = next` вместо мутации |
| H-4 | `close = target` выполнялся внутри `evalAccounts`, до тела инструкции | `refund_entry_v2` терял данные билета; семантика Anchor (exit handler) нарушена | `applyCloses()` вызывается после успешного тела |
| H-5 | `initializeV2` передавал в `legacy_config` **v2** config PDA | `pda-mismatch` вместо проверяемой ошибки; тесты на mint authority не доходили до handler'а | `keys.legacyConfig` (v1 PDA от `CONFIG_SEED`) |
| H-6 | Одна глобальная таблица seed-констант на 4 программы, `useConstants` её очищал | `CONFIG_SEED` = `neonrelay_economy_config` в economy, но `neonrelay_config` в rewards; загрузка второй программы **молча перепривязывала PDA первой** | Таблица keyed by `declare_id!`, резолвинг по `world.programId` |

Плюс атомарность: харнес мутирует граф объектов, поэтому без явного отката
отклонённая инструкция оставляла полуприменённое состояние (`init`-PDA созданы,
балансы сдвинуты). Добавлены `snapshot`/`restore` с **глубоким** копированием
`data` (поверхностная копия оставляла общие вложенные объекты — отдельный баг),
и `transfer` теперь сначала дебетует. Без этого тест X8 («нет частичной выплаты»)
проходил бы ложно.

---

## 8. Что этот отчёт НЕ доказывает

1. **Программы не компилировались.** `anchor build`, `cargo test -p neonrelay-*`
   (включая `tests/golden_leaf.txt`-вектор в rewards) и
   `programs/neonrelay-economy/tests/{v2_unit,v2_runtime,v2_validator}.rs`
   должны пройти в CI с Solana toolchain.
2. **Нет validator/bank-тестов** — реальное поведение CPI, rent и CU не измерено.
   Пункт E27 (compute budget) проверен только статически.
3. **Нет finalized-RPC верификации** задеплоенных адресов; `declare_id!` в
   assets помечен в source как placeholder («заменить `anchor keys list` перед
   деплоем»).
4. **C++ game server не собирался**; входная валидация на стороне сервера
   проверена только через backend-инжест.
5. **`upgrade_authority` не зафиксирован как renounced/мультисиг** — при
   живом upgrade authority любой из выводов отчёта может быть отменён одним
   апгрейдом программы. Это вне исходного кода и должно быть проверено
   операционно перед mainnet (см. `docs/PRODUCTION_DEPLOY_GATE.md`).
6. **Wall-clock длительность `MIN_AUTHORITY_DELAY_SLOTS = 432 000`** зависит от
   кластера (≈2 дня при 400 ms/slot); source сам это оговаривает, но измерение
   остаётся операционной задачей.

---

## 9. Приоритетный план

**Перед любым публичным деплоем (blocking):**
1. ~~F-01 — событие `ParamsChanged` + ограничение дельты/timelock на рейк.~~
   **Выполнено 26.09** (шаг `MAX_RAKE_STEP_BPS`, события, потолок `MAX_ENTRY_FEE`
   для v1, офчейн-зеркало в `economy_v2_rpc.ts`).
2. ~~F-04 — привязка features-authority в `AssetsConfig`.~~ **Выполнено 26.09**
   (пин `features_authority`, штамп `config_authority` в реестре,
   `restamp_registry`, живая сверка с features-config PDA в обоих mint-путях).
3. Прогнать реальный `anchor build` + все Rust-тесты + bank-тесты (§8.1–8.2) —
   **теперь строго обязателен**: фикс F-04 меняет layout `AchievementRegistry`
   (77 → 109 байт) и аргументы `initialize`/`mint_badge_*` в assets, поэтому
   features и assets деплоятся скоординированно, а IDL/клиенты пересобираются.

**Короткий срок (закрыт целиком 26.09, итерация 3):**
4. ~~F-02 — pause-гейт на sweep.~~ **Выполнено**: оба sweep-хендлера начинаются
   с `require!(!paused)`; sweep добавлен в исполняемую X6-матрицу паузы.
5. ~~F-05 — слить дублирующиеся `#[account]`.~~ **Выполнено**: слиты в
   `MintBadgeCore` и `MintBadgeCompressed`, handler-дубль сохранён.
6. ~~F-08 — eviction в `RateLimiter`.~~ **Выполнено**: idle-eviction +
   жёсткий `maxBuckets` (10 000), семантика bucket'ов не изменилась.
7. ~~F-03 — события ротации authority в economy.~~ **Выполнено**:
   `AuthorityChangeProposed{,V2}` / `AuthorityChanged{,V2}` (с treasury_ata).

**Гигиена:**
8. ~~F-01b (потолок v1-fee)~~, ~~F-09 (док-указатель)~~, ~~симметрия
   `!= config.treasury_ata` в `ClaimPrizeV2`~~ — **выполнено 26.09**.
9. ~~F-07 (stake за регистрацию)~~ — **выполнено 26.09 (итерация 4)** без
   продуктового компромисса: не форфейт, а **возвратный capital lock**
   `REGISTRATION_STAKE_LAMPORTS = 0.01 SOL` в registration-PDA; возврат через
   `cancel_registration` (в окне) и новую `reclaim_stake` (после конца
   турнира); гард рент-освобождённости надгробия (`RegistrationStakeMissing`)
   закрывает и сценарий pre-upgrade аккаунтов; событие
   `RegistrationStakeReturned` на каждом возврате. Синхронизированы
   `docs/SOLANA_ARCHITECTURE.md` и `docs/ASSETS_PRODUCTION_DEPLOYMENT.md`.
10. **F-10** — переведена в **MANAGED** (итерация 4): сплит endianness
    остаётся (economy LE; rewards/features/assets BE — так согласовано всеми
    зеркалами, включая Android), но конвенция задекларирована у seed-констант
    каждой программы, а тест F-10 машинно проверяет инвентарь всех
    `seeds = [...]`-сайтов: появление seed'а с противоположным порядком или
    пропавшая декларация роняют тест. **Остаточная задача преддеплойного
    окна**: унификация на LE одним скоординированным PR по 4 стекам (Rust
    rewards+features, backend reconcile/routes, Android RewardsTxBuilder с
    golden-PDA в `RewardsTxBuilderTest.kt`) с запускаемыми Android-тестами —
    CI Android-сюиту сейчас не запускает, поэтому миграция вслепую запрещена.

---

## 10. Как воспроизвести

```bash
# 45 тестов чек-листа (A1–E30 + X1–X12 + fuzz-паритет), 12 тестов находок
# F-01…F-10 и 3 теста итерации 5 (F-20…F-22):
cd onchain && npm test            # 110 passed

# rate limiter / clientIp (включая F-08), зеркальная политика рейка (F-01)
# и сюита итерации 5 (F-11…F-16 + production-гейт F-19):
cd backend && npm test            # 282 passed

# Регрессии прошлого аудита (H-01, M-01…M-04):
node --experimental-strip-types --test "audit/2026-09-21/*.test.ts"   # 10 passed
```

Тесты **исправленных** находок (F-01, F-01b, F-02, F-03, F-04, F-05, F-07,
F-08, F-09) инвертированы в регрессии: они падают, если фикс тихо откатят или
ослабят. Зелёными остались только: **F-06** (guard, а не дефект — пинит
безопасный порядок seed'ов) и **F-10** (MANAGED: сплит закреплён сознательно,
инвентарь u64-seed и декларации конвенций проверяются машинно; миграция —
задача преддеплойного окна, см. §9.10).
