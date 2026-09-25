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
