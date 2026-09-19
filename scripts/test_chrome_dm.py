#!/usr/bin/env python3
"""Structural checks for v3 atrium with freeze and all weapons."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from collections import deque

import numpy as np
from PIL import Image
import twmap
from build_chrome_dm import ROOT, SOURCE, SOURCE_SHA, audit, build
from chrome_dm_geometry import extend, front_layer, change_mask, NEW_SPAWNS_V2, NEW_SPAWNS_V3, FREEZE_ZONES
from build_dm_pickups import build as build_pickups

class ChromeDmTest(unittest.TestCase):
    def test_extension_and_original_region(self):
        old=twmap.Map(str(SOURCE)).game_layer().tiles
        new=extend(old)
        self.assertEqual(new.shape,(180,520,2))
        preserved=~change_mask()
        np.testing.assert_array_equal(old[:,:,0][preserved],new[:120,:146,0][preserved])
        for y,x in np.argwhere(old[:,:,0]>=192):
            self.assertEqual(old[y,x,0],new[y,x,0])
        self.assertGreaterEqual(np.count_nonzero(new[:,:,0]==192), 19+8)
        open_old=np.count_nonzero(~np.isin(old[:,:,0],[1,3]))
        self.assertGreater(np.count_nonzero(~np.isin(new[:,:,0],[1,3])), open_old*3)
        for x,y in NEW_SPAWNS_V2+NEW_SPAWNS_V3:
            if 0<x<520 and 0<y<180:
                # allow spawn on air with solid below within 4
                found=False
                for dy in range(5):
                    if y+dy<180 and new[y+dy,x,0]==1 and new[y,x,0]==192:
                        found=True; break
                self.assertTrue(found, (x,y))
        # front freeze
        front=front_layer()
        self.assertEqual(front.shape,(180,520,2))
        self.assertGreater(np.count_nonzero(front[:,:,0]==9), 20)
        # Air connectivity for spawns (not jump proof)
        walkable=~np.isin(new[:,:,0],[1,3])
        seen=set(); q=deque([(55,13)])
        while q:
            x,y=q.popleft()
            if (x,y) in seen or not (0<=x<520 and 0<=y<180) or not walkable[y,x]: continue
            seen.add((x,y)); q.extend([(x+1,y),(x-1,y),(x,y+1),(x,y-1)])
        self.assertTrue(all((x,y) in seen for x,y in NEW_SPAWNS_V2))

    def test_build_roundtrip_and_surfaces(self):
        original=twmap.Map(str(SOURCE)).game_layer().tiles
        expected=extend(original)
        expected_front=front_layer()
        with tempfile.TemporaryDirectory() as tmp:
            path=build(Path(tmp)); data=path.read_bytes(); m=twmap.Map(str(path))
            np.testing.assert_array_equal(expected[:,:,0],m.game_layer().tiles[:,:,0])
            np.testing.assert_array_equal(expected_front[:,:,0],m.front_layer().tiles[:,:,0])
            report=json.loads((Path(tmp)/'report.json').read_text())
            self.assertFalse(report['physics_preserved'])
            self.assertTrue(report['old_region_preserved_except_junctions'])
            self.assertTrue(report['photo_background'])
            self.assertFalse(report['release_enabled'])
            self.assertEqual(m.info.license,'CC-BY-SA 3.0')
            self.assertEqual([i.name for i in m.images],['chrome','pastel','ring','bevels'])
            self.assertEqual(len(m.envelopes),4)
            layers={l.name:l for g in m.groups for l in g.layers}
            solid=np.isin(expected[:,:,0],[1,3]); tiles=layers['Chrome'].tiles[:,:,0]
            np.testing.assert_array_equal(tiles!=0,solid)
            self.assertEqual(build(Path(tmp)).read_bytes(),data)
        self.assertEqual(hashlib.sha256(SOURCE.read_bytes()).hexdigest(),SOURCE_SHA)

    def test_pickups_and_weapons_scattered(self):
        old=twmap.Map(str(SOURCE)).game_layer().tiles
        new=extend(old)
        counts={k:int(np.count_nonzero(new[:,:,0]==v)) for k,v in [(197,197),(198,198),(199,199),(200,200),(201,201),(202,202)]}
        # all 6 weapon types present
        for tile in (197,198,199,200,201,202):
            self.assertGreater(counts[tile], 2, tile)
        with tempfile.TemporaryDirectory() as tmp:
            build_pickups(Path(tmp))
            for kind in ('health','armor'):
                rel=f'data/game_entities/neon_dm_{kind}.png'
                im=Image.open(ROOT/rel)
                self.assertEqual(im.size,(128,128))

if __name__=='__main__':
    unittest.main()
