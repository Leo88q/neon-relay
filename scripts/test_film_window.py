#!/usr/bin/env python3
"""Parity gate for the «Кадр плёнки» window chrome (docs/FILM_WINDOW_RU.md).

The window language exists twice on purpose: the client draws it in code
(`src/game/client/neon_window.cpp` from the `FILM_*` tokens of
`src/game/client/neon_style.h`) and the site mirrors it in CSS (the
`--film-*` custom properties of `design/potato-arena/index.html`). If either
side drifts, the game and the site stop looking like one product — exactly the
rot this repository gates everywhere else. This test therefore checks:

  * every `FILM_*` geometry token has a `--film-*` mirror with the same number;
  * the client really renders through the film chrome (popups and plates);
  * the rounded-glass popup plates this chrome replaced are gone;
  * the stand still carries the showcase and the spec document exists.

Run from CI (`ci.yml`, `scripts/ci-local.sh`): a token edit on one side
without the other fails here.
"""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STYLE = ROOT / "src" / "game" / "client" / "neon_style.h"
NEON_WINDOW = ROOT / "src" / "game" / "client" / "neon_window.cpp"
MENUS = ROOT / "src" / "game" / "client" / "components" / "menus.cpp"
UI_POPUPS = ROOT / "src" / "game" / "client" / "ui_popups.cpp"
STAND = ROOT / "design" / "potato-arena" / "index.html"
SPEC = ROOT / "docs" / "FILM_WINDOW_RU.md"

# C++ token -> CSS custom property. Adding a geometry token means adding both
# columns, or the gate refuses to pass.
TOKENS = {
    "FILM_SPROCKET_W": "--film-sprocket",
    "FILM_HOLE_W": "--film-hole-w",
    "FILM_HOLE_H": "--film-hole-h",
    "FILM_HOLE_STEP": "--film-hole-step",
    "FILM_HEADER_H": "--film-header",
    "FILM_MARK_R": "--film-mark-r",
    "FILM_EDGE_CODE": "--film-edge",
}


class Tokens(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cpp = {m.group(1): float(m.group(2)) for m in re.finditer(
            r"inline constexpr float (FILM_[A-Z_]+) = ([0-9.]+)f;", STYLE.read_text(encoding="utf-8"))}
        cls.css = {m.group(1): float(m.group(2)) for m in re.finditer(
            r"(--film-[a-z-]+):\s*([0-9.]+)px", STAND.read_text(encoding="utf-8"))}

    def test_every_token_has_a_mirror(self):
        for token, prop in TOKENS.items():
            self.assertIn(token, self.cpp, f"{token} disappeared from neon_style.h")
            self.assertIn(prop, self.css, f"{prop} disappeared from the stand's :root")

    def test_numbers_match(self):
        for token, prop in TOKENS.items():
            if token in self.cpp and prop in self.css:
                self.assertEqual(self.cpp[token], self.css[prop],
                                 f"{token}={self.cpp[token]} but the site says {prop}={self.css[prop]}: "
                                 "edit both sides together")

    def test_no_orphan_tokens(self):
        # FILM_ADVANCE_SECONDS is motion, not geometry: the site animates with
        # its own timing, so it is deliberately not mirrored — everything else
        # must be, otherwise a token was added without a mirror.
        mirrored = set(TOKENS)
        for token in self.cpp:
            self.assertIn(token, mirrored | {"FILM_ADVANCE_SECONDS"},
                          f"new token {token} has no entry in TOKENS and no --film-* mirror")


class ClientChrome(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.menus = MENUS.read_text(encoding="utf-8")
        cls.popups = UI_POPUPS.read_text(encoding="utf-8")
        cls.window = NEON_WINDOW.read_text(encoding="utf-8")

    def test_menu_popups_go_through_the_film_frame(self):
        self.assertIn("NeonWindow::DrawFilmFrame", self.menus,
                      "menu popups must be drawn through the film-frame chrome")
        self.assertGreaterEqual(self.menus.count("NeonWindow::DrawFilmFrame"), 4,
                                "fullscreen popups, connecting and loading plates all use the chrome")

    def test_engine_popups_go_through_the_film_cell(self):
        self.assertIn("NeonWindow::DrawFilmPlate", self.popups,
                      "engine popups must be drawn through the film-cell chrome")

    def test_rounded_glass_plates_are_gone(self):
        self.assertNotIn("Box.Draw(BgColor", self.menus,
                         "the rounded popup plate this chrome replaced must stay gone")
        self.assertNotIn("m_Props.m_BorderColor, PopupMenu.m_Props.m_Corners, 3.0f", self.popups,
                         "the rounded engine popup plate this chrome replaced must stay gone")

    def test_counter_is_code_drawn(self):
        # The frame counter is a 3x5 pixel glyph set, not a font: the chrome
        # must stay independent of the text renderer.
        self.assertIn("GlyphRows", self.window)
        self.assertNotIn("TextRender", self.window, "window chrome must not depend on the font engine")


class SiteChrome(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.stand = STAND.read_text(encoding="utf-8")

    def test_showcase_present(self):
        self.assertIn(".filmwin{", self.stand, "the film-window component is missing from the stand")
        self.assertIn("filmwin-counter", self.stand)
        self.assertIn("FRM", self.stand, "the showcase must show the frame counter")
        self.assertIn("Кадры плёнки", self.stand, "the showcase tab is missing")

    def test_spec_exists(self):
        self.assertTrue(SPEC.is_file(), "docs/FILM_WINDOW_RU.md is the spec; it must exist")


if __name__ == "__main__":
    unittest.main()
