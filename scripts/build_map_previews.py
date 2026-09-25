#!/usr/bin/env python3
"""Tactical blueprint previews for the Neon Relay maps, drawn from the real geometry.

Why the builders and not the .map files: `scripts/build_neon_maps.py` is the single source of these
maps, and its `Grid` already carries *semantic* tile ids (solid / death / nohook / tele / start /
finish / checkpoint / spawn). Rasterising the grid gives a preview that cannot disagree with the
shipped map, needs no datafile parser, and stays byte-deterministic — the same guarantees the other
`--check` gates in this repo give.

Output: data/ui/maps/previews_5.png — one row of cells, CELL_W x CELL_H each, in MAPS order. The
Arsenal/Maps menu page selects a cell with the same QuadsSetSubset math as the icon atlas, and
scripts/test_map_catalog.py verifies the row count, the order and the cell contents.

Usage:  scripts/build_map_previews.py            # write
        scripts/build_map_previews.py --check    # CI determinism gate
"""
import argparse
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import build_neon_maps as maps  # noqa: E402  the map builders themselves
import build_neon_ui_art as ui  # noqa: E402  tokens + primitives = single style source

OUT = ROOT / "data" / "ui" / "maps"
CELL_W, CELL_H = 320, 160
# Same night-0 the menu composites everything onto (see build_potato_arena_assets.py).
NIGHT_0 = (5, 6, 14)
CYAN, MAGENTA, VIOLET, WHITE, DIM, SUN_BOTTOM = ui.CYAN, ui.MAGENTA, ui.VIOLET, ui.WHITE, ui.DIM, ui.SUN_BOTTOM

# Semantic tile ids from build_neon_maps (T_*), mapped onto the house palette. Order in the legend
# is the order the page prints its caption in.
def tile_colors():
    return {
        maps.T_SOLID: (26, 44, 74, 255),  # between night-2 and night-1: readable over night-0
        maps.T_DEATH: MAGENTA + (215,),
        maps.T_NOHOOK: VIOLET + (150,),
        maps.T_TELEIN: CYAN + (200,),
        maps.T_TELEOUT: CYAN + (120,),
        maps.T_START: WHITE + (220,),
        maps.T_FINISH: SUN_BOTTOM + (240,),  # the sun gradient bottom, i.e. "finish"
        maps.T_CP: CYAN + (235,),
        maps.ENTITY_SPAWN: WHITE + (255,),
    }


def blueprint(grid: "maps.Grid", cell_w: int, cell_h: int) -> tuple[Image.Image, dict]:
    colors = tile_colors()
    # Keep whole tiles: a scaled grid of 220x70 into 320x160 would smear the floor line.
    scale = min(cell_w / grid.w, cell_h / grid.h)
    w, h = max(1, round(grid.w * scale)), max(1, round(grid.h * scale))
    px = np.zeros((h, w, 4), dtype=np.uint8)
    px[..., :3] = NIGHT_0
    px[..., 3] = 255
    stats = {"solid": 0, "death": 0, "nohook": 0, "tele": 0, "spawn": 0, "cp": 0, "finish": 0}
    for y in range(grid.h):
        for x in range(grid.w):
            v = grid.g[y][x]
            col = colors.get(v)
            if col is None:
                continue
            # Paint the tile block (and its supersampled remainder) directly into the buffer.
            x0, x1 = int(x * w / grid.w), max(int((x + 1) * w / grid.w), int(x * w / grid.w) + 1)
            y0, y1 = int(y * h / grid.h), max(int((y + 1) * h / grid.h), int(y * h / grid.h) + 1)
            px[y0:y1, x0:x1] = col
            if v == maps.T_SOLID:
                stats["solid"] += 1
            elif v == maps.T_DEATH:
                stats["death"] += 1
            elif v == maps.T_NOHOOK:
                stats["nohook"] += 1
            elif v in (maps.T_TELEIN, maps.T_TELEOUT):
                stats["tele"] += 1
            elif v == maps.ENTITY_SPAWN:
                stats["spawn"] += 1
            elif v == maps.T_CP:
                stats["cp"] += 1
            elif v == maps.T_FINISH:
                stats["finish"] += 1
    # A 1px light line on every exposed top edge is what makes a floor read as a floor at this
    # size; without it the solid blocks and the air merge into one dark field.
    for y in range(grid.h):
        for x in range(grid.w):
            if grid.g[y][x] != maps.T_SOLID or (y > 0 and grid.g[y - 1][x] == maps.T_SOLID):
                continue
            x0, x1 = int(x * w / grid.w), max(int((x + 1) * w / grid.w), int(x * w / grid.w) + 1)
            y0 = int(y * h / grid.h)
            px[max(0, y0 - 1):y0 + 1, x0:x1] = CYAN + (150,)
    img = Image.fromarray(px, "RGBA")
    return img, stats


def frame(img: Image.Image, cell_w: int, cell_h: int, label: str) -> Image.Image:
    """Center the blueprint in its cell, add the hairline border and the caption strip."""
    out = Image.new("RGBA", (cell_w, cell_h), NIGHT_0 + (255,))
    d = ImageDraw.Draw(out)
    # Very faint grid: enough to say "schematic", not enough to compete with the geometry.
    for gx in range(0, cell_w, 20):
        d.line([(gx, 0), (gx, cell_h)], fill=(255, 255, 255, 5))
    for gy in range(0, cell_h, 20):
        d.line([(0, gy), (cell_w, gy)], fill=(255, 255, 255, 5))
    pad = 3
    out.paste(img, ((cell_w - img.width) // 2, (cell_h - img.height) // 2 + 2), img)
    d.rectangle([0, 0, cell_w - 1, cell_h - 1], outline=CYAN + (90,), width=1)
    d.rectangle([pad, pad, cell_w - 1 - pad, cell_h - 1 - pad], outline=CYAN + (40,), width=1)
    d.text((pad + 3, pad + 1), label, fill=WHITE + (200,))
    return out


def build_atlas(out_dir: Path) -> list[str]:
    out_dir.mkdir(parents=True, exist_ok=True)
    report = []
    cells = []
    for name, build, _blurb in maps.MAPS:
        grid, _decor = build()
        img, stats = blueprint(grid, CELL_W - 8, CELL_H - 22)
        cells.append(frame(img, CELL_W, CELL_H, f"{name}  {grid.w}x{grid.h}"))
        report.append(f"OK  {name:20} grid {grid.w:3}x{grid.h:<3} solid {stats['solid']:5}  "
                      f"death {stats['death']:3}  nohook {stats['nohook']:3}  tele {stats['tele']:2}  "
                      f"spawns {stats['spawn']}  cps {stats['cp']}  finish {stats['finish']}")
    atlas = Image.new("RGBA", (CELL_W * len(cells), CELL_H), NIGHT_0 + (255,))
    for i, cell in enumerate(cells):
        atlas.paste(cell, (i * CELL_W, 0))
    atlas.convert("RGB").save(out_dir / "previews.png", optimize=True, compress_level=9)
    report.append(f"OK  atlas {atlas.size[0]}x{atlas.size[1]}  {len(cells)} cells {CELL_W}x{CELL_H}  "
                  f"{(out_dir / 'previews.png').stat().st_size / 1024:.0f} KiB")
    return report


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--check", action="store_true", help="byte-compare the shipped atlas with a fresh render")
    args = ap.parse_args()

    if args.check:
        tmp = Path(tempfile.mkdtemp(prefix="map-previews-"))
        report = build_atlas(tmp)
        shipped = OUT / "previews.png"
        gen = tmp / "previews.png"
        same = shipped.exists() and gen.exists() and shipped.read_bytes() == gen.read_bytes()
        for line in report:
            print("  " + line)
        print(("  ok   " if same else "  DIFF ") + str(shipped.relative_to(ROOT)))
        print("map previews check: " + ("PASS" if same and not any(r.startswith("MISSING") for r in report) else "FAIL"))
        return 0 if same else 1

    for line in build_atlas(OUT):
        print(line)
    big = Image.open(OUT / "previews.png").convert("RGB")
    sheet = Image.new("RGB", (big.width, big.height * 2 + 24), (8, 8, 12))
    sheet.paste(big, (0, 0))
    sheet.paste(big.resize(big.size, Image.NEAREST), (0, big.height + 24))
    ImageDraw.Draw(sheet).text((4, big.height + 6), "top: as saved / bottom: same pixels, nearest (check the tile edges)",
                                fill=(200, 230, 255))
    sheet.save(ROOT / "design" / "potato-arena" / "maps_preview.png")
    print(f"OK  review sheet -> design/potato-arena/maps_preview.png")
    return 0


if __name__ == "__main__":
    sys.exit(main())
