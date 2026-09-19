#!/usr/bin/env python3
"""Development-only dm7 visual adaptation. NOT a playable deathmatch release.

Reads pinned existing geometry via twmap; writes only to an explicit output
folder (default .cache/chrome-dm). No source map, character, or release asset is
modified. Derived map: CC-BY-SA 3.0, see docs/dm/CHROME_DM_RU.md.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
import twmap
from twmap_pipeline import assign_tiles, physics_snapshot, require_version
from chrome_dm_geometry import extend, change_mask, JUNCTIONS, NEW_SPAWNS
from chrome_dm_materials import textures

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'data/maps/dm7.map'
SOURCE_SHA = '5a2875e5232fa21faccc16e48ccc42eecca5e5f32ce39bd73f0657bbb58d2e2f'
ENTITIES = {192:'spawn',197:'armor',198:'health',199:'shotgun',200:'grenade',201:'ninja',202:'laser'}


def audit(path):
    m = twmap.Map(str(path))
    a = m.game_layer().tiles[:, :, 0]
    return {'file':Path(path).name, 'sha256':hashlib.sha256(Path(path).read_bytes()).hexdigest(),
            'width':a.shape[1], 'height':a.shape[0], 'cells':int(a.size),
            'entities':{name:int(np.count_nonzero(a == tile)) for tile,name in ENTITIES.items()},
            'embedded_author':m.info.author, 'embedded_license':m.info.license}


def build(folder):
    require_version();folder=Path(folder);folder.mkdir(parents=True,exist_ok=True)
    assert hashlib.sha256(SOURCE.read_bytes()).hexdigest()==SOURCE_SHA, 'Source map changed'
    source=twmap.Map(str(SOURCE));before=physics_snapshot(source)
    assert all(before[k] is None for k in ('front','tele','speedup','switch','tune'))
    original=source.game_layer().tiles
    game=extend(original);h,w,_=game.shape
    textures(folder)
    m=twmap.Map.empty('DDNet06')
    m.info.author='Teeworlds / Neon Relay'
    m.info.version='chrome-atrium-2'
    m.info.credits='Modified dm7; new connected atrium and chrome visuals by Neon Relay'
    m.info.license='CC-BY-SA 3.0'
    m.info.settings=list(source.info.settings)
    for name in ('chrome','pastel','ring','bevels'):m.images.new_from_file(str(folder/(name+'.png')))

    def env(name,kind,frames):
        idx=len(m.envelopes);e=m.envelopes.new(kind);e.name=name;e.synchronized=True
        for t,value in frames:
            p=e.points.new(t);p.content=value;p.curve='Smooth'
        return idx
    def quad(layer,x,y,width,height):
        return layer.quads.new(x+width/2,y+height/2,width,height)

    bg=m.groups.new();bg.name='Pearl sky';bg.parallax_x=0;bg.parallax_y=0
    sky=bg.layers.new_quads();sky.name='Pastel';sky.image=1
    q=quad(sky,-100,-70,200,140)
    q.position_env=env('Sky drift','Position',[(0,(0,0,0)),(12000,(.5,-.3,0)),(24000,(0,0,0))])
    drift=env('Float','Position',[(0,(0,0,0)),(4000,(0,.4,0)),(8000,(0,0,0))])
    bg=m.groups.new();bg.name='Atrium ribs';bg.parallax_x=22;bg.parallax_y=22
    ribs=bg.layers.new_quads();ribs.name='Ribs'
    for k in range(12):
        cx=k*14-30
        for i in range(28):
            a0=math.pi*i/28;a1=math.pi*(i+1)/28
            x0=cx+7*math.cos(a0);y0=21-12*math.sin(a0)
            x1=cx+7*math.cos(a1);y1=21-12*math.sin(a1)
            q=quad(ribs,x0,y0,.1,.1)
            q.corners=[(x0,y0),(x1,y1),(x0+.13,y0+.12),(x1+.13,y1+.12)]
            q.colors=[(94,118,176,28)]*4
        for x0 in (cx-7,cx+7):
            q=quad(ribs,x0,21,.12,35);q.colors=[(94,118,176,25)]*4
    for lane in range(3):
        g=m.groups.new();g.name='Rings '+str(lane);g.parallax_x=8+lane*6;g.parallax_y=8+lane*6
        layer=g.layers.new_quads();layer.name='Rings';layer.image=2
        for i in range(16):
            q=quad(layer,i*8-25,((i*7+lane*11)%31)-10,1.5+lane*.4,1.5+lane*.4)
            q.position_env=drift;q.position_env_offset=(i*517+lane*997)%8000
    g=m.groups.new_physics();g.name='Game'
    l=g.layers.new_game(w,h);assign_tiles(l,game)
    terrain=g.layers.new_tiles(w,h);terrain.name='Chrome';terrain.image=0
    edges=g.layers.new_tiles(w,h);edges.name='Edge bevels';edges.image=3
    a=terrain.tiles;b=edges.tiles
    def solid(x,y):return 0<=x<w and 0<=y<h and game[y,x,0] in (1,3)
    glints=[]
    for y in range(h):
        for x in range(w):
            if solid(x,y):
                mask=sum(bit for dx,dy,bit in [(0,-1,1),(1,0,2),(0,1,4),(-1,0,8)] if not solid(x+dx,y+dy))
                a[y,x,0]=1+(y%8)*8+x%8;b[y,x,0]=mask
                if mask&1 and x%7==0 and 2<y<h-2:glints.append((x,y))
    assign_tiles(terrain,a);assign_tiles(edges,b)
    terrain.color_env=env('Pearl tint','Color',[(0,(1,.96,1,1)),(7000,(.90,1,1,1)),(14000,(1,.96,1,1))])
    shine=g.layers.new_quads();shine.name='Edge sheen'
    sheen=env('Sheen','Color',[(0,(1,1,1,.12)),(1800,(.8,1,1,.55)),(4200,(1,1,1,.12))])
    for x,y in glints:
        q=quad(shine,x+.12,y+.11,.72,.045);q.color_env=sheen;q.color_env_offset=(x*131+y*97)%4200
    path=folder/'Neon Relay Chrome DM Study.map';m.save(str(path))
    reopened=twmap.Map(str(path));after=physics_snapshot(reopened)
    actual=reopened.game_layer().tiles
    assert np.array_equal(actual[:,:,0],game[:,:,0]), 'Collision/entity IDs changed'
    occupied=game[:,:,0]!=0
    assert np.array_equal(actual[:,:,1][occupied],game[:,:,1][occupied]), 'Nonempty tile flags changed'
    assert all(after[k]==before[k] for k in before if k!='game'), 'Special layers/settings changed'
    preserved=~change_mask()
    assert np.array_equal(actual[:,:146,0][preserved],original[:,:,0][preserved])
    # twmap normalizes flags on empty tiles. dm7 has one irrelevant HFLIP on
    # empty cell (50,42); disclose this instead of claiming byte identity.
    empty_flag_changes=int(np.count_nonzero(actual[:,:,1][~occupied]!=game[:,:,1][~occupied]))
    report={'status':'expanded atrium v2; native validation must match this map hash',
            'source':audit(SOURCE),'physics_preserved':False,'map':path.name,
            'output_sha256':hashlib.sha256(path.read_bytes()).hexdigest(),
            'width':w,'height':h,'spawn_count':int(np.count_nonzero(game[:,:,0]==192)),
            'original_open_cells':int(np.count_nonzero(~np.isin(original[:,:,0],[1,3]))),
            'open_cells':int(np.count_nonzero(~np.isin(game[:,:,0],[1,3]))),
            'old_region_preserved_except_junctions':True,'junctions':JUNCTIONS,'added_spawns':NEW_SPAWNS,
            'candidates':[audit(p) for p in sorted((ROOT/'data/maps').glob('dm*.map'))],
            'empty_tile_flags_normalized':empty_flag_changes,'raw_game_bytes_identical':bool(np.array_equal(actual,game)),
            'license':'CC-BY-SA 3.0','license_verified':True,
            'upstream_revision':'64baa0e11c7f9a1390279394ca3536277afcd61b',
            'upstream_repository':'https://github.com/teeworlds/teeworlds-maps',
            'release_enabled':False,'source_artwork_copied':False,'realtime_shader_installed':False}
    (folder/'report.json').write_text(json.dumps(report,indent=2)+'\n')
    return path


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,default=ROOT/'.cache/chrome-dm')
    args=parser.parse_args();print(build(args.output))
