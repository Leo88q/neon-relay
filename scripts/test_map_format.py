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
            tag, payload_size = struct.unpack_from('<Ii', data, item_start+item_offsets[i])
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

    def test_learntoplay_preservation_and_animation(self):
        import json, hashlib
        from datafile_v4 import read
        from map_gameplay_fingerprint import gameplay
        src=ROOT/'data/maps/LearnToPlay.map'
        dst=ROOT/'data/maps/LearnToPlay Sound.map'
        fixture=json.loads((ROOT/'tests/fixtures/learntoplay_source.json').read_text())
        self.assertEqual(hashlib.sha256(src.read_bytes()).hexdigest(),fixture['source_sha256'])
        self.assertEqual(gameplay(src),fixture['gameplay_sha256'])
        self.assertEqual(gameplay(dst),fixture['gameplay_sha256'])
        validate(dst)
        a,b=read(src),read(dst)
        self.assertEqual(a.raws,b.raws[:len(a.raws)])
        for t in (0,1,4,65534,65535):self.assertEqual(a.items[t],b.items[t])
        self.assertEqual(a.items[2],b.items[2][:len(a.items[2])])
        self.assertEqual(a.items[3],b.items[3][:len(a.items[3])])
        self.assertEqual(dict(a.items[6])[0],dict(b.items[6])[0][:len(dict(a.items[6])[0])])
        layers=dict(b.items[5])
        for i,p in a.items[5]:
            if p[1]==2 and p[6]:self.assertEqual(p,layers[i])
        for i in [*range(6,23),25,54]:self.assertEqual(dict(a.items[5])[i],layers[i])
        # Segment visibility and moving peaks are actual map envelopes, not a GIF.
        envs=dict(b.items[3]);points=dict(b.items[6])[0]
        self.assertEqual(len(envs)-len(a.items[3]),67)
        animated=0
        for i,p in b.items[3][len(a.items[3]):]:
            frames=[points[n*6:n*6+6] for n in range(p[2],p[2]+p[3])]
            self.assertEqual(frames[0][2:],frames[-1][2:])
            animated += len(set(tuple(f[2:]) for f in frames))>1
            self.assertEqual(p[-1],1)
        self.assertGreaterEqual(animated,40)
        self.assertGreater(layers[38][4],0)
        self.assertGreater(layers[39][4],0)
        # Reader/writer retain unsigned high types and extension IDs.
        with tempfile.TemporaryDirectory() as tmp:
            output=Path(tmp)/'roundtrip.map';a.save(output)
            again=read(output)
            self.assertEqual(a.items,again.items);self.assertEqual(a.raws,again.raws)

    def test_learn_visual_coverage_and_directions(self):
        from datafile_v4 import read
        from learn_visibility import fields,visual_layers
        source=read(ROOT/'data/maps/LearnToPlay.map')
        output=read(ROOT/'data/maps/LearnToPlay Sound.map')
        layers=dict(output.items[5]);visuals,audit=visual_layers(source)
        for slot,(name,p,raw,stride,offset,flag_offset) in enumerate(fields(source)):
            edges,glyphs=visuals[name]
            self.assertEqual(output.raws[layers[40+slot*2][14]],edges)
            self.assertEqual(output.raws[layers[41+slot*2][14]],glyphs)
            for i in range(p[4]*p[5]):
                value=raw[i*stride+offset]
                if not value:continue
                self.assertIn(str(value),audit[name])
                if name in ('game','front') and value in (9,11,12,13,60):
                    self.assertNotEqual(edges[i*4],0,(name,i,value))
                if name in ('game','front') and value==60:
                    self.assertEqual(edges[i*4+1],raw[i*stride+1]&11)
                    self.assertEqual(glyphs[i*4+1],raw[i*stride+1]&11)
                if name=='speed':
                    angle=struct.unpack_from('<h',raw,i*stride+4)[0]%360
                    self.assertEqual(glyphs[i*4+1],{0:0,90:8,180:3,270:11}[angle])
                if name=='game' and value in (1,3):
                    material=output.raws[layers[37][14]][i*4]
                    self.assertTrue(16<=material<32 if value==1 else 32<=material<48)

    def test_readable_atlas_and_seamless_background(self):
        from PIL import Image
        import numpy as np
        atlas=Image.open(ROOT/'data/mapres/neonrelay_learn_terrain.png')
        for idx in range(16,48):
            x,y=idx%16*64,idx//16*64
            tile=np.array(atlas.crop((x,y,x+64,y+64)))
            self.assertTrue((tile[:,:,3]==255).all())
            if idx%16&1:self.assertGreater(tile[1,:,:3].mean(),170)
        sky=np.array(Image.open(ROOT/'data/mapres/neonrelay_learn_atmosphere.png'))
        self.assertTrue((sky[0]==sky[-1]).all())
        self.assertTrue((sky[:,0]==sky[:,-1]).all())
        self.assertLess(sky.max(),48) # background cannot compete with collision caps

    def test_functional_palette_icons_and_landmarks(self):
        from learn_visibility import COLORS,symbol
        from world_palette import ICE,PORTAL,RACE
        from datafile_v4 import read
        import numpy as np
        import ast
        self.assertEqual(COLORS[:3],[ICE]*3)
        self.assertEqual(COLORS[4:6],[PORTAL]*2)
        for values,color in [((9,12,11),ICE),((26,27,29,30,63),PORTAL),((33,34,35),RACE)]:
            for v in values:
                a=np.array(symbol(v))
                self.assertTrue(((a[:,:,:3]==color).all(axis=2)&(a[:,:,3]>200)).any(),v)
        tree=ast.parse((ROOT/'scripts/learn_visibility.py').read_text())
        self.assertFalse(any(isinstance(n,ast.Call) and isinstance(n.func,ast.Attribute) and n.func.attr in ('text','multiline_text') for n in ast.walk(tree)))
        m=read(ROOT/'data/maps/LearnToPlay Sound.map');layers=dict(m.items[5])
        for i in (23,24):
            self.assertEqual(layers[i][1],3)
            self.assertGreater(layers[i][4],0)
        # Original race line is eight cells tall, but its icon is no longer repeated eight times.
        p=layers[41];raw=m.raws[p[14]]
        self.assertLess(sum(v==33 for v in raw[::4]),8)

    def test_heights_only_adds_twelve_explicit_safe_terrace_tiles(self):
        from datafile_v4 import read
        from learn_visibility import fields
        source=read(ROOT/'data/maps/LearnToPlay.map')
        variant=read(ROOT/'data/maps/LearnToPlay Sound Heights.map')
        validate(ROOT/'data/maps/LearnToPlay Sound Heights.map')
        self.assertEqual(source.raws,variant.raws[:len(source.raws)])
        for t in (0,1,4,65534,65535):self.assertEqual(source.items[t],variant.items[t])
        a=dict(source.items[5]);b=dict(variant.items[5]);w=a[32][4]
        original=source.raws[a[32][14]];changed=variant.raws[b[32][14]]
        expected={(342+dx,y) for dx,height in enumerate((1,2,3,3,2,1)) for y in range(23-height,23)}
        actual={(i//4%w,i//4//w) for i in range(0,len(original),4) if original[i:i+4]!=changed[i:i+4]}
        self.assertEqual(actual,expected);self.assertEqual(len(actual),12)
        for x,y in expected:
            i=(y*w+x)*4
            self.assertEqual(original[i:i+4],bytes(4))
            self.assertEqual(changed[i:i+4],bytes((1,0,0,0)))
        for name,p,raw,stride,offset,flags in fields(source):
            for x,y in expected:self.assertEqual(raw[(y*w+x)*stride+offset],0)
        for x in range(342,348):
            self.assertIn(original[(23*w+x)*4],(1,3))
            self.assertTrue(all(original[(y*w+x)*4]==0 for y in range(17,20)))
        for i in range(33,37):self.assertEqual(a[i],b[i])
        desc=b[32].copy();desc[14]=a[32][14]
        self.assertEqual(a[32],desc)

    def test_oil_stays_in_hazards_and_animates_real_frames(self):
        from datafile_v4 import read
        from learn_oil import pools,FRAMES,FRAME_MS
        from PIL import Image
        import hashlib
        m=read(ROOT/'data/maps/LearnToPlay Sound.map');layers=dict(m.items[5]);w=layers[32][4]
        cells,surface=pools(m)
        self.assertGreater(len(surface),100)
        g=m.raws[layers[32][14]][::4];f=m.raws[layers[33][20]][::4];t=m.raws[layers[35][18]][1::2]
        for i in cells:
            self.assertNotIn(g[i],(1,3,11,13,60,61,62))
            self.assertNotIn(f[i],(11,13,60,61,62))
            self.assertTrue(g[i] in (2,9,12) or f[i] in (2,9,12) or t[i] in (10,63))
        self.assertLess(layers[50][4],16384) # bounded single-layer quad/index budget
        raw=m.raws[layers[50][5]];covered=set();used=set()
        for off in range(0,len(raw),152*FRAMES):
            group=[struct.unpack_from('<38i',raw,off+j*152) for j in range(FRAMES)]
            q=group[0];x0,y0=q[0]//32768,q[1]//32768;x1=q[2]//32768
            self.assertEqual(q[5]-q[1],32768)
            covered.update(y0*w+x for x in range(x0,x1))
            self.assertEqual(len({v[26:34] for v in group}),FRAMES)
            for v in group:
                self.assertEqual(v[:10],q[:10]);used.add(v[-2])
        self.assertEqual(covered,cells)
        self.assertEqual(len(used),FRAMES)
        points=dict(m.items[6])[0];envs=dict(m.items[3])
        for j in range(FRAMES+1):
            alphas=[]
            for eid in used:
                p=envs[eid];point=points[(p[2]+j)*6:(p[2]+j+1)*6]
                self.assertEqual(point[0],j*FRAME_MS);self.assertEqual(point[1],0)
                alphas.append(point[5])
            self.assertEqual(sum(alphas),1024) # exactly one visible pose per phase
        atlas=Image.open(ROOT/'data/mapres/neonrelay_learn_oil.png')
        frames=[atlas.crop((i%8*128,i//8*128,i%8*128+128,i//8*128+128)) for i in range(FRAMES)]
        self.assertEqual(len({hashlib.sha256(im.tobytes()).digest() for im in frames}),FRAMES)

    def test_oil_selection_leaves_columns_ceilings_and_safe_thaw_alone(self):
        from learn_oil import pools
        from types import SimpleNamespace
        w=h=10;g=bytearray(w*h*4);f=bytearray(w*h*4);t=bytearray(w*h*2)
        for x in range(1,7):
            g[(5*w+x)*4]=9;g[(6*w+x)*4]=3
            g[x*4]=3;g[(w+x)*4]=9 # freeze on the underside of a ceiling
        for y in range(1,5):g[(y*w+9)*4]=9 # a narrow ice column
        g[(5*w+7)*4]=11
        game=[0]*23;game[4:6]=[w,h];game[14]=0
        front=[0]*23;front[20]=1
        tele=[0]*23;tele[18]=2
        m=SimpleNamespace(items={5:[(32,game),(33,front),(35,tele)]},raws=[g,f,t])
        cells,surface=pools(m)
        self.assertEqual(cells,{5*w+x for x in range(1,7)})
        self.assertEqual(surface,cells)

    def test_name_matches_engine_encoding(self):
        self.assertEqual(struct.pack('>3i', *pack_name('abc')), b'\xe1\xe2\xe3'+b'\x80'*8+b'\x00')

if __name__ == '__main__':
    unittest.main()
