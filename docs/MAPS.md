# Neon Relay shipped maps

25 maps ship in `data/maps/` (plus 5 Teeworlds 0.7 conversions in `data/maps7/`).
Provenance per file is recorded in `data/maps/license.txt` and enforced by
`docs/ASSET_MANIFEST.csv` (`scripts/gen_asset_manifest.py` + `scripts/check_assets.sh`).

## Shipped set

| Map | Origin | License | Status |
| --- | --- | --- | --- |
| `Neon Relay Basin`, `Chromatic Canyon`, `Vector Spire`, `Midnight Circuit`, `Aurora Ascent` | originals, `scripts/build_neon_maps.py` (BL-14) | Zlib | ship |
| `Neon Relay Warmup` | original authored geometry + embedded original art, `scripts/build_warmup.py` | Zlib | ship |
| `LearnToPlay Sound`, `LearnToPlay Sound Heights` | derivative of LearnToPlay, `scripts/retheme_learntoplay.py` | CC-BY-SA 3.0 | ship (share-alike, Tridemy & Cøke + Neon Relay) |
| `Gold Mine`, `LearnToPlay`, `Sunny Side Up`, `Tsunami`, `Tutorial` (+ `data/maps7/` conversions via `src/tools/map_convert_07.cpp`) | original upstream maps, authors named in `data/maps/license.txt` | CC-BY-SA 3.0 | ship |
| `ctf1`–`ctf7`, `dm1`, `dm2`, `dm6`–`dm9`, `coverage` | classic gameplay maps + `gameworld_test` fixture; no author named anywhere in the tree | CC-BY-SA 3.0 (default rule) | **block-release** (see `THIRD_PARTY_NOTICES.md` §7) |

## External-art matrix

Every shipped map's external image reference resolves to a shipped
`data/mapres/*.png` — all of which are original Neon Relay pixels after the
original-art pass — with exactly one pre-existing exception: `ctf4.map`
references `jungle_doodads_old`, a file that was never in this tree (not even
at HEAD). A dangling reference logs a console error and shows the in-game
"Some map images could not be loaded" warning; the affected layers render with
a null texture (`src/game/client/components/mapimages.cpp`, `ShowWarning` path).

Reference (machine-checked against `data/mapres/`):

* BL-14 originals → their `neonrelay_<style>_sky/_mid/_tiles` + `neonrelay_pulse`
  (Basin: sound; Canyon/Ascent: folds; Spire: circuit; Circuit: chrome).
* Warmup → none external (art is embedded `neonrelay_learn_*` originals).
* Sound / Heights / LearnToPlay → `snow` (procedural replacement).
* Gold Mine → `desert_main`, `jungle_unhookables`.
* Sunny Side Up → `bg_cloud1`, `bg_cloud2`, `desert_doodads`, `jungle_midground`.
* Tsunami → `jungle_midground`.
* Tutorial → `bg_cloud1`, `bg_cloud2`, `bg_cloud3`, `generic_unhookable`, `grass_doodads`, `stars`.
* coverage → `generic_unhookable`, `grass_main`.
* ctf1/ctf7/dm2 → `grass_doodads`, `grass_main`, `mountains`, `sun`.
* ctf2 → winter set (`moon`, `snow`, `stars`, `winter_doodads`, `winter_main`, `winter_mountains[23]`).
* ctf3 → desert set + `moon`.
* ctf4 → jungle set + `grass_main` + dangling `jungle_doodads_old` (see above).
* ctf5/dm1 → `bg_cloud1/2/3`, `generic_unhookable`, `grass_doodads`, `grass_main` (+`mountains`, `sun` for dm1).
* ctf6 → grass/jungle mix incl. `jungle_deathtiles`, `jungle_unhookables`.
* dm6 → desert set + `generic_deathtiles`, `generic_unhookable`, `moon`.
* dm7 → `grass_main`, `grass_doodads`, `moon`, `stars`.
* dm8 → winter set + `generic_deathtiles`, `generic_unhookable`, `moon`, `snow`, `stars`.
* dm9 → grass/jungle mix + `moon`.

## Compatibility costs (documented, not blocking)

* **sixup / 0.7.** When the client runs through sixup (`Client()->IsSixup()`)
  and a map references one of `grass_doodads`, `grass_main`, `winter_main`,
  `generic_shadows`, `generic_unhookable`, `easter` externally, the client
  loads `mapres/<name>_0.7.png` instead (`mapimages.cpp`, `Translated` path).
  The six `*_0.7.png` variants were upstream art and were deleted, so on a
  0.7-protocol session any layer using those names warns and renders null.
  Shipped maps affected through this path: Tutorial, coverage, ctf1/2/4/5/6/7,
  dm1/2/6/7/8/9. Maps using only `neonrelay_*`, embedded, `snow` or
  non-translated names (BL-14 set, Warmup, Sound/Heights, Gold Mine,
  LearnToPlay, Sunny Side Up, Tsunami, ctf3) are unaffected. Restoring 0.7
  layouts as original art is future work.
* **editor / palette.** The in-game editor is removed (`src/game/editor` and
  `data/editor` are gone, asserted by `scripts/test_menu_contract.py`), so no
  map can be authored or palette-tweaked in-client; authoring happens through
  the generator scripts or external tools. `src/tools/map_convert_07.cpp`
  (the `data/maps7/` converter) still ships.
* **community maps.** Runtime-downloaded maps that reference any of the 27
  deleted upstream `data/mapres` names (`basic_freeze`, `ddnet_*`, `water`,
  `light`, `*_0.7`, `round/mixed_tiles`, spares — see the manifest history)
  hit the same warn + null-texture path as the `ctf4` case above. Maps using
  embedded images or the surviving 27 filenames render fully.

## BL-14 originals (reference)

| Map | Size | Character |
| --- | --- | --- |
| `Neon Relay Basin` | 220×70 | balanced intro race: pits with platforms, nohook ceiling passage, teleport shortcut, spike totems, 3 checkpoints (server default) |
| `Chromatic Canyon` | 240×90 | open canyon: wall ledges down to a death river, stepping stones, hook walls back up, high bridge route |
| `Vector Spire` | 160×110 | zigzag ledge-tower climb (rise 4 with 2-tile hookable overlaps), death pits on the floor |
| `Midnight Circuit` | 260×56 | fast flat run: low hop walls, hanging nohook curtains, one long death jump, gate slalom |
| `Aurora Ascent` | 200×100 | rising staircase (rise 3) with death shafts between steps under an aurora ceiling band |

All maps use only original art: `neonrelay_sky.png` (parallax quad backdrop),
`neonrelay_scenery.png` (decor tile layer, detail flag) and
`neonrelay_tiles.png` (game + tele layers).

## Generation & regeneration

```sh
python3 scripts/build_neon_tileset.py      # data/mapres/neonrelay_tiles.png
python3 scripts/build_neon_background.py   # neonrelay_sky.png + neonrelay_scenery.png
python3 scripts/build_neon_maps.py         # all five .map files
python3 scripts/gen_asset_manifest.py      # refresh docs/ASSET_MANIFEST.csv hashes
bash scripts/check_assets.sh               # must pass
```

`scripts/map_format.py` is a minimal datafile v4 writer compatible with the upstream engine format, matching
`src/engine/shared/datafile.cpp` (36-byte header, item type/offset tables,
zlib raw blocks) with builders for info/images/groups/tile layers/quad
layers; item structs follow `src/game/mapitems.h` field order.

## Art & tile contract

* Tileset sheets are 1024×1024 sampled by the renderer as a 16×16 grid of 64px
  cells (`src/game/map/render_map.cpp`, `TexSize = 1024.0f`); art is drawn at
  256px and LANCZOS-downscaled into the cell of its logical id.
* Cell index == logical tile id from `src/game/mapitems.h`: 1 solid slab,
  2 death spikes, 3 nohook, 9 freeze, 33 start, 34 finish, 35 time checkpoint;
  scenery props occupy the same grid in `neonrelay_scenery.png`.
* Teleporters live on a dedicated tele layer (`TILESLAYERFLAG_TELE`,
  `CTeleTile = {number, type}`); the pads are drawn in-game by
  `RenderTelemap` from cells 26/27 of the tile image, so the game layer keeps
  no tele tiles.
* Style: concept A neon density (magenta edge light, glow, circuit grid) on
  concept B night base (dark readable slabs; cyan = safe, pink = lethal),
  per `docs/DESIGN_SYNTHWAVE.md`.

## Solvability rules enforced by the layouts

* jump rises ≤ 4 tiles, ledge overlaps ≥ 2 tiles (hook-assistable);
* horizontal gaps ≤ 5 tiles; under-curtain gaps ≥ 3 tiles;
* no nohook or solid tile ever spans the only route;
* every map has ≥ 3 time checkpoints, a start gate and a finish gate, and
  three spawn entities.

## Server / client notes

* Server default map is `Neon Relay Basin`
  (`MACRO_CONFIG_STR(SvMap, …)` in `src/engine/shared/config_variables.h`).
* Rotate maps with `sv_map "Chromatic Canyon"` etc. via rcon.
* Map info credits read "original Neon Relay map … (BL-14, procedural)";
  license field is Zlib.
