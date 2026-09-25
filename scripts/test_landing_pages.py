#!/usr/bin/env python3
"""Landing page hygiene: no broken links, no remote assets, and the copy agrees with the code.

The landing is HTML, so no compiler protects it: a renamed file becomes a 404 on someone's screen, and a
number that drifted out of `neon_arsenal.h` becomes a promise the game does not keep. Both are cheap to
catch here.
"""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LANDING = ROOT / "design" / "landing"
FILES = ["index.html", "en.html"]
HEADER = (ROOT / "src" / "game" / "client" / "neon_arsenal.h").read_text(encoding="utf-8")

RESOURCES = re.compile(r'(?:src|href)="([^"]+)"|url\("([^"]+)"\)')


def read(name):
    return (LANDING / name).read_text(encoding="utf-8")


class Links(unittest.TestCase):
    def test_local_targets_exist(self):
        for name in FILES:
            text, base = read(name), LANDING
            for html, css in RESOURCES.findall(text):
                target = html or css
                if target.startswith(("http://", "https://", "#", "mailto:")):
                    continue
                path = (base / target.split("#")[0]).resolve()
                self.assertTrue(path.exists(), f"{name}: broken local reference {target}")

    def test_no_remote_assets(self):
        """A landing that phones home is a different product; here everything must come from the repo."""
        for name in FILES:
            for html, css in RESOURCES.findall(read(name)):
                target = html or css
                if target.startswith(("http://", "https://")):
                    self.assertIn(target, {"https://github.com/Leo88q/neon-relay"},
                                  f"{name}: only the repository link may be remote, found {target}")

    def test_language_switch_is_a_pair(self):
        ru, en = read("index.html"), read("en.html")
        self.assertIn('hreflang="en"', ru)
        self.assertIn('hreflang="ru"', en)
        for text in (ru, en):
            self.assertEqual(sorted(re.findall(r'id="(\w+)"', text)), sorted(re.findall(r'id="(\w+)"', read(FILES[0]))))

    def test_css_is_shared(self):
        for name in FILES:
            self.assertIn('href="landing.css"', read(name))
            self.assertEqual(read(name).count('<style'), 0, "no page-local styles: the language twins must match")


class Numbers(unittest.TestCase):
    def test_weapon_copy_matches_the_header_table(self):
        cards = re.findall(r'\{"(\w+)",.*?(\d+), (\d+), (-?\d+), (true|false)\}', HEADER, re.S)
        self.assertEqual(len(cards), 6)
        for name, damage, _delay, _ammo, _drop in cards:
            for label in (f"урон<b>{damage}</b>", f"damage<b>{damage}</b>"):
                hits = sum(1 for f in FILES if label in read(f))
                if label.startswith("урон"):
                    self.assertEqual(hits, 1, f"{name}: RU landing must state damage {damage} once")
                else:
                    self.assertEqual(hits, 1, f"{name}: EN landing must state damage {damage} once")

    def test_map_grids_match_the_header_table(self):
        rows = re.findall(r'\{"([^"]+)", "([^"]+)", (-?\d+), (\d+), (\d+),', HEADER)
        for _name, _blurb, cell, w, h in rows:
            if int(cell) < 0:
                continue  # warmup has no blueprint and no numbers, by design
            pair = f"{w}×{h}"
            for f in FILES:
                self.assertIn(pair, read(f), f"{f}: landing lost the grid size {pair}")

    def test_shipped_map_count_matches(self):
        shipped = len(list((ROOT / "data" / "maps").glob("*.map")))
        ours = len([r for r in re.findall(r'\{"([^"]+)", "([^"]+)", (-?\d+),', HEADER) if int(r[2]) >= 0]) + 1
        for f in FILES:
            text = read(f)
            self.assertIn(f"<b>{shipped}</b>", text, f"{f}: the landing must state the real map count")
            self.assertIn(str(shipped - ours), text, f"{f}: the count of stock maps is not on the page")


class Honesty(unittest.TestCase):
    """Repo rule: local-only progression, no payout promises, no money-moving button as a fact."""

    # Affirmative promises only: the page is allowed (and required) to *negate* these, so the words
    # are matched with the shapes a copywriter would actually use to promise them.
    FORBIDDEN = ["earn money", "earn real", "you will earn", "you'll earn", "per fight payout",
                 "будешь зарабатывать", "зарабатывай реальные", "гарантированны", "вывести средств",
                 "выплаты за"]

    def test_no_earning_language(self):
        for f in FILES:
            low = read(f).lower()
            for word in self.FORBIDDEN:
                self.assertNotIn(word.lower(), low, f"{f}: marketing copy must not promise {word}")

    def test_progress_is_labelled_local(self):
        self.assertIn("локальный", read("index.html").lower())
        self.assertIn("local", read("en.html").lower())


if __name__ == "__main__":
    unittest.main(verbosity=2)
