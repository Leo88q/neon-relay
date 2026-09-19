#!/usr/bin/env python3
"""Structural/asset checks, not a native route or visual-quality proof."""
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
from chrome_dm_geometry import extend, change_mask, NEW_SPAWNS, NEW_ITEMS
from build_dm_pickups import build as build_pickups


class ChromeDmTest(unittest.TestCase):
    def test_extension_and_original_region(self):
        old=twmap.Map(str(SOURCE)).game_layer().tiles
        new=extend(old)
        self.assertEqual(new.shape,(120,274,2))
        preserved=~change_mask()
        np.testing.assert_array_equal(old[:,:,0][preserved],new[:,:146,0][preserved])
        for y,x in np.argwhere(old[:,:,0]>=192):
            self.assertEqual(old[y,x,0],new[y,x,0])
        self.assertEqual(np.count_nonzero(new[:,:,0]==192),19)
        open_old=np.count_nonzero(~np.isin(old[:,:,0],[1,3]))
        self.assertGreater(np.count_nonzero(~np.isin(new[:,:,0],[1,3])),open_old*2)
        for x,y in NEW_SPAWNS:
            self.assertEqual(new[y,x,0],192)
            self.assertEqual(new[y-1,x,0],0)
            self.assertEqual(new[y+1,x,0],1)
        for x,y,tile in NEW_ITEMS:
            self.assertEqual(new[y,x,0],tile)
            self.assertEqual(new[y+1,x,0],1)
        # Air connectivity detects sealed-off added rooms, NOT jump solvability.
        walkable=~np.isin(new[:,:,0],[1,3]);seen=set();q=deque([(55,13)])
        while q:
            x,y=q.popleft()
            if (x,y) in seen or not (0<=x<274 and 0<=y<120) or not walkable[y,x]:continue
            seen.add((x,y));q.extend([(x+1,y),(x-1,y),(x,y+1),(x,y-1)])
        self.assertTrue(all((x,y) in seen for x,y in NEW_SPAWNS))

    def test_build_roundtrip_and_surfaces(self):
        original=twmap.Map(str(SOURCE)).game_layer().tiles
        expected=extend(original)
        with tempfile.TemporaryDirectory() as tmp:
            path=build(Path(tmp));data=path.read_bytes();m=twmap.Map(str(path))
            np.testing.assert_array_equal(expected[:,:,0],m.game_layer().tiles[:,:,0])
            report=json.loads((Path(tmp)/'report.json').read_text())
            self.assertFalse(report['physics_preserved'])
            self.assertTrue(report['old_region_preserved_except_junctions'])
            self.assertFalse(report['release_enabled'])
            self.assertEqual(m.info.license,'CC-BY-SA 3.0')
            self.assertEqual([i.name for i in m.images],['chrome','pastel','ring','bevels'])
            self.assertEqual(len(m.envelopes),4)
            layers={l.name:l for g in m.groups for l in g.layers}
            solid=np.isin(expected[:,:,0],[1,3]);tiles=layers['Chrome'].tiles[:,:,0]
            np.testing.assert_array_equal(tiles!=0,solid)
            for y,x in np.argwhere(solid):self.assertEqual(tiles[y,x],1+(y%8)*8+x%8)
            self.assertEqual(build(Path(tmp)).read_bytes(),data)
        self.assertEqual(hashlib.sha256(SOURCE.read_bytes()).hexdigest(),SOURCE_SHA)

    def test_pickups_are_original_and_packaged(self):
        with tempfile.TemporaryDirectory() as tmp:
            build_pickups(Path(tmp))
            for kind in ('health','armor'):
                rel=f'data/game_entities/neon_dm_{kind}.png'
                im=Image.open(ROOT/rel)
                self.assertEqual(im.size,(128,128));self.assertEqual(im.mode,'RGBA')
                self.assertEqual(im.getpixel((0,0))[3],0)
                self.assertEqual((Path(tmp)/Path(rel).name).read_bytes(),(ROOT/rel).read_bytes())
                self.assertIn(rel.removeprefix('data/'),(ROOT/'CMakeLists.txt').read_text())
        generator=(ROOT/'scripts/build_dm_pickups.py').read_text()
        self.assertNotIn('potato_cool_guy',generator)
        self.assertNotIn('data/skins',generator)
        client=(ROOT/'src/game/client/components/items.cpp').read_text()
        self.assertIn('m_PredictVanilla && !GameClient()->m_GameInfo.m_Race',client)
        self.assertIn('m_DmHealthTexture : m_DmArmorTexture',client)
        self.assertIn('UnloadTexture(&m_DmHealthTexture)',client)


if __name__=='__main__':unittest.main()
