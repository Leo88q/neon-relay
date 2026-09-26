# Neon Relay — Synthwave «Night Drive» Design System

Status: **adopted 2026-09-17** (operator choice via concept review).
Concepts: `docs/design/concepts/` — menu + gameplay frames in three styles
(A outrun, B night drive, C miami). Decision: **B (Night Drive) as the base
style for every surface, with A's striped-sun / chrome accents reserved for
menu, wallet and promo art** (hybrid). C kept as a candidate seasonal theme.

## Tokens

| Token | Hex | RGB | Use |
|---|---|---|---|
| night-0 (base) | `#05060E` | 5,6,14 | deepest background, vignettes |
| night-1 (panel) | `#0A0E1E` | 10,14,30 | terrain slabs, glass panels (alpha ~60–80%) |
| night-2 (raise) | `#101A30` | 16,26,48 | raised cards, selected rows |
| cyan (primary) | `#4DE3F7` | 77,227,247 | safe surfaces, hooks, outlines, UI primary, touch controls |
| pink (accent/danger) | `#FF2E88` | 255,46,136 | hazards, spikes, moving platforms, hot accents, horizon glow |
| indigo (secondary) | `#6C60FF` | 108,96,255 | secondary glow, links, wallet highlights |
| ice (text) | `#D8F6FF` | 216,246,255 | labels, HUD digits |
| dim (grid) | `#607494` | 96,116,148 | background grid lines, disabled states |
| sun-top (accent A) | `#FF5F6D` | 255,95,109 | striped sun gradient start — menu/promo only |
| sun-bottom (accent A) | `#FFB020` | 255,176,32 | striped sun gradient end — menu/promo only |

Semantic rule (gameplay legibility): **cyan = safe/traversable, pink =
lethal/risk**. Hazards never use cyan; safe platforms never use pink.

## Surface mapping

- **Gameplay tiles / terrain**: night-1 slabs, cyan top-edge line only,
  no full outlines; spikes & movers = pink.
- **HUD**: monospace-ish digits in ice on night-1 glass pills; timer cyan,
  economy chip (`SKR n`) indigo outline.
- **Touch controls**: glass rings, inactive fill `#0A0E1E4D`, active tint
  `#4DE3F733` (data/touch_controls.json).
- **Menus / settings / wallet**: night-0 backdrop with dim perspective grid
  and pink horizon line; panels night-1 glass; selection = cyan fill +
  pink underline; menu glow blob = striped sun (accent A), see
  `data/blob.png` generator.
- **Brand / promo / launcher**: chrome-gradient logotype + striped sun
  behind (accent A); body copy in ice on night-0.
- **Skins**: base palette per token table; house skins `nightdrive`
  (night body, cyan outline, pink stripe) and `outrun` (sun gradient body,
  cyan band) ship the two poles of the system.

## Implementation points

- UI sheets & blob: `scripts/build_neon_ui_art.py` (tokens at top of file).
- Skins: `scripts/build_neon_skins.py` (`BRAND_CYAN`, `BRAND_MAGENTA`, specs).
- Default interface accent: `UiColor` default `0xE64DE3F7`
  (`src/engine/shared/config_variables.h`).
- Touch theme: `data/touch_controls.json`.
- Regenerate + gates: run both generators, then
  `scripts/gen_asset_manifest.py`, `scripts/check_assets.sh`,
  `scripts/build_neon_ui_art.py --check`.

Out of scope for now (parked): theme C «Miami» as a seasonal skin/theme pack;
in-game map tileset reskin (BL-14 maps work will pick these tokens up).

## Stage 19 — mapres night pass (2026-09-17)

`scripts/build_neon_mapres.py` recolors the vendored tilesets/backgrounds that
the shipped maps reference (desert_main, ddnet_tiles, round_tiles, snow,
jungle_unhookables, generic_unhookable, bg_cloud1-3, desert_doodads,
jungle_midground, grass_doodads, stars, basic_freeze): hue remap to the token
palette + 128px slab seams + cyan light on exposed top edges + cyan rim on
background silhouettes. Shapes/autotile borders untouched, so tile reading is
identical.

Compliance note: these files stay `block-release` in the manifest — the remap
keeps upstream line work. Commercial release still requires original maps and
tilesets (BL-14); the color language above is what those originals will reuse.
Tilesets embedded inside .map files (e.g. Tutorial's grey grass) are replaced
only together with the original maps.

## Stage 20 — Potato Arena UI pass (2026-09-25)

Interface colour/geometry now has a single source of truth: `src/game/client/neon_style.h`
(`NeonStyle::CYAN/PINK/INDIGO/ICE/DIM/NIGHT_0/1/2/RARE_*`, panel radius 16, card radius 12,
border 2, glow 10, backdrop alpha 0.62 + veil 0.55). Menu/HUD code must use these constants
instead of float literals; the storefront rarity accent comes from `NeonStyle::RarityAccent`
so the card, the portrait frame and the diamonds cannot disagree.

Art: `data/ui/backgrounds/arena_*.png` (one room, seven lighting states, generated in Arena and
baked deterministically by `scripts/build_potato_arena_assets.py`, gate `--check` in CI),
`data/ui/icons/gamification_24.png` (flat icon atlas drawn with the same primitives as
`scripts/build_neon_ui_art.py`), `data/ui/weapons/weapons_6_128.png` (six weapon cells cut out of
`data/game.png`, so a menu icon is the in-combat sprite). Rationale, the token-drift table and the
honest-lobby copy rules: `docs/UI_POTATO_ARENA_REDESIGN_RU.md`.

## Stage 21 — sprite-grid contract (2026-09-25)

`datasrc/content.py` addresses sprites in **cells of the SpriteSet grid**, not in pixels, and
`SelectSprite` divides by that grid at runtime. So three things must agree at all times: the grid
declared in `content.py`, the pitch the generator actually draws at, and the rect of each sprite.
When the original-art pass replaced `data/emoticons.png` (512×512) and `data/gui_icons.png`
(384×64) with new artwork, the rects were left at upstream values: `guiicon_mute (0,0,4,2)` sampled
128×64 px — four icons crammed into a 16px button — and the emoticon glyphs were drawn on a 32px
pitch while `set_emoticons` uses a 4×4 grid (128px cells), so every emote above a tee was a 4×4
collage. `CheckImageDivisibility` only verifies that the image divides by the grid, so CI stayed
green.

The layout is now declared once, in `scripts/build_neon_ui_art.py`
(`EMOTE_GRID`/`EMOTE_CELL`/`EMOTE_NAMES`/`EMOTE_CELLS`, `GUI_ICON_COLS/ROWS/CELL/NAMES/CELLS`), and
`scripts/test_ui_sheet_grids.py` (in `ci.yml` and `scripts/ci-local.sh`) fails if the grid, the
pitch, the rects, the engine's contiguous `SPRITE_OOP + i` order, or the ink inside a named cell
disagree. Rules for anyone touching these sheets:

- Resizing a sheet means editing the generator constants **and** the SpriteSet grid in the same
  commit; the test is the tie-breaker, do not "fix" it by cropping the PNG.
- A menu icon drawn as one `CUi::ICOM_SIZE` quad needs a 1×1-cell rect.
- Both sheets are deterministic (`build_neon_ui_art.py --check`), so glyph changes must land as a
  regeneration, never as a hand-edited PNG.

## Stage 22 — armoury room, map blueprints, icons inside the text flow, landing (2026-09-25)

Three rules earned their keep this stage:

- **One object, one picture.** HUD weapon icons stay cut out of `data/game.png` (`weapon_*` RECTS), and
  the armoury page draws its cards from `data/ui/arsenal/cards_6.png`; the copy lives in
  `src/game/client/neon_arsenal.h`, which is the only table the client page, the operator stand
  (`design/potato-arena/index.html`) and the landing (`design/landing/`) read. `scripts/test_map_catalog.py`
  and `scripts/test_landing_pages.py` fail if a number drifts, so "the marketing says 5 damage" cannot
  happen while the table says 3.
- **Text-flow glyphs are icons too, but only where a sprite can advance the cursor.** The chat friend
  heart and the spectator marks became `IMAGE_GUIICONS` sprites, with `CChat::FriendIconAdvance()` used
  by *both* the measuring and the drawing pass — a mismatch there is a broken line-wrap, not a cosmetic
  bug. The map rating keeps `★`/`✰` on purpose: `src/test/score_test.cpp` parses that string and the
  scoreboard has no sprite atlas to draw from.
- **Previews must be derived, never painted.** `scripts/build_map_previews.py` rasterises the semantic
  grid produced by the map builders themselves (`scripts/build_neon_maps.py`), so a map change moves its
  blueprint, and `--check` makes an out-of-date PNG a CI failure rather than a slow drift. Parsing the
  shipped `.map` v4 binaries instead was tried and abandoned: the fork's `MapWriter` layer int layout and
  `mapitems.h` enum disagree with the vendored upstream engine, and the tile stride is ambiguous.

Landing copy rules inherited from the lobby rules: state the local-only nature of progression, never
promise earnings, and say out loud that paid entry is not accepted, that client-side NFT purchases are
disabled, and that there is no shrinking zone. The page is honest about what does not exist, because a
landing page that overstates a fork is worse than a plain one.

## Stage 23 — the catalogue reads the maps, not the builder (2026-09-25)

Stage 22 said "previews are derived, not drawn". This stage closes the loophole in that sentence:
the maps gallery was derived from `scripts/build_neon_maps.py`, i.e. from the *generator* of five maps,
while `data/maps` ships 27 files. Twenty-two of them had no preview and no numbers on any page, and an
edit to a shipped `.map` (or a new map dropped in the folder) changed nothing anywhere — the page could
not be wrong, because it was never about the real files.

`scripts/neon_mapread.py` now reads the shipped datafile v4 containers directly: item table, raw
blocks, `CMapItemLayerTilemap` with the engine's own upgrade rules (`CMap::UpgradeAndValidateTilesLayerItem`,
engine/shared/map.cpp:455-570 — v2-legacy keeps physics indices at ints 15-19, v3/v4 at 18-22, anything
past the item's length reads as -1), and tile indices with the engine's meaning (1/3 = solid/no-hook,
2 = death, >=191 = entity `index - ENTITY_OFFSET`). One pass then feeds all three surfaces: the 1600x960
blueprint sheet, the generated `neon_maps_gen.h` that `PAGE_MAPS` renders, and the `maps_data.js` the
stand and both landing languages read.

Rules for the next person:

- **Generated tables beat typed tables.** A number that describes a shipped file belongs in a generator
  with a `--check`, never in a header or a page. If a surface needs prose, key it by name and make a
  missing key a build failure (that is what `BLURBS`/`BLURBS_EN` do).
- **A determinism gate must compare pixels, not container bytes — and must not compare what the
  encoder produced at all.** PNG bytes move with the zlib build; worse, `UnsharpMask` and float
  composites run through SIMD paths that differ per CPU, so a fresh bake of the *same art* on another
  machine moves a handful of pixels by 1-2 LSB (measured on the runner: 1-314 of 921,600). The gate
  accepts exactly that shape of noise (`SIMD_PIXEL_DELTA` / `SIMD_CHANGED_FRACTION`) and nothing else:
  a 1600-pixel patch fails with "1600 of 921600 pixels differ, max 20". JPEG derivatives are compared
  against the pixels *before* the encoder, so libjpeg's version never enters the verdict.
- **Make the failure readable before you need it.** The CI step captures the check's output into the
  job summary and repeating `::warning::` lines, which travel as check-run annotations and can be read
  through the API when the raw log cannot be fetched. That is how the SIMD rounding above was found
  after three attempts at guessing. Two traps while doing this: `run:` executes with `set -e`, so a
  failing pipeline must be captured with `|| status=$?` (otherwise the step dies before reporting),
  and there is no point printing diagnostics a reader cannot reach.
- **Third-party names are not user-facing copy.** The map catalogue needed the tileset of every map;
  upstream asset filenames fail `check_branding.sh --release`, so the page prints the licence from
  `data/maps/license.txt` for those rows instead. The gate was right and the copy changed, not the gate.
- **Credits follow the pixels.** As soon as the sheet contained diagrams of other people's CC-BY-SA
  maps, the manifest row stopped claiming the whole file as original work. Deriving a new raster does
  not reset somebody else's attribution.

## Stage 24 — one page frame, and numbers that belong to a test (2026-09-25)

Two habits were still alive after Stage 22. Page titles were typed by hand (28/28/24/28 px) with the
tick-and-note treatment only on the two newest pages, and panel colours were literals — including a
"brand cyan" on the Play button that was a *different* cyan (#0DE6EB) from the token #4DE3F7. Neither
shows up in a diff review, and both make a menu look like it was assembled from three drafts.

- `RenderSectionHeader` is now the only page title in the menu (Races, Wallet, Characters, Leaders,
  Arsenal, Maps), and the Races page carries `RenderSectionBar` because Races/Maps/Arsenal are one
  three-part menu rather than two pages plus an island.
- `NeonStyle::PANEL_FILL / PANEL_BORDER / PANEL_ACCENT / TEXT_SOFT / TEXT_FAINT` replace the repeated
  panel triple; `test_menu_contract.py` fails on any `ColorRGBA(0.x` left in those pages (a fully
  transparent fill is allowed, since it is not a colour choice).
- The landing gained a "features" section, and the numbers in it are asserted against
  `data/skins/potato_catalog.json`, `neon_arsenal.h` and `neon_maps_gen.h`. Rule of thumb for marketing
  copy in this repo: if a sentence contains a number, a test must be able to recompute it, and if it
  mentions money, a negation has to sit in the same sentence.
