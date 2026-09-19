#!/usr/bin/env python3
"""Warmup content/serialization checks. These do not claim a native playthrough."""
import tempfile
import unittest
from pathlib import Path
import numpy as np
import twmap
from build_warmup import build, geometry, OUTPUT, CHECKPOINTS, PITS, W, H
from datafile_v4 import read
from test_map_format import validate


class Warmup(unittest.TestCase):
    def test_reproducible_and_valid(self):
        validate(OUTPUT)
        with tempfile.TemporaryDirectory() as tmp:
            dest=Path(tmp)/'warmup.map';build(dest)
            self.assertEqual(dest.read_bytes(),OUTPUT.read_bytes())
        m=twmap.Map(str(OUTPUT));game,tele=geometry()
        np.testing.assert_array_equal(m.game_layer().tiles,game)
        np.testing.assert_array_equal(m.tele_layer().tiles,tele)
        self.assertEqual(m.info.settings,['sv_solo_server 1'])
        self.assertEqual(len(m.images),4)

    def test_independent_wire_records(self):
        raw=read(OUTPUT)
        layers={p[6]:p for _,p in raw.items[5] if p[1]==2 and p[6]}
        game=raw.raws[layers[1][14]];tele=raw.raws[layers[2][18]]
        for x,y,value in [(5,35,192),(10,35,33),(160,31,34),(80,19,1),(40,32,3)]:
            i=(y*W+x)*4;self.assertEqual(game[i:i+4],bytes([value,0,0,0]))
        for x,y,number,tile in [(38,31,1,29),(40,30,1,30),(72,27,2,29),(74,26,2,30),(43,40,1,63)]:
            i=(y*W+x)*2;self.assertEqual(tele[i:i+2],bytes([number,tile]))

    def test_safe_recovery_and_full_height_race_gates(self):
        game,tele=geometry();g=game[:,:,0]
        self.assertEqual(np.count_nonzero(g==192),1)
        for x,floor,tile in [(10,36,33),(160,32,34)]:
            self.assertTrue(np.all(g[1:floor,x]==tile))
            self.assertEqual(g[floor,x],3)
        for number,x,bottom,ox,oy in CHECKPOINTS:
            self.assertTrue(np.all(tele[1:bottom+1,x]==[number,29]))
            self.assertTrue(np.all(g[oy:oy+2,ox]==0))
            self.assertEqual(g[oy+2,ox],3)
            self.assertLess(ox,160)
        hazard=tele[:,:,1]==63
        self.assertFalse(np.any(np.isin(g[hazard],[1,3,33,34,192])))
        self.assertEqual(np.count_nonzero(hazard),sum((r-l+1)*4 for l,r in PITS))
        self.assertTrue(np.all(np.isin(g[0,:],[1,3])))
        self.assertTrue(np.all(np.isin(g[-1,:],[1,3])))
        self.assertTrue(np.all(g[:,0]==3));self.assertTrue(np.all(g[:,-1]==3))

    def test_visible_surfaces_match_collision_and_oil_is_animated(self):
        m=twmap.Map(str(OUTPUT));g=m.game_layer().tiles[:,:,0]
        layers={layer.name:layer for group in m.groups for layer in group.layers}
        v=layers['Stage'].tiles[:,:,0]
        np.testing.assert_array_equal(v!=0,np.isin(g,[1,3]))
        self.assertTrue(np.all((v[g==1]>=16)&(v[g==1]<=31)))
        self.assertTrue(np.all((v[g==3]>=32)&(v[g==3]<=47)))
        oil=layers['Oil return']
        self.assertEqual(len({q.color_env for q in oil.quads}),16)
        for q in oil.quads:
            env=m.envelopes[q.color_env]
            self.assertEqual(len(env.points),17)
            self.assertEqual(env.points[16].time,1280)
            self.assertTrue(all(p.curve=='Step' for p in env.points))
            x,y=q.corners[0];self.assertGreaterEqual(y,40)
            self.assertTrue(any(l<=x<=r for l,r in PITS))
        self.assertTrue(all(q.position_env is not None for q in layers['Peak motion'].quads))


if __name__=='__main__':unittest.main()
