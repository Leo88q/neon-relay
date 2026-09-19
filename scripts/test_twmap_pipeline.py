#!/usr/bin/env python3
"""Executable twmap API/serialization contracts, not native gameplay tests."""
import hashlib
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
import twmap

from datafile_v4 import read
from test_map_format import validate
from twmap_pipeline import ROOT, assign_tiles, calibration_map, physics_snapshot, require_version, roundtrip_probe


class TwmapPipeline(unittest.TestCase):
    def test_supported_version_is_explicit(self):
        require_version()
        with patch('twmap_pipeline.version', return_value='0.0.0'):
            with self.assertRaises(RuntimeError):
                require_version()

    def test_existing_maps_preserve_physics_without_overwriting(self):
        for name in ('LearnToPlay', 'LearnToPlay Sound', 'LearnToPlay Sound Heights'):
            with self.subTest(name=name):
                source = ROOT / 'data/maps' / (name + '.map')
                digest = hashlib.sha256(source.read_bytes()).hexdigest()
                report = roundtrip_probe(source)
                self.assertTrue(report['physics_api_equal'])
                self.assertTrue(report['physics_raw_equal'])
                self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(), digest)
                self.assertFalse(report['visual_equivalence_verified'])

    def test_original_map_has_all_six_physics_layers(self):
        m = calibration_map()
        snap = physics_snapshot(m)
        self.assertEqual(snap['game']['shape'], [16, 32, 2])
        self.assertEqual(snap['speedup']['dtype'], 'int16')
        self.assertEqual(snap['speedup']['shape'], [16, 32, 4])
        self.assertEqual(snap['switch']['shape'], [16, 32, 4])
        for name in ('front', 'tele', 'tune'):
            self.assertEqual(snap[name]['shape'], [16, 32, 2])
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'fixture.map'
            m.save(str(path))
            validate(path)
            self.assertEqual(snap, physics_snapshot(twmap.Map(str(path))))
            self.assertEqual(twmap.Map(str(path)).info.author, 'Neon Relay')
            self.assertEqual(len(m.images), 0)
            self.assertEqual(len(m.sounds), 0)
            # Verify packed records independently of twmap's numpy view.
            raw = read(path)
            layers = {p[6]: p for _, p in raw.items[5] if p[1] == 2 and p[6]}
            self.assertEqual(set(layers), {1, 2, 4, 8, 16, 32})
            specs = [(1,14,4,11,3,bytes((192,0,0,0))),
                     (8,20,4,10,14,bytes((60,8,0,0))),
                     (2,18,2,11,20,bytes((1,26))),
                     (4,19,6,11,9,bytes((10,20,28,0,180,0))),
                     (16,21,4,11,12,bytes((1,23,0,2))),
                     (32,22,2,11,25,bytes((1,68)))]
            for flag,pointer,stride,y,x,expected in specs:
                data = raw.raws[layers[flag][pointer]]
                start = (y*32+x)*stride
                self.assertEqual(data[start:start+stride], expected)

    def test_speedup_read_modify_write_keeps_other_boosts(self):
        m = twmap.Map(str(ROOT / 'data/maps/LearnToPlay.map'))
        layer = m.speedup_layer()
        expected = layer.tiles.copy()
        y, x = np.argwhere(expected[:, :, 2] != 0)[0]
        expected[y, x, 0] = 37
        assign_tiles(layer, expected)
        np.testing.assert_array_equal(layer.tiles, expected)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'edited.map'
            m.save(str(path))
            np.testing.assert_array_equal(twmap.Map(str(path)).speedup_layer().tiles, expected)
            raw = read(path)
            p = next(p for _,p in raw.items[5] if p[1] == 2 and p[6] == 4)
            data = raw.raws[p[19]]
            offset = (int(y)*p[4]+int(x))*6
            self.assertEqual(data[offset],37)
            self.assertEqual(data[offset+2],int(expected[y,x,2]))

    def test_invalid_input_fails(self):
        with self.assertRaises(twmap.MapError):
            twmap.Map.from_bytes(b'not a map')


if __name__ == '__main__':
    unittest.main()
