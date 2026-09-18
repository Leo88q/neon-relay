#!/usr/bin/env python3
"""Offline atlas safety and deterministic rebuild checks (not gameplay tests)."""
import hashlib
import io
from pathlib import Path
import subprocess
import sys
import unittest

import numpy as np
from PIL import Image
from build_potato_skins import POTATOES
from build_potato_weapon_sheet import RECTS

ROOT = Path(__file__).resolve().parent.parent

class Assets(unittest.TestCase):
    def test_skins(self):
        for name in POTATOES:
            im = Image.open(ROOT / f'data/skins/potato_{name}.png')
            self.assertEqual((im.size, im.mode), ((256, 128), 'RGBA'))
            a = np.array(im.getchannel('A'))
            box = im.crop((0, 0, 96, 96)).getchannel('A').getbbox()
            self.assertIsNotNone(box)
            self.assertLessEqual(box[2] - box[0], 80)
            self.assertLessEqual(box[3] - box[1], 80)
            self.assertTrue(a[:96, 96:192].any())
            self.assertFalse(a[96:].any())
            self.assertFalse(a[:96, 192:].any())

    def test_atlas_outside_rects_unchanged(self):
        original = subprocess.check_output(['git', 'show', 'aef3363:data/game.png'], cwd=ROOT)
        a = np.array(Image.open(io.BytesIO(original)).convert('RGBA'))
        im = Image.open(ROOT / 'data/game.png')
        self.assertEqual((im.size, im.mode), ((1024, 512), 'RGBA'))
        b = np.array(im)
        mask = np.zeros(a.shape[:2], dtype=bool)
        for x, y, w, h in RECTS.values():
            mask[y:y+h, x:x+w] = True
            self.assertTrue(b[y:y+h, x:x+w, 3].any())
        self.assertTrue(np.array_equal(a[~mask], b[~mask]))

    def test_rebuild_idempotent(self):
        paths = list((ROOT / 'assets-src/potato').rglob('*.png'))
        paths += list((ROOT / 'assets-src/weapons').rglob('*.png'))
        paths += list((ROOT / 'data/skins').glob('potato_*.png'))
        paths += [ROOT / 'data/game.png', ROOT / 'src/game/client/potato_catalog.h']
        def hashes():
            return {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}
        before = hashes()
        for script in ['build_potato_skins.py', 'build_potato_weapon_sheet.py', 'gen_potato_catalog.py']:
            subprocess.run([sys.executable, str(ROOT / 'scripts' / script)], check=True, stdout=subprocess.DEVNULL)
        self.assertEqual(before, hashes())

if __name__ == '__main__':
    unittest.main()
