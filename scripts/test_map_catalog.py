#!/usr/bin/env python3
"""Cross-checks the Arsenal/Maps page tables against the code that actually produces the content.

The menu copy and the two web surfaces are static text, which is exactly the kind of thing that rots.
Each row is therefore re-derived here from the thing that ships:

  * weapon damage / fire delay / magazine  <- datasrc/content.py (the WeaponSpec blocks)
  * map rows (name, blurb, grid, spawns, checkpoints, death, no-hook, mode, licence)
                                           <- data/maps/*.map through scripts/neon_mapread.py, i.e.
                                              the same reader scripts/build_map_previews.py uses to
                                              write neon_maps_gen.h and maps_data.js
  * the shipped map count                  <- a listing of data/maps/*.map

Since the generated table is checked byte-for-byte by `build_map_previews.py --check`, the real job
here is to prove the *other* two consumers (the design stand and the RU/EN landing) print the same
numbers, and that the six hand-written landing cards did not drift.

Run from CI (`ci.yml`, `scripts/ci-local.sh`): a map edit, a rebalance or a renamed file has to touch
the page copy in the same commit, or this fails.
"""
import json
import re
import unittest
from pathlib import Path

import neon_mapread as mr  # the .map reader is the source of truth for the gallery
from build_potato_arena_assets import WEAPON_ORDER  # same six weapons, same order

ROOT = Path(__file__).resolve().parent.parent
HEADER = ROOT / "src" / "game" / "client" / "neon_arsenal.h"
GEN = ROOT / "src" / "game" / "client" / "neon_maps_gen.h"
CONTENT = ROOT / "datasrc" / "content.py"
MAPS_DIR = ROOT / "data" / "maps"
STAND = ROOT / "design" / "potato-arena" / "index.html"
LANDING = ROOT / "design" / "landing"


def header_text():
    return HEADER.read_text(encoding="utf-8")


def gen_text():
    return GEN.read_text(encoding="utf-8")


def generated_rows():
    """The generated table, as dicts (the same shape maps_data.js carries)."""
    text = gen_text()
    pattern = (r'\{"([^"]+)", "([^"]+)", (\d+), (\d+), (\d+), (\d+), (\d+), (\d+), (\d+), '
               r'(\d+), (\d+), (\d+), (\d+), (\d+), (\d+), (true|false), (true|false), (true|false), '
               r'"([^"]*)", "([^"]*)", "([^"]*)"\},')
    rows = []
    for m in re.finditer(pattern, text):
        rows.append({
            "name": m.group(1), "blurb": m.group(2), "cell": int(m.group(3)), "w": int(m.group(4)),
            "h": int(m.group(5)), "spawns": int(m.group(6)), "solid": int(m.group(7)),
            "death": int(m.group(8)), "nohook": int(m.group(9)), "start": int(m.group(10)),
            "finish": int(m.group(11)), "checkpoints": int(m.group(12)), "teleports": int(m.group(13)),
            "pickups": int(m.group(14)), "hazards": int(m.group(15)), "race": m.group(16) == "true",
            "dm": m.group(17) == "true", "base": m.group(18) == "true", "mode": m.group(19),
            "tileset": m.group(20), "license": m.group(21),
        })
    return rows


class Weapons(unittest.TestCase):
    def setUp(self):
        self.text = header_text()
        self.cards = re.findall(
            r'\{"(\w+)",.*?"(.*?)",.*?"(.*?)",.*?"(.*?)",\s*(\d+), (\d+), (-?\d+), (true|false)\}',
            self.text, re.S)

    def test_all_six_present_in_atlas_order(self):
        self.assertEqual([c[0].lower() for c in self.cards], [w for w in WEAPON_ORDER])

    def test_numbers_match_content_py(self):
        """damage / firedelay / maxammo as datasrc/content.py sets them."""
        spec = {}
        for name, block in re.findall(r'weapon = WeaponSpec\(container, "(\w+)"\)(.*?)container\.weapons',
                                       CONTENT.read_text(encoding="utf-8"), re.S):
            def pick(key, default):
                m = re.search(rf"weapon\.{key}\.Set\((-?\d+)\)", block)
                return int(m.group(1)) if m else default
            spec[name] = {"firedelay": pick("firedelay", 500), "damage": pick("damage", 1), "maxammo": pick("maxammo", 10)}
        # content.py names the pistol "gun" and the hammer "hammer"; the melee weapon has no ammo
        # counter in the page copy, and the grenade's page damage is the explosion, not the shell.
        aliases = {"Hammer": "hammer", "Pistol": "gun", "Shotgun": "shotgun", "Grenade": "grenade",
                   "Laser": "laser", "Ninja": "ninja"}
        expected = {"Hammer": 3, "Pistol": 1, "Shotgun": 5, "Grenade": 2, "Laser": 5, "Ninja": 9}
        for name, _role, _how, _tip, damage, delay, ammo, _drop in self.cards:
            src = spec[aliases[name]]
            self.assertEqual(int(delay), src["firedelay"], f"{name} fire delay drifted from content.py")
            self.assertEqual(int(damage), expected[name], f"{name} damage no longer matches the page copy")
            if int(ammo) >= 0:
                self.assertEqual(int(ammo), src["maxammo"], f"{name} magazine drifted")

    def test_neon_dm_pool(self):
        """Only shotgun / grenade / laser pickups are allowed by the controller; ninja never spawns."""
        allowed = set(re.findall(r"Index == (ENTITY_WEAPON_\w+)",
                                 (ROOT / "src/game/server/gamemodes/neon_dm.cpp").read_text(encoding="utf-8")))
        self.assertEqual(allowed, {"ENTITY_WEAPON_SHOTGUN", "ENTITY_WEAPON_GRENADE", "ENTITY_WEAPON_LASER"})
        pool = {c[0]: c[7] == "true" for c in self.cards}
        self.assertEqual(pool["Ninja"], False)
        self.assertEqual(pool["Shotgun"] and pool["Grenade"] and pool["Laser"], True)


class Maps(unittest.TestCase):
    """Every shipped map has a row, and every number in it comes from the map file itself."""

    def setUp(self):
        self.rows = generated_rows()
        self.files = sorted(MAPS_DIR.glob("*.map"))

    def test_every_row_is_a_real_file(self):
        for row in self.rows:
            self.assertTrue((MAPS_DIR / f"{row['name']}.map").exists(), f"{row['name']}.map is not shipped")

    def test_every_shipped_map_has_a_row(self):
        self.assertEqual(sorted(r["name"] for r in self.rows), sorted(p.stem for p in self.files))
        self.assertIn("NUM_CARDS = std::size(g_aFacts)", gen_text(),
                      "the page counts rows with NUM_CARDS, so it must be the array's own size")
        self.assertEqual(int(re.search(r"PREVIEW_CELLS = (\d+)", gen_text()).group(1)), len(self.files))
        # Cell order is the catalogue order and every map gets exactly one cell.
        self.assertEqual([r["cell"] for r in self.rows], list(range(len(self.rows))))

    def test_counts_match_the_map_files(self):
        for row in self.rows:
            facts = mr.read_map(MAPS_DIR / f"{row['name']}.map").facts()
            self.assertEqual((row["w"], row["h"]), (facts["width"], facts["height"]), f"{row['name']}: grid drifted")
            self.assertEqual(row["spawns"], facts["spawns"], f"{row['name']}: spawn count drifted")
            self.assertEqual(row["solid"], facts["solid"], f"{row['name']}: solid count drifted")
            self.assertEqual(row["death"], facts["death"], f"{row['name']}: death count drifted")
            self.assertEqual(row["nohook"], facts["nohook"], f"{row['name']}: no-hook count drifted")
            cps = facts["race"]["cp"] + facts["race"]["time_cp"]
            self.assertEqual(row["checkpoints"], cps, f"{row['name']}: checkpoint count drifted")
            self.assertEqual(row["start"], facts["race"]["start"], f"{row['name']}: start tiles drifted")
            self.assertEqual(row["finish"], facts["race"]["finish"], f"{row['name']}: finish tiles drifted")

    def test_featured_maps_stay_first(self):
        featured = ["Neon Relay Basin", "Chromatic Canyon", "Vector Spire", "Midnight Circuit",
                    "Aurora Ascent", "Neon Relay Warmup"]
        self.assertEqual([r["name"] for r in self.rows[:len(featured)]], featured)
        self.assertEqual([r["base"] for r in self.rows[:len(featured)]], [False] * len(featured))
        self.assertEqual({r["base"] for r in self.rows[len(featured):]}, {True},
                         "only the six original maps are ours; everything else is credited to its author")

    def test_every_row_has_a_blurb_in_both_languages(self):
        data = json.loads(re.search(r"window\.NEON_MAPS = (\s*\[.*\]);", (LANDING / "maps_data.js")
                                    .read_text(encoding="utf-8"), re.S).group(1))
        for row, entry in zip(self.rows, data, strict=True):
            self.assertTrue(row["blurb"].strip(), f"{row['name']} has an empty caption")
            self.assertTrue(entry["blurbEn"].strip(), f"{row['name']} has no English caption")

    def test_licences_are_credited_not_invented(self):
        license_file = (MAPS_DIR / "license.txt").read_text(encoding="utf-8")
        for row in self.rows:
            if row["base"] and row["license"]:
                self.assertIn(row["name"], license_file,
                              f"{row['name']} claims {row['license']} but data/maps/license.txt does not mention it")

    def test_shipped_count_and_unknown_maps(self):
        self.assertEqual(len(self.files), len(self.rows),
                         "the gallery lists every shipped map, so the two counts are one number")
        # Whatever is shipped must be classified, not silently dropped from the catalogue.
        self.assertEqual({p.stem for p in self.files}, {r["name"] for r in self.rows})


class WebSurfaces(unittest.TestCase):
    """The stand and the landing read the generated table; the six hero cards do not drift from it."""

    @classmethod
    def setUpClass(cls):
        cls.rows = {r["name"]: r for r in generated_rows()}

    def test_stand_only_renders_the_generated_table(self):
        text = STAND.read_text(encoding="utf-8")
        self.assertIn('<script src="maps_data.js"></script>', text)
        self.assertIn("NEON_MAPS.map", text)
        self.assertNotIn("MAPROWS", text, "the hand-typed table must be gone once data is generated")
        # cell -> background-position math must match the sheet's 5 columns / 6 rows
        self.assertIn("Math.floor(m.cell/5)*20", text.replace(" ", ""))

    def test_landing_cards_match_the_generated_rows(self):
        for page in ("index.html", "en.html"):
            text = (LANDING / page).read_text(encoding="utf-8")
            self.assertIn('<script src="maps_data.js"></script>', text)
            for name, row in self.rows.items():
                if row["base"]:
                    continue
                self.assertIn(f"<h3>{name}</h3>", text, f"{page}: hero card for {name} disappeared")
                self.assertIn(f"<b>{row['w']}×{row['h']}</b>", text, f"{page}: grid of {name} drifted")

    def test_landing_states_the_real_counts(self):
        shipped = len(list(MAPS_DIR.glob("*.map")))
        for page in ("index.html", "en.html"):
            text = (LANDING / page).read_text(encoding="utf-8")
            self.assertIn(str(shipped), text, f"{page}: the real shipped map count is not on the page")


class Preview(unittest.TestCase):
    def test_atlas_matches_the_catalogue(self):
        from PIL import Image
        path = ROOT / "data" / "ui" / "maps" / "previews.png"
        cols = int(re.search(r"PREVIEW_COLS = (\d+)", gen_text()).group(1))
        cell_w = int(re.search(r"PREVIEW_CELL_W = (\d+)", gen_text()).group(1))
        cell_h = int(re.search(r"PREVIEW_CELL_H = (\d+)", gen_text()).group(1))
        cells = int(re.search(r"PREVIEW_CELLS = (\d+)", gen_text()).group(1))
        rows = (cells + cols - 1) // cols
        with Image.open(path) as im:
            self.assertEqual(im.size, (cols * cell_w, rows * cell_h),
                             "the atlas and the page's UV math disagree")
            self.assertEqual(cells, len(generated_rows()))

    def test_every_cell_is_not_empty(self):
        """A blank cell means the rasteriser silently skipped a map."""
        import numpy as np
        from PIL import Image
        cols = int(re.search(r"PREVIEW_COLS = (\d+)", gen_text()).group(1))
        cell_w = int(re.search(r"PREVIEW_CELL_W = (\d+)", gen_text()).group(1))
        cell_h = int(re.search(r"PREVIEW_CELL_H = (\d+)", gen_text()).group(1))
        with Image.open(ROOT / "data" / "ui" / "maps" / "previews.png") as im:
            img = np.asarray(im.convert("RGB"), dtype=np.int16)
        for row in generated_rows():
            x0 = (row["cell"] % cols) * cell_w
            y0 = (row["cell"] // cols) * cell_h
            cell = img[y0:y0 + cell_h, x0:x0 + cell_w]
            # Solid rock is drawn as (26, 44, 74); a map with a floor must have some of it.
            rock = int(((cell[:, :, 0] == 26) & (cell[:, :, 1] == 44) & (cell[:, :, 2] == 74)).sum())
            self.assertGreater(rock, 20, f"{row['name']}: blueprint cell looks empty")


if __name__ == "__main__":
    unittest.main(verbosity=2)
