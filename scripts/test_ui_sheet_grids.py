#!/usr/bin/env python3
"""Sprite-grid contract test for the procedural UI sheets.

Why this exists: the engine selects a sprite as `x / Gridx .. (x + w) / Gridx`, so a sprite rect
is expressed in *cells* of the SpriteSet grid, not in pixels. When stage 16 replaced the upstream
sheets with 32px/128px artwork, `datasrc/content.py` kept the old grid and the old rects — and a
16px mute button silently sampled a 128x64 region: a collage of four icons. Nothing else noticed,
because the asset pipelines only check that the image is divisible by the grid.

This test pins the whole chain: grid <-> cell pitch <-> named cells in the generator <-> the
rects in content.py <-> actual ink in the shipped PNG.
"""
import re
import unittest
from pathlib import Path

import numpy as np
from PIL import Image

from build_neon_ui_art import (
    EMOTE_CELL,
    EMOTE_CELLS,
    EMOTE_GRID,
    EMOTE_NAMES,
    GUI_ICON_CELLS,
    GUI_ICON_CELL,
    GUI_ICON_COLS,
    GUI_ICON_NAMES,
    GUI_ICON_ROWS,
)

ROOT = Path(__file__).resolve().parent.parent
CONTENT = ROOT / "datasrc" / "content.py"


def parse_spriteset(text):
    out = {}
    for m in re.finditer(r'SpriteSet\("(\w+)", image_(\w+), (\d+), (\d+)\)', text):
        out[m.group(1)] = {"image": m.group(2), "gridx": int(m.group(3)), "gridy": int(m.group(4))}
    return out


def parse_image(text, name):
    m = re.search(rf'image_{name} = Image\("[^"]+", "([^"]+)"\)', text)
    return m.group(1) if m else None


def parse_sprite(text, sprite_name):
    m = re.search(rf'Sprite\("{sprite_name}", set_(\w+), (-?\d+), (-?\d+), (\d+), (\d+)\)', text)
    if not m:
        return None
    return {"set": m.group(1), "x": int(m.group(2)), "y": int(m.group(3)), "w": int(m.group(4)), "h": int(m.group(5))}


def sprite_order(text, set_name, first):
    """The engine indexes a run of sprites contiguously from `first`, so the order matters."""
    names = re.findall(rf'Sprite\("(\w+)", set_{set_name}, ', text)
    return names[names.index(first):names.index(first) + len(EMOTE_NAMES)]


def cell_ink(path, col, row, cell):
    with Image.open(path) as im:
        a = np.asarray(im.convert("RGBA"))[row * cell:(row + 1) * cell, col * cell:(col + 1) * cell, 3]
    return int((a > 24).sum())


class GuiIcons(unittest.TestCase):
    def setUp(self):
        self.text = CONTENT.read_text(encoding="utf-8")
        self.sets = parse_spriteset(self.text)

    def test_grid_matches_the_drawn_pitch(self):
        s = self.sets["guiicons"]
        path = ROOT / "data" / parse_image(self.text, s["image"])
        with Image.open(path) as im:
            w, h = im.size
        self.assertEqual((s["gridx"], s["gridy"]), (GUI_ICON_COLS, GUI_ICON_ROWS))
        self.assertEqual((w // s["gridx"], h // s["gridy"]), (GUI_ICON_CELL, GUI_ICON_CELL),
                         "gui_icons cell size must equal the generator's 32px pitch")

    def test_engine_sprites_point_at_their_own_cell(self):
        mapping = {
            "guiicon_mute": "mute",
            "guiicon_emoticon_mute": "emoticon_mute",
            "guiicon_friend": "friend",
            # Drawn tinted by CChat::OnRender / CSpectator::RenderSpectatorList, so they must stay
            # single-cell and monochrome.
            "guiicon_heart": "heart",
            "guiicon_star": "star",
            "guiicon_dot_filled": "dot_filled",
            "guiicon_dot_empty": "dot_empty",
        }
        for sprite, icon in mapping.items():
            got = parse_sprite(self.text, sprite)
            want = GUI_ICON_CELLS[icon]
            self.assertIsNotNone(got, sprite + " missing from content.py")
            self.assertEqual((got["x"], got["y"]), want, f"{sprite} must select cell {want} = GUI_ICON_NAMES['{icon}']")
            self.assertEqual((got["w"], got["h"]), (1, 1),
                             f"{sprite} spans {got['w']}x{got['h']} cells: that is a collage, not an icon")

    def test_tintable_cells_are_white(self):
        """A tinted sprite multiplies its texel, so a pre-colored glyph would tint to mud."""
        with Image.open(ROOT / "data" / "gui_icons.png") as im:
            px = np.asarray(im.convert("RGBA"))
        for icon in ("heart", "star", "dot_filled", "dot_empty"):
            col, row = GUI_ICON_CELLS[icon]
            cell = px[row * GUI_ICON_CELL:(row + 1) * GUI_ICON_CELL, col * GUI_ICON_CELL:(col + 1) * GUI_ICON_CELL]
            solid = cell[cell[..., 3] > 200]
            self.assertGreater(len(solid), 0, f"{icon} has no opaque body to tint")
            self.assertTrue(np.all(solid[:, :3] > 200), f"{icon} is not monochrome white: {tuple(solid[:, :3].max(0))}")

    def test_named_cells_have_ink(self):
        path = ROOT / "data" / "gui_icons.png"
        for i, name in enumerate(GUI_ICON_NAMES):
            col, row = GUI_ICON_CELLS[name]
            self.assertGreater(cell_ink(path, col, row, GUI_ICON_CELL), 20, f"{name} cell is empty")


class Emoticons(unittest.TestCase):
    def setUp(self):
        self.text = CONTENT.read_text(encoding="utf-8")
        self.sets = parse_spriteset(self.text)

    def test_grid_matches_the_drawn_pitch(self):
        s = self.sets["emoticons"]
        path = ROOT / "data" / parse_image(self.text, s["image"])
        with Image.open(path) as im:
            w, h = im.size
        self.assertEqual((s["gridx"], s["gridy"]), (EMOTE_GRID, EMOTE_GRID))
        self.assertEqual(w // s["gridx"], EMOTE_CELL, "emoticons cell size must equal the 128px glyph pitch")
        self.assertEqual(h % s["gridy"], 0)
        self.assertEqual(w % s["gridx"], 0)  # what CheckImageDivisibility enforces at load time

    def test_sprites_are_one_cell_each_and_in_engine_order(self):
        # CGameClient::LoadEmoticonSkin() indexes SPRITE_OOP + i, so the run of names must be
        # exactly EMOTE_NAMES in order, each covering a single cell.
        self.assertEqual(sprite_order(self.text, "emoticons", "oop"), EMOTE_NAMES)
        for name in EMOTE_NAMES:
            got = parse_sprite(self.text, name)
            want = EMOTE_CELLS[name]
            self.assertEqual((got["x"], got["y"]), want, f"{name} must select cell {want}")
            self.assertEqual((got["w"], got["h"]), (1, 1), f"{name} must be one 128px cell")
            self.assertGreater(cell_ink(ROOT / "data" / "emoticons.png", got["x"], got["y"], EMOTE_CELL),
                               2000, f"{name} cell has almost no ink")


if __name__ == "__main__":
    unittest.main(verbosity=2)
