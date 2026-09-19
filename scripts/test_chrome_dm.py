#!/usr/bin/env python3
"""Structural checks only; does not assert native PvP or visual correctness."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

import numpy as np
import twmap
from build_chrome_dm import SOURCE, SOURCE_SHA, audit, build


class ChromeDmTest(unittest.TestCase):
    def test_source_selection(self):
        candidates=[audit(p) for p in SOURCE.parent.glob('dm*.map')]
        largest=max(candidates,key=lambda x:x['cells'])
        self.assertEqual(largest['file'],'dm7.map')
        self.assertEqual(largest['entities']['spawn'],9)
        self.assertEqual((largest['width'],largest['height']),(146,120))

    def test_build_preserves_collision_and_entities(self):
        original=twmap.Map(str(SOURCE)).game_layer().tiles
        with tempfile.TemporaryDirectory() as tmp:
            path=build(Path(tmp));data=path.read_bytes()
            m=twmap.Map(str(path));actual=m.game_layer().tiles
            self.assertTrue(np.array_equal(original[:,:,0],actual[:,:,0]))
            occupied=original[:,:,0]!=0
            self.assertTrue(np.array_equal(original[:,:,1][occupied],actual[:,:,1][occupied]))
            report=json.loads((Path(tmp)/'report.json').read_text())
            self.assertEqual(report['empty_tile_flags_normalized'],1)
            self.assertFalse(report['raw_game_bytes_identical'])
            self.assertFalse(report['release_enabled'])
            self.assertTrue(report['license_verified'])
            self.assertEqual(m.info.license,'CC-BY-SA 3.0')
            self.assertEqual([i.name for i in m.images],['chrome','pastel','ring'])
            self.assertEqual(len(m.envelopes),2)
            self.assertEqual(build(Path(tmp)).read_bytes(),data)
        self.assertEqual(hashlib.sha256(SOURCE.read_bytes()).hexdigest(),SOURCE_SHA)


if __name__=='__main__':
    unittest.main()
