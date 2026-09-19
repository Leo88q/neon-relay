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


def textures(folder):
    # User's chrome ramp, not recolored upstream artwork. Each tile mask marks
    # only real exposed collision edges; highlights never move those edges.
    stops = np.array([0,.08,.22,.34,.40,.46,.60,.80,1])
    colors = np.array([[255,255,255],[223,233,255],[143,163,216],[42,50,102],
                       [14,18,48],[85,104,168],[199,211,245],[255,255,255],[127,139,189]])
    y,x = np.mgrid[0:64,0:64]
    atlas = Image.new('RGBA',(1024,1024))
    # Use a ramp across the depth of each solid column, NOT a full chrome
    # stripe repeated in every 32px cell (which produces distracting moire).
    for band in range(15):
        ramp = np.stack([np.interp((band+y/63)/15,stops,colors[:,c]) for c in range(3)],axis=-1)
        tint=np.array([.96,.97,1.0])
        rgb=np.clip(ramp*tint,0,255).astype(np.uint8)
        for mask in range(16):
            tile=Image.fromarray(rgb).convert('RGBA');d=ImageDraw.Draw(tile)
            for bit,line in [(1,(0,0,63,0)),(2,(63,0,63,63)),(4,(0,63,63,63)),(8,(0,0,0,63))]:
                if mask&bit:
                    d.line(line,fill=(24,26,62,255),width=5)
                    if bit==1:d.line((0,2,63,2),fill=(255,255,255,255),width=2)
            idx=1+band*16+mask;atlas.paste(tile,((idx%16)*64,(idx//16)*64))
    atlas.save(folder/'chrome.png')
    # Procedural pastel field. This is a static texture + native envelopes,
    # NOT a claim that the supplied real-time domain-warp shader is installed.
    yy,xx=np.mgrid[0:512,0:768];p=xx/180;q=yy/180
    f=np.sin(p+np.sin(q*1.4))*.35+np.cos(q+np.sin(p*.8))*.3
    col=.5+.5*np.cos(2*math.pi*(f[:,:,None]*.65+np.array([0,.33,.67])))
    col=col*.40+np.array([.86,.9,1])*.60
    Image.fromarray((col*255).astype(np.uint8)).save(folder/'pastel.png')
    ring=Image.new('RGBA',(128,128));d=ImageDraw.Draw(ring)
    d.ellipse((7,7,121,121),fill=(255,255,255,15),outline=(255,255,255,150),width=3)
    d.arc((22,22,106,106),205,280,fill=(255,255,255,210),width=3)
    ring.save(folder/'ring.png')


def build(folder):
    require_version();folder=Path(folder);folder.mkdir(parents=True,exist_ok=True)
    assert hashlib.sha256(SOURCE.read_bytes()).hexdigest()==SOURCE_SHA, 'Source map changed'
    source=twmap.Map(str(SOURCE));before=physics_snapshot(source)
    assert all(before[k] is None for k in ('front','tele','speedup','switch','tune'))
    game=source.game_layer().tiles;h,w,_=game.shape
    textures(folder)
    m=twmap.Map.empty('DDNet06')
    m.info.author='Teeworlds / Neon Relay'
    m.info.version='chrome-study-1'
    m.info.credits='Modified dm7, Teeworlds 0.6.5; geometry unchanged; new code-built visuals'
    m.info.license='CC-BY-SA 3.0'
    m.info.settings=list(source.info.settings)
    for name in ('chrome','pastel','ring'):m.images.new_from_file(str(folder/(name+'.png')))

    def env(name,kind,frames):
        idx=len(m.envelopes);e=m.envelopes.new(kind);e.name=name;e.synchronized=True
        for t,value in frames:
            p=e.points.new(t);p.content=value;p.curve='Smooth'
        return idx
    def quad(layer,x,y,width,height):
        return layer.quads.new(x+width/2,y+height/2,width,height)

    bg=m.groups.new();bg.name='Pearl sky';bg.parallax_x=0;bg.parallax_y=0
    sky=bg.layers.new_quads();sky.name='Pastel';sky.image=1
    quad(sky,-100,-70,200,140)
    drift=env('Float','Position',[(0,(0,0,0)),(4000,(0,.4,0)),(8000,(0,0,0))])
    for lane in range(3):
        g=m.groups.new();g.name='Rings '+str(lane);g.parallax_x=8+lane*6;g.parallax_y=8+lane*6
        layer=g.layers.new_quads();layer.name='Rings';layer.image=2
        for i in range(14):
            q=quad(layer,i*6-25,((i*7+lane*11)%31)-10,1.5+lane*.4,1.5+lane*.4)
            q.position_env=drift;q.position_env_offset=(i*517+lane*997)%8000
    g=m.groups.new_physics();g.name='Game'
    l=g.layers.new_game(w,h);assign_tiles(l,game)
    terrain=g.layers.new_tiles(w,h);terrain.name='Chrome';terrain.image=0
    a=terrain.tiles
    def solid(x,y):return 0<=x<w and 0<=y<h and game[y,x,0] in (1,3)
    for y in range(h):
        for x in range(w):
            if solid(x,y):
                mask=sum(bit for dx,dy,bit in [(0,-1,1),(1,0,2),(0,1,4),(-1,0,8)] if not solid(x+dx,y+dy))
                top=y
                while solid(x,top-1):top-=1
                bottom=y
                while solid(x,bottom+1):bottom+=1
                band=min(14,int(15*(y-top+.5)/(bottom-top+1)))
                a[y,x,0]=1+16*band+mask
    assign_tiles(terrain,a)
    terrain.color_env=env('Pearl tint','Color',[(0,(1,.94,1,1)),(5000,(.86,1,1,1)),(10000,(1,.94,1,1))])
    path=folder/'Neon Relay Chrome DM Study.map';m.save(str(path))
    reopened=twmap.Map(str(path));after=physics_snapshot(reopened)
    actual=reopened.game_layer().tiles
    assert np.array_equal(actual[:,:,0],game[:,:,0]), 'Collision/entity IDs changed'
    occupied=game[:,:,0]!=0
    assert np.array_equal(actual[:,:,1][occupied],game[:,:,1][occupied]), 'Nonempty tile flags changed'
    assert all(after[k]==before[k] for k in before if k!='game'), 'Special layers/settings changed'
    # twmap normalizes flags on empty tiles. dm7 has one irrelevant HFLIP on
    # empty cell (50,42); disclose this instead of claiming byte identity.
    empty_flag_changes=int(np.count_nonzero(actual[:,:,1][~occupied]!=game[:,:,1][~occupied]))
    report={'status':'visual study; opt-in DM code exists; native multiplayer validation pending',
            'source':audit(SOURCE),'physics_preserved':True,'map':path.name,
            'output_sha256':hashlib.sha256(path.read_bytes()).hexdigest(),
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
