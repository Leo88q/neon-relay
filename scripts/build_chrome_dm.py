#!/usr/bin/env python3
"""DM v4 – dark pixel neon, space background, visible freeze, meteors, more jumps."""
import argparse
import hashlib
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
import twmap
from twmap_pipeline import assign_tiles, physics_snapshot, require_version
from chrome_dm_geometry import extend, front_layer, change_mask, JUNCTIONS, NEW_SPAWNS_V2, NEW_SPAWNS_V3
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
    require_version(); folder=Path(folder); folder.mkdir(parents=True,exist_ok=True)
    assert hashlib.sha256(SOURCE.read_bytes()).hexdigest()==SOURCE_SHA
    source=twmap.Map(str(SOURCE)); before=physics_snapshot(source)
    assert all(before[k] is None for k in ('front','tele','speedup','switch','tune'))
    original=source.game_layer().tiles
    game=extend(original); h,w,_=game.shape
    front=front_layer()
    assert front.shape==game.shape
    textures(folder)
    m=twmap.Map.empty('DDNet06')
    m.info.author='Teeworlds / Neon Relay'
    m.info.version='chrome-v6'
    m.info.credits='Modified dm7; v6 520x180 bright cosmos photo, visible freeze, meteors code, vertical hook walls, many small jumps by Neon Relay'
    m.info.license='CC-BY-SA 3.0'
    m.info.settings=list(source.info.settings)
    for name in ('chrome','pastel','ring','bevels','freeze','meteor'):
        m.images.new_from_file(str(folder/(name+'.png')))

    def env(name,kind,frames):
        idx=len(m.envelopes); e=m.envelopes.new(kind); e.name=name; e.synchronized=True
        for t,value in frames:
            p=e.points.new(t); p.content=value; p.curve='Smooth'
        return idx
    def quad(layer,x,y,w_,h_):
        return layer.quads.new(x+w_/2,y+h_/2,w_,h_)

    # Space background – bright cosmos photo, full map coverage
    bg=m.groups.new(); bg.name='Space'; bg.parallax_x=0; bg.parallax_y=0
    sky=bg.layers.new_quads(); sky.name='Cosmos'; sky.image=1
    # Huge quad covering entire 520x180 map, centered
    q=quad(sky,-20,-20,560,220)
    q.colors=[(255,255,255,255)]*4
    q.position_env=env('Space drift','Position',[(0,(0,0,0)),(15000,(1.2,-0.8,0)),(30000,(0,0,0))])
    # Second layer slightly parallax for depth
    bg2=m.groups.new(); bg2.name='Space2'; bg2.parallax_x=5; bg2.parallax_y=5
    sky2=bg2.layers.new_quads(); sky2.name='Cosmos2'; sky2.image=1
    q2=quad(sky2,-10,-15,540,210)
    q2.colors=[(220,230,255,220)]*4

    # Meteors flying via code – quad layer with position envelopes
    meteor_drift = env('Meteor','Position',[(0,(0,0,0)),(8000,(25,-12,0)),(16000,(50,-24,0))])
    meteor_spin = env('Spin','Color',[(0,(1,1,1,0.9)),(4000,(1,1,1,0.6)),(8000,(1,1,1,0.9))])
    for lane in range(3):
        g=m.groups.new(); g.name=f'Meteors{lane}'; g.parallax_x=30+lane*15; g.parallax_y=20+lane*10
        layer=g.layers.new_quads(); layer.name='Meteors'; layer.image=5
        for i in range(12):
            # random start positions across sky
            x = -40 + i*18 + lane*7
            y = -10 + (i*13)%40
            q=quad(layer,x,y,3+lane*0.6,2+lane*0.4)
            q.position_env=meteor_drift
            q.position_env_offset=(i*1100+lane*2300)%16000
            q.color_env=meteor_spin
            q.color_env_offset=(i*700)%8000

    # Atrium ribs – subtle
    bg=m.groups.new(); bg.name='Ribs'; bg.parallax_x=22; bg.parallax_y=22
    ribs=bg.layers.new_quads(); ribs.name='Ribs'
    for k in range(18):
        cx=k*14-30
        for i in range(28):
            a0=math.pi*i/28; a1=math.pi*(i+1)/28
            x0=cx+7*math.cos(a0); y0=26-12*math.sin(a0)
            x1=cx+7*math.cos(a1); y1=26-12*math.sin(a1)
            q=quad(ribs,x0,y0,.1,.1)
            q.corners=[(x0,y0),(x1,y1),(x0+.13,y0+.12),(x1+.13,y1+.12)]
            q.colors=[(60,80,120,22)]*4
        for x0 in (cx-7,cx+7):
            q=quad(ribs,x0,26,.12,40); q.colors=[(60,80,120,18)]*4

    # Bubbles / rings
    drift=env('Float','Position',[(0,(0,0,0)),(4000,(0,.4,0)),(8000,(0,0,0))])
    for lane in range(3):
        g=m.groups.new(); g.name=f'Rings{lane}'; g.parallax_x=8+lane*6; g.parallax_y=8+lane*6
        layer=g.layers.new_quads(); layer.name='Bubbles'; layer.image=2
        for i in range(16):
            q=quad(layer,i*8-30,((i*7+lane*11)%50)-12,1.2+lane*.3,1.2+lane*.3)
            q.position_env=drift; q.position_env_offset=(i*517+lane*997)%8000

    g=m.groups.new_physics(); g.name='Game'
    l=g.layers.new_game(w,h); assign_tiles(l,game)
    fl=g.layers.new_physics('Front'); assign_tiles(fl,front)

    # Visible freeze walls – tiles layer using freeze.png so freeze is seen
    freeze_vis=g.layers.new_tiles(w,h); freeze_vis.name='FreezeWalls'; freeze_vis.image=4
    fv=freeze_vis.tiles
    for y in range(h):
        for x in range(w):
            if front[y,x,0]==9:
                fv[y,x,0]=1  # first tile in freeze atlas
            elif front[y,x,0]==11:
                fv[y,x,0]=2
    assign_tiles(freeze_vis,fv)

    terrain=g.layers.new_tiles(w,h); terrain.name='Chrome'; terrain.image=0
    edges=g.layers.new_tiles(w,h); edges.name='Bevels'; edges.image=3
    a=terrain.tiles; b=edges.tiles
    def solid(x,y): return 0<=x<w and 0<=y<h and game[y,x,0] in (1,3)
    glints=[]
    for y in range(h):
        for x in range(w):
            if solid(x,y):
                mask=sum(bit for dx,dy,bit in [(0,-1,1),(1,0,2),(0,1,4),(-1,0,8)] if not solid(x+dx,y+dy))
                a[y,x,0]=1+(y%8)*8+x%8; b[y,x,0]=mask
                if mask&1 and x%7==0 and 2<y<h-2: glints.append((x,y))
    assign_tiles(terrain,a); assign_tiles(edges,b)
    terrain.color_env=env('Tint','Color',[(0,(1,.96,1,1)),(7000,(.90,1,1,1)),(14000,(1,.96,1,1))])
    shine=g.layers.new_quads(); shine.name='Sheen'
    sheen=env('Sheen','Color',[(0,(1,1,1,.10)),(1800,(.7,1,1,.45)),(4200,(1,1,1,.10))])
    for x,y in glints:
        q=quad(shine,x+.12,y+.11,.72,.045); q.color_env=sheen; q.color_env_offset=(x*131+y*97)%4200

    path=folder/'Neon Relay Chrome DM Study.map'; m.save(str(path))
    reopened=twmap.Map(str(path))
    actual=reopened.game_layer().tiles
    actual_front=reopened.front_layer().tiles
    assert np.array_equal(actual[:,:,0],game[:,:,0])
    assert np.array_equal(actual_front[:,:,0],front[:,:,0])
    preserved=~change_mask()
    assert np.array_equal(actual[:120,:146,0][preserved],original[:,:,0][preserved])
    report={'status':'v6 bright cosmos, visible freeze, meteors code, vertical hook walls, many small jumps',
            'source':audit(SOURCE),'map':path.name,
            'output_sha256':hashlib.sha256(path.read_bytes()).hexdigest(),
            'width':w,'height':h,'spawn_count':int(np.count_nonzero(game[:,:,0]==192)),
            'front_freeze':int(np.count_nonzero(front[:,:,0]==9)),
            'license':'CC-BY-SA 3.0'}
    (folder/'report.json').write_text(json.dumps(report,indent=2)+'\n')
    return path

if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--output',type=Path,default=ROOT/'.cache/chrome-dm')
    args=parser.parse_args(); print(build(args.output))
