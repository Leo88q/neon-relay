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
            if name == 'cool_guy_1':
                cells = [(192, 0, 224, 32), (224, 0, 256, 32), (192, 32, 256, 64), (192, 64, 256, 96)]
                cells += [(64+i*32, 96, 96+i*32, 128) for i in range(6)]
                for cell in cells:
                    self.assertIsNotNone(im.crop(cell).getchannel('A').getbbox())
                eyes = [im.crop(cell).tobytes() for cell in cells[4:]]
                self.assertEqual(len(set(eyes)), 6)
                border = np.array(im.crop((96, 0, 192, 96)))
                visible = border[..., 3] > 128
                self.assertTrue((border[visible, :3] < 100).all())
                self.assertFalse(a[96:, :64].any())
                continue
            self.assertFalse(a[96:].any())
            self.assertFalse(a[:96, 192:].any())

    def test_approved_prototype_motion_geometry(self):
        # User approved motion at this revision; detail work must not move limbs
        # or alter the body silhouette. Left eye art is mirrored for the right.
        original = subprocess.check_output(['git', 'show', '237da76:data/skins/potato_cool_guy_1.png'], cwd=ROOT)
        old = np.array(Image.open(io.BytesIO(original)).convert('RGBA'))
        new = np.array(Image.open(ROOT / 'data/skins/potato_cool_guy_1.png'))
        self.assertTrue(np.array_equal(old[:96, 192:], new[:96, 192:]))
        self.assertTrue(np.array_equal(old[:96, :192, 3], new[:96, :192, 3]))
        for i in range(6):
            x = 64 + i*32
            def center(image):
                a = image[96:128, x:x+32, 3].astype(float)
                return (a * np.arange(32)[None, :]).sum() / a.sum()
            self.assertAlmostEqual(center(new) - center(old), -1.5, delta=0.05)

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
