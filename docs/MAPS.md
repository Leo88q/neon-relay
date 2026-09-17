# Neon Relay original maps (BL-14)

Every map shipped by Neon Relay is an **original, procedurally generated work**
created for this project. No upstream DDNet/Teeworlds map or map artwork is
distributed: BL-14 removed the five upstream race maps, all dm/ctf/coverage
maps, `data/maps7/` and every upstream `data/mapres/*.png` from the release
tree (historical license record stays in `docs/THIRD_PARTY_NOTICES.md` §4).

## Shipped maps

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

`scripts/map_format.py` is a minimal DDNet datafile v4 writer matching
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
