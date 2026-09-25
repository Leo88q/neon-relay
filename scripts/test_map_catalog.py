#!/usr/bin/env python3
"""Cross-checks the Arsenal/Maps page tables against the code that actually produces the content.

The menu copy is static text in a header, which is exactly the kind of thing that rots. Each row of
`src/game/client/neon_arsenal.h` is therefore re-derived here:

  * weapon damage / fire delay / magazine  <- datasrc/content.py (the WeaponSpec blocks)
  * map name / blurb / grid / entity counts <- scripts/build_neon_maps.py (the builders themselves)
  * the shipped map count                  <- a listing of data/maps/*.map

Run from CI (`ci.yml`, `scripts/ci-local.sh`): a map edit, a rebalance or a renamed file has to
touch the page copy in the same commit, or this fails.
"""
import re
import unittest
from pathlib import Path

import build_neon_maps as maps  # the map builders are the source of truth for the gallery
from build_potato_arena_assets import WEAPON_ORDER  # same six weapons, same order

ROOT = Path(__file__).resolve().parent.parent
HEADER = ROOT / "src" / "game" / "client" / "neon_arsenal.h"
CONTENT = ROOT / "datasrc" / "content.py"


def header_text():
    return HEADER.read_text(encoding="utf-8")


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
    def setUp(self):
        self.rows = re.findall(r'\{"([^"]+)", "([^"]+)", (-?\d+), (\d+), (\d+), (\d+), (\d+), (\d+), (\d+)\}',
                               header_text())

    def test_every_row_is_a_real_file(self):
        for name, _blurb, *_rest in self.rows:
            self.assertTrue((ROOT / "data" / "maps" / f"{name}.map").exists(), f"{name}.map is not shipped")

    def test_blurb_grid_and_counts_match_the_builders(self):
        # Atlas cell order == build_neon_maps.MAPS order, not alphabetical order.
        builders = [(name, build) for name, build, _blurb in maps.MAPS]
        self.assertEqual(len(self.rows), len(builders) + 1, "the gallery is the generated maps plus Warmup")
        for cell, (name, build) in enumerate(builders):
            row = next(r for r in self.rows if r[0] == name)
            grid, _decor = build()
            stats = {}
            for y in range(grid.h):
                for x in range(grid.w):
                    v = grid.g[y][x]
                    stats[v] = stats.get(v, 0) + 1
            # The page copy is a Russian translation of the generator's English blurb, so only
            # the identity of the row is checked here; the numbers below are the load-bearing part.
            self.assertTrue(row[1].strip(), f"{name} has an empty caption")
            self.assertEqual((int(row[3]), int(row[4])), (grid.w, grid.h), f"{name} grid size drifted")
            self.assertEqual(int(row[2]), cell, f"{name} must be preview cell {cell} (atlas order = MAPS order)")
            self.assertEqual(int(row[5]), stats.get(maps.ENTITY_SPAWN, 0), f"{name} spawn count drifted")
            self.assertEqual(int(row[6]), stats.get(maps.T_CP, 0), f"{name} checkpoint count drifted")
            self.assertEqual(int(row[7]), stats.get(maps.T_DEATH, 0), f"{name} death-tile count drifted")
            self.assertEqual(int(row[8]), stats.get(maps.T_NOHOOK, 0), f"{name} no-hook count drifted")

    def test_shipped_count_and_unknown_maps(self):
        shipped = len(list((ROOT / "data" / "maps").glob("*.map")))
        self.assertEqual(shipped, int(re.search(r"NUM_SHIPPED_MAPS = (\d+)", header_text()).group(1)))
        listed = {r[0] for r in self.rows}
        stock = [p.stem for p in (ROOT / "data" / "maps").glob("*.map") if p.stem not in listed]
        # Everything not in the gallery must be a DDNet map we deliberately do not redescribe.
        pattern = re.compile(r"^(dm\d+|ctf\d+|Tutorial|LearnToPlay.*|coverage|Gold Mine|Sunny Side Up|Tsunami)$")
        bad = [name for name in stock if not pattern.match(name)]
        self.assertEqual(bad, [], f"unclassified map(s) shipped: {bad}")


class Preview(unittest.TestCase):
    def test_atlas_matches_the_gallery(self):
        from PIL import Image
        path = ROOT / "data" / "ui" / "maps" / "previews.png"
        with Image.open(path) as im:
            cells = int(re.search(r"PREVIEW_CELLS = (\d+)", header_text()).group(1))
            w = int(re.search(r"PREVIEW_CELL_W = (\d+)", header_text()).group(1))
            h = int(re.search(r"PREVIEW_CELL_H = (\d+)", header_text()).group(1))
            self.assertEqual(im.size, (cells * w, h), "the atlas and the page's UV math disagree")
            rows = re.findall(r'\{"([^"]+)", "([^"]+)", (\d+),', header_text())
            self.assertEqual(sum(1 for _r in rows if int(_r[2]) >= 0), cells,
                             "every blueprinted row must have exactly one cell")


if __name__ == "__main__":
    unittest.main(verbosity=2)
