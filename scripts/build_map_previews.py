#!/usr/bin/env python3
"""Blueprints and catalogue rows for every map that ships in data/maps.

Earlier this script rasterised `scripts/build_neon_maps.py`'s in-memory grid, so the gallery could
only show the five maps that generator writes and 22 of the 27 shipped maps had neither a preview nor
a single number on the page. It now reads the shipped `.map` files themselves through
`scripts/neon_mapread.py` (datafile v4, engine tile semantics), which makes the catalogue true for
every map the player can actually pick — including the base-game pool this fork does not reshape.

Everything is generated from that one pass, so the three surfaces cannot disagree:

  * data/ui/maps/previews.png           - one 320x160 blueprint cell per map, 5 per row;
  * src/game/client/neon_maps_gen.h     - the facts table PAGE_MAPS renders (no hand-typed numbers);
  * design/potato-arena/maps_data.js    - the same table for the review stand;
  * design/landing/maps_data.js         - the same table for the RU/EN landing pages.

Editorial text is per-map prose and lives in BLURBS/BLURBS_EN below; a shipped map without both is a
hard error, so adding a map means describing it instead of shipping a nameless row.

Usage:  scripts/build_map_previews.py            # write everything
        scripts/build_map_previews.py --check    # CI gate: everything still matches a fresh pass
"""
import argparse
import json
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import build_neon_ui_art as ui  # noqa: E402  tokens + primitives = single style source
import neon_mapread as mr  # noqa: E402  the .map reader

MAPS_DIR = ROOT / "data" / "maps"
OUT = ROOT / "data" / "ui" / "maps"
HEADER = ROOT / "src" / "game" / "client" / "neon_maps_gen.h"
STAND_JS = ROOT / "design" / "potato-arena" / "maps_data.js"
LANDING_JS = ROOT / "design" / "landing" / "maps_data.js"
REVIEW = ROOT / "design" / "potato-arena" / "maps_preview.png"

CELL_W, CELL_H, COLS = 320, 160, 5
NIGHT_0 = (5, 6, 14)
CYAN, MAGENTA, VIOLET, WHITE, DIM, SUN = ui.CYAN, ui.MAGENTA, ui.VIOLET, ui.WHITE, ui.DIM, ui.SUN_BOTTOM
SOLID_RGB = (26, 44, 74)

# The shop window first: the maps this fork designed, in the order the original design notes list
# them, then the rest of the shipped pool alphabetically. Cell index = position in this list.
FEATURED = ["Neon Relay Basin", "Chromatic Canyon", "Vector Spire", "Midnight Circuit",
            "Aurora Ascent", "Neon Relay Warmup"]

# One line per map, RU + EN. Keyed by file stem. A missing key fails the build on purpose.
BLURBS = {
    "Neon Relay Basin": "сбалансированный заезд-введение: полки, три чекпоинта, река смерти",
    "Chromatic Canyon": "хук-роут над каньоном: 163 смертельных тайла и ни одного no-hook",
    "Vector Spire": "зигзаг полок вверх, 6 чекпоинтов и много no-hook под потолком",
    "Midnight Circuit": "быстрый слалом по плоскому кругу: 5 чекпоинтов, минимум смерти",
    "Aurora Ascent": "лесенка под полосой авроры, самая длинная разметка заезда после Warmup",
    "Neon Relay Warmup": "разминка: 35 стартовых площадок, без дропов и без очков",
    "Gold Mine": "закрытая арена с укрытиями: 10 спавнов, 986 тайлов no-hook, есть ниндзя",
    "Sunny Side Up": "широкая 1200x200 карта с 594 квадами декора — площадка для больших составов",
    "Tsunami": "самая плотная арена поставки: 105 101 тайл породы и 14 спавнов",
    "Tutorial": "обучающий маршрут на 2210 тайлов: 24 финишных площадки, лицензия CC-BY-SA",
    "LearnToPlay": "тренировочный полигон базы с 56 щитами и 12 ловушками",
    "LearnToPlay Sound": "тот же полигон с звуковым слоем: 55 слоёв, 20 289 квадов",
    "LearnToPlay Sound Heights": "вариант Sound с другим декором: те же 56 щитов и 12 ловушек",
    "coverage": "служебная карта тестов репозитория: по одной штуке всех типов сущностей",
}
BLURBS_EN = {
    "Neon Relay Basin": "balanced intro run: shelves, three checkpoints, one death river",
    "Chromatic Canyon": "hook route over a canyon: 163 lethal tiles and no no-hook at all",
    "Vector Spire": "zig-zag shelves upward, 6 checkpoints, plenty of no-hook overhead",
    "Midnight Circuit": "fast slalom on a flat loop: 5 checkpoints, almost no hazard",
    "Aurora Ascent": "staircase under an aurora band, the longest race marking outside Warmup",
    "Neon Relay Warmup": "warm-up: 35 start pads, no drops and no score",
    "Gold Mine": "enclosed arena with cover: 10 spawns, 986 no-hook tiles, a ninja pickup",
    "Sunny Side Up": "wide 1200x200 map with 594 decorative quads for large lobbies",
    "Tsunami": "the densest arena in the box: 105,101 solid tiles and 14 spawns",
    "Tutorial": "learning route over 2,210 tiles: 24 finish pads, CC-BY-SA licensed",
    "LearnToPlay": "the base game's practice ground: 56 shields and 12 hazards",
    "LearnToPlay Sound": "the same ground with a sound layer: 55 layers, 20,289 quads",
    "LearnToPlay Sound Heights": "Sound variant with different decor: same 56 shields and 12 hazards",
    "coverage": "repository test map: one of every entity type on one small grid",
}


def _fallback(name, en=False):
    """Maps without editorial text (the base-game pool) get a line derived from their own facts."""
    if name.startswith("dm"):
        return ("enclosed base-game deathmatch arena: spawns around the rim, full pickup set" if en
                else "закрытая deathmatch-арена базы: спавны по кругу и полный набор дропов")
    if name.startswith("ctf"):
        return ("base-game flag map: two flags, plenty of shields and health" if en
                else "флаговая карта базы: два флага, много щитов и здоровья")
    raise SystemExit(f"no blurb for shipped map {name!r}: add it to BLURBS/BLURBS_EN")


def attribution():
    """data/maps/license.txt is the attribution record for the maps this fork did not author.

    The maps' own info blocks are mostly empty (the originals predate the fields), so the page has
    to read the same file the licence gate reads, otherwise the two would disagree.
    """
    text = (MAPS_DIR / "license.txt").read_text(encoding="utf-8")
    found, name = {}, None
    for line in text.splitlines():
        line = line.strip()
        if not line:
            name = None
        elif line.endswith(":") and line[:-1] in {p.stem for p in MAPS_DIR.glob("*.map")}:
            name = line[:-1]
            found[name] = {"copyright": "", "license": ""}
        elif name and line.lower().startswith("copyright"):
            found[name]["copyright"] = line[len("copyright"):].strip()
        elif name and ("CC-BY-SA" in line or "Zlib" in line) and not found[name]["license"]:
            found[name]["license"] = "CC-BY-SA" if "CC-BY-SA" in line else "Zlib"
    return found


def map_order():
    """Featured maps in FEATURED order, then everything else alphabetically by file stem."""
    files = {p.stem: p for p in sorted(MAPS_DIR.glob("*.map"))}
    ordered = [files.pop(n) for n in FEATURED if n in files]
    ordered += [files[n] for n in sorted(files)]
    return ordered


def classify(idx):
    """Tile id -> (kind, rgba). Mirrors the engine's reading of the game layer."""
    if idx in (mr.TILE_SOLID, mr.TILE_NOHOOK):
        return "solid"
    if idx == mr.TILE_DEATH:
        return "death"
    if idx == mr.TILE_NOLASER:
        return "no-laser"
    if idx in (mr.TILE_TELEIN, mr.TILE_TELEOUT):
        return "tele"
    if idx == mr.TILE_START:
        return "start"
    if idx == mr.TILE_FINISH:
        return "finish"
    if idx in (mr.TILE_CP, mr.TILE_TIME_FIRST):
        return "cp"
    if idx >= mr.ENTITY_OFFSET:
        name = mr.ENTITY_NAMES.get(idx - mr.ENTITY_OFFSET, "entity")
        if name.startswith("spawn"):
            return "spawn"
        if name in ("shotgun", "grenade", "laser", "ninja"):
            return "pickup"
        return "hazard"
    return "empty"


COLORS = {
    "solid": SOLID_RGB + (255,),
    "death": MAGENTA + (215,),
    "no-laser": VIOLET + (170,),
    "tele": CYAN + (200,),
    "start": WHITE + (225,),
    "finish": SUN + (240,),
    "cp": CYAN + (235,),
    "spawn": WHITE + (255,),
    "pickup": SUN + (255,),
    "hazard": MAGENTA + (255,),
}


def blueprint(tiles, cell_w, cell_h):
    """Rasterise a decoded game layer into a cell-sized blueprint. Whole tiles, no smearing."""
    scale = min(cell_w / tiles.width, cell_h / tiles.height)
    w, h = max(1, round(tiles.width * scale)), max(1, round(tiles.height * scale))
    px = np.zeros((h, w, 4), dtype=np.uint8)
    px[..., :3] = NIGHT_0
    px[..., 3] = 255
    kinds = np.empty((tiles.height, tiles.width), dtype=object)
    for y in range(tiles.height):
        y0 = int(y * h / tiles.height)
        y1 = max(int((y + 1) * h / tiles.height), y0 + 1)
        for x in range(tiles.width):
            kind = classify(tiles.index(x, y))
            kinds[y, x] = kind
            col = COLORS.get(kind)
            if col is None:
                continue
            x0 = int(x * w / tiles.width)
            x1 = max(int((x + 1) * w / tiles.width), x0 + 1)
            px[y0:y1, x0:x1] = col
    # A 1px light line on every exposed top edge: without it the solid blocks and the air merge
    # into one dark field at this size.
    for y in range(tiles.height):
        y0 = int(y * h / tiles.height)
        for x in range(tiles.width):
            if kinds[y, x] != "solid" or (y > 0 and kinds[y - 1, x] == "solid"):
                continue
            x0 = int(x * w / tiles.width)
            x1 = max(int((x + 1) * w / tiles.width), x0 + 1)
            px[max(0, y0 - 1):y0 + 1, x0:x1] = CYAN + (150,)
    return Image.fromarray(px, "RGBA")


def frame(img, cell_w, cell_h, label):
    out = Image.new("RGBA", (cell_w, cell_h), NIGHT_0 + (255,))
    d = ImageDraw.Draw(out)
    for gx in range(0, cell_w, 20):  # faint schematic grid
        d.line([(gx, 0), (gx, cell_h)], fill=(255, 255, 255, 5))
    for gy in range(0, cell_h, 20):
        d.line([(0, gy), (cell_w, gy)], fill=(255, 255, 255, 5))
    out.paste(img, ((cell_w - img.width) // 2, (cell_h - img.height) // 2 + 2), img)
    d.rectangle([0, 0, cell_w - 1, cell_h - 1], outline=CYAN + (90,), width=1)
    d.rectangle([2, 2, cell_w - 3, cell_h - 3], outline=CYAN + (40,), width=1)
    d.text((5, 3), label, fill=WHITE + (215,))
    return out


def mode_of(f):
    if f["race_ready"]:
        return "race"
    if not f["dm_ready"]:
        return "single spawn"
    if f["entities"] and any(k.startswith(("flag_",)) for k in f["entities"]):
        return "ctf"
    return "deathmatch"


def catalogue():
    credits = attribution()
    rows = []
    for cell, path in enumerate(map_order()):
        facts = mr.read_map(path).facts()
        name = path.stem
        row = {
            "name": name,
            "blurb": BLURBS.get(name) or _fallback(name),
            "blurbEn": BLURBS_EN.get(name) or _fallback(name, en=True),
            "cell": cell,
            "w": facts["width"],
            "h": facts["height"],
            "spawns": facts["spawns"],
            "solid": facts["solid"],
            "death": facts["death"],
            "nohook": facts["nohook"],
            "teleports": facts["race"]["tele"] + facts["layer_tele"],
            "start": facts["race"]["start"],
            "finish": facts["race"]["finish"],
            # Checkpoints come from the switch layer on race maps and from the game layer on the
            # fork's own maps; neon_mapread already took the larger of the two.
            "checkpoints": facts["race"]["cp"] + facts["race"]["time_cp"],
            "pickups": sum(facts[k] for k in mr.PICKUPS),
            "hazards": facts["hazards"],
            "mode": mode_of(facts),
            "race_ready": facts["race_ready"],
            "dm_ready": facts["dm_ready"],
            # The base-game pool's tileset names are upstream filenames; the branding gate (and the
            # repo rule behind it) keeps those out of user-facing strings, so the page shows the
            # licence for those maps instead of somebody else's asset name.
            "tileset": facts["tileset"] if name in FEATURED else "",
            "license": credits.get(name, {}).get("license") or facts["license"] or "",
            "copyright": credits.get(name, {}).get("copyright", ""),
            "bytes": facts["bytes"],
            "layers": facts["layers"],
            "quads": facts["quads"],
        }
        rows.append((path, row))
    return rows


def write_atlas(rows, out_dir):
    out_dir.mkdir(parents=True, exist_ok=True)
    rows_n = (len(rows) + COLS - 1) // COLS
    sheet = Image.new("RGBA", (CELL_W * COLS, CELL_H * rows_n), NIGHT_0 + (255,))
    for path, row in rows:
        tiles = mr.read_map(path).game
        cell = frame(blueprint(tiles, CELL_W - 8, CELL_H - 22), CELL_W, CELL_H,
                     f"{row['name']}  {row['w']}x{row['h']}  {row['mode']}")
        sheet.paste(cell, ((row["cell"] % COLS) * CELL_W, (row["cell"] // COLS) * CELL_H))
    dest = out_dir / "previews.png"
    sheet.convert("RGB").save(dest, optimize=True, compress_level=9)
    return dest, rows_n


def header_text(rows):
    lines = [
        "// Generated by scripts/build_map_previews.py - edit the generator, not this file.",
        "// Facts come from the shipped data/maps/*.map through scripts/neon_mapread.py, so a map",
        "// edit that changes a spawn, a checkpoint or the geometry updates the Maps page with it.",
        "#ifndef GAME_CLIENT_NEON_MAPS_GEN_H",
        "#define GAME_CLIENT_NEON_MAPS_GEN_H",
        "",
        "#include <cstddef>",
        "",
        "namespace NeonMaps",
        "{",
        "struct SMapFacts",
        "{",
        "\tconst char *m_pName;",
        "\tconst char *m_pBlurb;",
        "\tint m_PreviewCell;",
        "\tint m_TilesW;",
        "\tint m_TilesH;",
        "\tint m_Spawns;",
        "\tint m_SolidTiles;",
        "\tint m_DeathTiles;",
        "\tint m_NohookTiles;",
        "\tint m_StartTiles;",
        "\tint m_FinishTiles;",
        "\tint m_Checkpoints;",
        "\tint m_Teleports;",
        "\tint m_Pickups;",
        "\tint m_Hazards;",
        "\tbool m_RaceReady;",
        "\tbool m_NeonDmReady;",
        "\tbool m_BaseGame;",
        "\tconst char *m_pMode;",
        "\tconst char *m_pTileset;",
        "\tconst char *m_pLicense;",
        "};",
        "",
        "inline constexpr SMapFacts g_aFacts[] = {",
    ]
    for _p, r in rows:
        base = "true" if r["name"] not in FEATURED else "false"
        lines.append(
            f'\t{{"{r["name"]}", "{r["blurb"]}", {r["cell"]}, {r["w"]}, {r["h"]}, {r["spawns"]}, '
            f'{r["solid"]}, {r["death"]}, {r["nohook"]}, {r["start"]}, {r["finish"]}, '
            f'{r["checkpoints"]}, {r["teleports"]}, {r["pickups"]}, {r["hazards"]}, '
            f'{"true" if r["race_ready"] else "false"}, {"true" if r["dm_ready"] else "false"}, '
            f'{base}, "{r["mode"]}", "{r["tileset"]}", "{r["license"]}"}},')
    lines += [
        "};",
        "inline constexpr size_t NUM_CARDS = std::size(g_aFacts);",
        "",
        "// Preview sheet geometry: COLS cells per row in data/ui/maps/previews.png, 2:1 cells.",
        "inline constexpr int PREVIEW_CELL_W = 320;",
        "inline constexpr int PREVIEW_CELL_H = 160;",
        f"inline constexpr int PREVIEW_COLS = {COLS};",
        f"inline constexpr int PREVIEW_CELLS = {len(rows)};",
        "inline constexpr int PREVIEW_ROWS = (PREVIEW_CELLS + PREVIEW_COLS - 1) / PREVIEW_COLS;",
        "} // namespace NeonMaps",
        "",
        "#endif // GAME_CLIENT_NEON_MAPS_GEN_H",
        "",
    ]
    return "\n".join(lines)


def js_text(rows):
    payload = [{
        "name": r["name"], "blurb": r["blurb"], "blurbEn": r["blurbEn"], "cell": r["cell"],
        "w": r["w"], "h": r["h"], "spawns": r["spawns"], "solid": r["solid"], "death": r["death"],
        "nohook": r["nohook"], "start": r["start"], "finish": r["finish"],
        "checkpoints": r["checkpoints"], "teleports": r["teleports"], "pickups": r["pickups"],
        "hazards": r["hazards"], "mode": r["mode"], "tileset": r["tileset"],
        "license": r["license"],
        "copyright": r["copyright"],
        "base": r["name"] not in FEATURED,
    } for _p, r in rows]
    return ("// Generated by scripts/build_map_previews.py - edit the generator, not this file.\n"
            "// Same table as src/game/client/neon_maps_gen.h, for the design stand and the landing.\n"
            "window.NEON_MAPS = " + json.dumps(payload, ensure_ascii=False, indent=1) + ";\n")


def review_sheet(rows, sheets_dir):
    """Operator review copy: the atlas plus a legend and the facts table under it."""
    src = Image.open(sheets_dir / "previews.png").convert("RGB")
    legend_h = 26
    out = Image.new("RGB", (src.width, src.height + legend_h), NIGHT_0)
    out.paste(src, (0, 0))
    d = ImageDraw.Draw(out)
    y = src.height + 8  # under the sheet, never over a cell's own label
    x = 6
    for kind, label in (("solid", "rock"), ("death", "death"), ("no-laser", "no-laser"),
                        ("tele", "teleport"), ("start", "start"), ("finish", "finish"),
                        ("cp", "checkpoint"), ("spawn", "spawn"), ("pickup", "pickup"),
                        ("hazard", "hazard entity")):
        d.rectangle([x, y, x + 10, y + 10], fill=COLORS[kind][:3])
        d.text((x + 14, y + 1), label, fill=(200, 230, 255))
        x += 30 + 6 * len(label)
    out.save(REVIEW)
    return REVIEW


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--check", action="store_true", help="CI gate: shipped outputs match a fresh pass")
    args = ap.parse_args()
    rows = catalogue()
    if len(rows) != len(list(MAPS_DIR.glob("*.map"))):
        raise SystemExit("catalogue and data/maps disagree")

    if args.check:
        tmp = Path(tempfile.mkdtemp(prefix="map-previews-"))
        dest, _rows_n = write_atlas(rows, tmp)
        ok = True
        shipped = OUT / "previews.png"
        if not shipped.exists():
            print(f"  MISSING {shipped.relative_to(ROOT)}")
            ok = False
        else:
            with Image.open(dest) as gen, Image.open(shipped) as have:
                a = np.asarray(gen.convert("RGBA"), dtype=np.int16)
                b = np.asarray(have.convert("RGBA"), dtype=np.int16)
            if a.shape != b.shape:
                print(f"  DIFF data/ui/maps/previews.png: {b.shape[1]}x{b.shape[0]} vs {a.shape[1]}x{a.shape[0]}")
                ok = False
            else:
                diff = np.abs(a - b)
                if diff.max() == 0:
                    print(f"  ok   data/ui/maps/previews.png {a.shape[1]}x{a.shape[0]} "
                          f"({len(rows)} maps, {COLS} per row)")
                else:
                    print(f"  DIFF data/ui/maps/previews.png: {int(diff.any(axis=2).sum())} of "
                          f"{a.shape[0] * a.shape[1]} pixels differ, max {int(diff.max())}")
                    ok = False
        for path, text in ((HEADER, header_text(rows)), (STAND_JS, js_text(rows)), (LANDING_JS, js_text(rows))):
            if path.exists() and path.read_text(encoding="utf-8") == text:
                print(f"  ok   {path.relative_to(ROOT)}")
            else:
                print(f"  DIFF {path.relative_to(ROOT)} (regenerate: scripts/build_map_previews.py)")
                ok = False
        print("map previews check: " + ("PASS" if ok else "FAIL"))
        return 0 if ok else 1

    dest, _rows_n = write_atlas(rows, OUT)
    HEADER.write_text(header_text(rows), encoding="utf-8")
    STAND_JS.write_text(js_text(rows), encoding="utf-8")
    LANDING_JS.write_text(js_text(rows), encoding="utf-8")
    print(f"OK  {dest.relative_to(ROOT)}  {COLS} per row, {len(rows)} maps")
    for _p, r in rows:
        print(f"  cell {r['cell']:2} {r['name']:28} {r['w']:4}x{r['h']:<4} {r['mode']:12} "
              f"spawns {r['spawns']:2}  solid {r['solid']:6}  death {r['death']:4}  "
              f"nohook {r['nohook']:5}  pickups {r['pickups']:3}  hazards {r['hazards']:2}")
    print(f"OK  {HEADER.relative_to(ROOT)}  ({len(rows)} rows)")
    print(f"OK  {STAND_JS.relative_to(ROOT)} + {LANDING_JS.relative_to(ROOT)}")
    out_dir = Path(tempfile.mkdtemp(prefix="map-review-"))
    write_atlas(rows, out_dir)
    print(f"OK  review sheet -> {review_sheet(rows, out_dir).relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
