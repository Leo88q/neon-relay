# Этап B — план удаления классики из пула карт

Статус: **состав согласован, удаление выполнено** (см. «Статус выполнения» ниже).
План фиксирует состав, доказательства и полный каскад — включая точки, которых нет в
исходном списке каскада (раздел «Находки сверх списка»).

## Статус выполнения

Решения по §6: LearnToPlay ×3 — остаём; dm7 — переносим в `docs/dm/upstream/`;
замены `Tutorial`: тесты → «Neon Relay Basin», fallback JoinTutorial → «LearnToPlay»;
объём — удаление + минимальные правки, каскад за владельцем.

Выполнено в Этапе B:

* удалены 16 карт из `data/maps/` и 3 конверсии из `data/maps7/` (19 файлов);
* `data/maps/dm7.map` → `docs/dm/upstream/dm7.map` (байт-в-байт, SHA-256 совпадает с
  закреплённым в `build_chrome_dm.py`; пайплайн Chrome DM жив);
* `scripts/build_chrome_dm.py` — путь `SOURCE` обновлён;
* `src/game/client/components/menus.cpp` — fallback JoinTutorial: `sv_map LearnToPlay`.

Каскад (§3, §4.1) — превью/таблички, описания, `integration_test.py`, манифест,
гейты — выполнен по чек-листу ниже (чекбоксы §3 проставлены). Каталог, лендинг,
превью, манифест и все гейты пересобраны под 11 карт; `docs/MAPS.md`,
`docs/THIRD_PARTY_NOTICES.md`, `docs/KNOWN_LIMITATIONS.md` и
`docs/UPSTREAM_AUDIT.md` приведены к новому составу.

## 1. Состав

### Удаляем: 16 карт = 19 файлов

| Где | Файлы | Кол-во |
| --- | --- | --- |
| `data/maps/` | `ctf1`–`ctf7`, `dm1`, `dm2`, `dm6`, `dm7`, `dm8`, `dm9`, `Sunny Side Up`, `Tsunami`, `Tutorial` | 16 |
| `data/maps7/` | `Sunny Side Up.map`, `Tsunami.map`, `Tutorial.map` (0.7-конверсии тех же карт через `src/tools/map_convert_07.cpp`) | 3 |

`data/maps/` после удаления: **27 → 11** файлов. `data/maps7/`: **5 → 2**.

### Остаётся: 12 файлов

| Карта | Почему |
| --- | --- |
| `Neon Relay Basin`, `Chromatic Canyon`, `Vector Spire`, `Midnight Circuit`, `Aurora Ascent` | наши, генератор `scripts/build_neon_maps.py` (BL-14), Zlib |
| `Neon Relay Warmup` | наш, `scripts/build_warmup.py`, Zlib |
| `Gold Mine` | апстрим `<BµmM>` (CC-BY-SA), но в нашем пуле; конверсия `data/maps7/Gold Mine.map` остаётся |
| `LearnToPlay`, `LearnToPlay Sound`, `LearnToPlay Sound Heights` | **оставляем (см. §2.3)** |
| `coverage` | фикстура юнит-тестов, не игровой контент (см. §2.2) |
| `data/maps7/Gold Mine.map`, `data/maps7/LearnToPlay.map` | конверсии остающих карт |

## 2. Доказательная база по «оставляем»

### 2.1 Наши карты (7)

* BL-14 пятерка — `scripts/build_neon_maps.py`, геометрия и арт оригинальные (Zlib).
* `Neon Relay Warmup` — `scripts/build_warmup.py`, `docs/ORIGINAL_MAPS_RU.md`.
* `Gold Mine` — не наша генерация (апстрим, `data/maps/license.txt`: Copyright `<BµmM>`),
  но остаётся в пуле как часть «семёрки».

### 2.2 `coverage.map` — фикстура

* `src/test/gameworld_test.cpp:97,112` — `LoadMap("coverage")`;
* `scripts/integration_test.py:715` — `sv_map coverage`, `:826–830` — ожидаемые ранги на `coverage`.
* Удалять нельзя: C++ тест-сьют не поднимется. Оставляем как есть, статус
  `block-release` в манифесте не меняем (это отдельный вопрос, не Этап B).

### 2.3 LearnToPlay ×3 — **оставляем (репозиторий сделал их своими)**

Это не просто классика: карта — закреплённый источник собственной визуальной переделки.

* `scripts/retheme_learntoplay.py:11` — `SOURCE=data/maps/LearnToPlay.map`, из него
  собираются `LearnToPlay Sound` и `LearnToPlay Sound Heights`. **Удаление
  `LearnToPlay.map` ломает пересборку обоих производных.**
* `scripts/test_map_format.py:81–209` — тесты пересобирают Sound/Heights из
  `LearnToPlay.map` и сверяют слои/квады (то же требование).
* `scripts/test_twmap_pipeline.py:25,68` — три learn-карты + источник в пайплайне twmap.
* `docs/TWMAP_PROBE.json` — пробы по всем трём learn-картам.
* `tests/fixtures/learntoplay_source.json` — SHA-256 источника закреплён.
* Визуальная работа подтверждена: `docs/LEARN_TO_PLAY_SOUND_RU.md` (LED-панели,
  16 кадров кипящего масла, цикл 1,28 с), `docs/learntoplay-oil-audit.json`,
  `docs/learntoplay-visual-audit.json`, генераторы `scripts/learn_oil.py`,
  `scripts/learn_visibility.py`, `scripts/learn_landmarks.py`, `scripts/learn_terrace.py`
  (12-клеточный подиум Heights).
* Провенанс доли Neon Relay уже прописан: `data/maps/license.txt` (стазы Sound/Heights),
  `scripts/gen_asset_manifest.py` (строка про Sound/Heights с share-alike).

Вывод: удалять — **нет**. Это был бы откат собственной проделанной работы.

## 3. Каскад после удаления — чек-лист

Итемы из вашего списка отмечены ✓. Остальное — находки инвентаризации.

### 3.1 Генерация и таблички (ваш список ✓)

* [x] `scripts/build_map_previews.py`:
  * вырезать из `BLURBS`/`BLURBS_EN` записи `Sunny Side Up`, `Tsunami`, `Tutorial`
    (ctf/dm шли через `_fallback` — после удаления он станет мёртвым кодом, можно
    почистить);
  * прогнать без флага: пересоберётся `data/ui/maps/previews.png`,
    `src/game/client/neon_maps_gen.h` (`PREVIEW_CELLS` 27 → 11),
    `design/potato-arena/maps_data.js`, `design/landing/maps_data.js`,
    `design/potato-arena/maps_preview.png`;
  * `build_map_previews.py --check` — гейт чистый.

### 3.2 Описания карт / документация (ваш список ✓, но точки шире)

* [x] `docs/MAPS.md` — счётчик «25 maps» (уже расходится с фактическими 27 → станет 11),
  строки таблицы shipped set, матрица внешних артов (исчезает исключение `ctf4` /
  `jungle_doodads_old`), список sixup-пострадавших → остаётся только `coverage`.
* [x] `design/potato-arena/index.html:471` — рукописная проза «Tutorial, LearnToPlay, …».
* [x] `docs/THIRD_PARTY_NOTICES.md` — строки таблиц §6 и нарратив §7:
  14 block-release карт → 1 (`coverage`); удалённые оформить по прецеденту
  «removed from the release tree» (как `data/maps7/*` в §6).
* [x] `docs/KNOWN_LIMITATIONS.md:74` — «14 maps» → только `coverage`.
* [x] `docs/UPSTREAM_AUDIT.md:93` — список файлов.
* [x] `data/maps/license.txt` — вырезать стазы `Sunny Side Up`, `Tsunami`, `Tutorial`;
  блок `ctf1…dm9, coverage` переписать в одиночный станс `coverage` (block-release
  логику сохранить).
* [x] `docs/branding-scan.csv` — перегенерируется сама при прогоне
  `./scripts/check_branding.sh --release --check-translations`.

### 3.3 `integration_test.py` (ваш список ✓ — но ссылок **4**, не 3)

* [x] `scripts/integration_test.py:792` — `rcon sv_map Tutorial` в `smoke_test`
  (смена карты перед демо) → наша карта. Должна отличаться от `coverage`, иначе
  не будет ребуста и ожидание двух «entered the game» зависнет.
* [x] `:862`, `:885`, `:940` — три утверждения `map.name != "Tutorial"` в
  mastersrv-тестах. **Они уже устарели**: дефолт `sv_map` в репозитории —
  «Neon Relay Basin» (`config_variables.h:471` и `data/autoexec_server.cfg:35`).
  Меняем на имя новой карты по умолчанию (= «Neon Relay Basin», если не выберем иное).

### 3.4 Провенанс в `ASSET_MANIFEST` (ваш список ✓)

* [x] `scripts/gen_asset_manifest.py`:
  * `MAP_INFO` (стр. 81) — вырезать `Sunny Side Up.map`, `Tsunami.map`, `Tutorial.map`
    (остаются `Gold Mine.map`, `LearnToPlay.map`);
  * кортеж classics (стр. 364) — оставить только `coverage.map`;
* [x] `./scripts/check_assets.sh --regenerate` → `docs/ASSET_MANIFEST.csv`;
* [x] `./scripts/check_assets.sh --licenses` — гейт чистый.
  После удаления block-release остаётся ровно один: `coverage` (гейт `--release`
  по-прежнему заблокирован им — осознанно, не трогаем).

### 3.5 Прогон всех гейтов (ваш список ✓)

* [x] `bash scripts/ci-local.sh` целиком; ключевые: `test_map_catalog.py`,
  `test_landing_pages.py`, `test_map_format.py`, `test_twmap_pipeline.py`,
  `build_map_previews.py --check`, `check_assets.sh --licenses`,
  `check_branding.sh --release --check-translations`, `test_neon_dm.py`.

## 4. Находки сверх списка каскада

### 4.1 `test_landing_pages.py` — жёсткие числа карт (сломается CI!)

* `:74` — `assertEqual(len(rows), 27)` → **11**;
* `:115` — кортеж `(10, 6, 27)` (скины/оружие/карты) → `(10, 6, 11)`;
* `:83–87` — лендинг RU/EN обязаны показывать реальный счётчик `<b>11</b>`
  (сейчас в тексте страниц стоит 27);
* `:113–119` — секция features со счётчиками карт в прозе.

Без правки этих чисел гейт лендинга упадёт сразу после регенерации.

### 4.2 `dm7` — источник пайплайна Chrome DM ⚠

* `scripts/build_chrome_dm.py:17–31` — `SOURCE = data/maps/dm7.map`, SHA
  закреплён assert'ом; из dm7 собирается `docs/dm/Neon Relay Chrome DM Study.map`;
* `scripts/test_chrome_dm.py` — пересобирает карту из `SOURCE` (не входит в
  `ci.yml`/`ci-local.sh`, но это действующий dev-гейт);
* `docs/dm/CHROME_DM_RU.md`, `CHROME_STUDY.json`, `NEON_DM_RU.md` — производная
  от dm7 с атрибуцией (CC-BY-SA), остаётся как исторический провенанс.

Варианты (вопрос Q2):
1. **Перенести `dm7.map` в `docs/dm/upstream/dm7.map`** — из игрового пула и из
   ship-дерева уходит, пайплайн и `test_chrome_dm.py` живут правкой одного пути
   (+ allowlist в `branding_scan.py`, если потребуется). Рекомендую.
2. Оставить `dm7` в `data/maps` как исключение (список удаления 15, не 16).
3. Удалить везде: заморозить пересборку Chrome DM (геометрию dm7 зафиксировать
   в `chrome_dm_geometry.py`), удалить `test_chrome_dm.py`.

### 4.3 Клиентская фича JoinTutorial ⚠

* `src/game/client/components/menus.cpp:1679` — кнопка «Join Tutorial Server»;
* `:1824` — fallback локального сервера: `sv_map Tutorial` — **после удаления
  карты фича ломается** (сервер не поднимется, пользователь получит ошибку);
* `src/engine/client/serverbrowser.cpp` `GetTutorialServer()` — сетевая часть
  фичи (тип сервера «Tutorial»), от карты не зависит.

Варианты (вопрос Q3): перенаправить fallback на нашу карту / удалить фичу целиком
(тогда ещё и строки локализации «Join Tutorial Server» в `data/languages/*`).

### 4.4 Не трогаем (проверено — зависимости от файлов нет)

* `src/test/windows_test.cpp` — `change_map ctf5` это строка для теста кавычек;
* `src/test/mapbugs_test.cpp` — `dm1` используется как name+SHA в таблице
  map-багов, файл карты не читается;
* `ci/upstream-reference/**` — исторические снапшоты апстрим-CI (ссылки на
  `ctf4.map`, `Tutorial.map` в фильтрах) — оставить как историю;
* `docs/dm/*` — производная Chrome DM и её провенанс — оставить;
* `data/languages/*` — строки «Join Tutorial Server» и т.п. (решение — в Q3);
* `data/mapres/*` — арты остаются: их используют `coverage` (`grass_main`,
  `generic_unhookable`) и learn-карты (`snow`).

## 5. Итоговое состояние пула

* `data/maps/` (11): 5 × BL-14, `Neon Relay Warmup`, `Gold Mine`,
  `LearnToPlay` ×3, `coverage`;
* `data/maps7/` (2): `Gold Mine`, `LearnToPlay`;
* block-release в манифесте: только `coverage`;
* `mapbugs_test.cpp`, `windows_test.go` — без изменений;
* каталог карт, превью и таблички — перегенерированы одним прогоном
  `build_map_previews.py`.

## 6. Решения по вопросам (согласовано)

1. **LearnToPlay ×3** — **оставляем** (§2.3). Состав удаления: 16 карт / 19 файлов.
2. **dm7 ↔ Chrome DM** — **перенос в `docs/dm/upstream/dm7.map`** (§4.2, вариант 1):
   выполнен, `SOURCE` в `build_chrome_dm.py` обновлён.
3. **Замена `Tutorial`** — тесты → «Neon Relay Basin», fallback JoinTutorial →
   «LearnToPlay» (§4.3, вариант «basin-plus-learn»). Fallback выполнен;
   `integration_test.py` — в каскаде.
4. **Объём** — план + удаление файлов + минимальные правки целостности;
   каскад (превью, описания, манифест, гейты) — за владельцем.
