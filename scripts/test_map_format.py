#!/usr/bin/env python3
"""Independent structural checks against CDataFileReader's v4 contract."""
import struct
import tempfile
import unittest
import zlib
from pathlib import Path
from map_format import MapWriter, pack_name, quad_rect

ROOT = Path(__file__).resolve().parent.parent

def validate(path):
    data = path.read_bytes()
    magic, version, size, swap, nt, ni, nr, items_size, raw_size = struct.unpack_from('<4s8i', data)
    assert magic == b'DATA' and version == 4
    raw_start = 36 + nt*12 + ni*4 + nr*8 + items_size
    assert size + 16 == len(data)
    assert swap + 16 == raw_start
    assert raw_start + raw_size == len(data)
    types = [struct.unpack_from('<3i', data, 36+i*12) for i in range(nt)]
    offset = 36 + nt*12
    item_offsets = struct.unpack_from(f'<{ni}i', data, offset)
    offset += ni*4
    raw_offsets = struct.unpack_from(f'<{nr}i', data, offset)
    offset += nr*4
    raw_sizes = struct.unpack_from(f'<{nr}i', data, offset)
    item_start = offset + nr*4
    count = 0
    for t, start, n in types:
        assert start == count
        for i in range(start, start+n):
            tag, payload_size = struct.unpack_from('<2i', data, item_start+item_offsets[i])
            end = item_offsets[i+1] if i+1 < ni else items_size
            assert tag >> 16 == t
            assert payload_size == end-item_offsets[i]-8
        count += n
    assert count == ni
    for i, start in enumerate(raw_offsets):
        end = raw_offsets[i+1] if i+1 < nr else raw_size
        assert len(zlib.decompress(data[raw_start+start:raw_start+end])) == raw_sizes[i]

class MapFormatTests(unittest.TestCase):
    def test_generated_maps(self):
        for name in ['Neon Relay Basin', 'Chromatic Canyon', 'Midnight Circuit', 'Vector Spire', 'Aurora Ascent']:
            with self.subTest(name=name):
                validate(ROOT / f'data/maps/{name}.map')
        for variant in ['day', 'night']:
            validate(ROOT / f'data/themes/nightdrive_{variant}.map')

    def test_multiple_types_and_blocks(self):
        writer = MapWriter()
        writer.version()
        writer.info('author', '1', 'credits', 'license')
        writer.image('test', 16, 16)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)/'test.map'
            writer.save(path)
            validate(path)
            before = path.read_bytes()
            writer.save(path)
            self.assertEqual(before, path.read_bytes())

    def test_gameplay_unchanged_by_retheme(self):
        import json
        from map_gameplay_fingerprint import gameplay
        for name, expected in json.loads((ROOT/'tests/fixtures/map_gameplay.json').read_text()).items():
            self.assertEqual(gameplay(ROOT/f'data/maps/{name}.map'), expected, name)

    def test_quad_matches_engine_corner_order(self):
        q=struct.unpack('<38i',quad_rect(0,0,20,10))
        self.assertEqual(q[:8], (0,0,20480,0,0,10240,20480,10240))
        self.assertEqual(q[26:34], (0,0,1024,0,0,1024,1024,1024))
        # Native buffering swaps corners 2/3 into perimeter order.
        pts=[(q[i*2],q[i*2+1]) for i in (0,1,3,2)]
        self.assertGreater(sum(pts[i][0]*pts[(i+1)%4][1]-pts[(i+1)%4][0]*pts[i][1] for i in range(4)),0)

    def test_name_matches_engine_encoding(self):
        self.assertEqual(struct.pack('>3i', *pack_name('abc')), b'\xe1\xe2\xe3'+b'\x80'*8+b'\x00')

if __name__ == '__main__':
    unittest.main()
