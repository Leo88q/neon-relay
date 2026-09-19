#!/usr/bin/env python3
"""Original authored Warmup playtest course, serialized exclusively by twmap.

No source .map is read. Existing original Neon Relay texture PNGs are embedded.
"""
from pathlib import Path
import math
import numpy as np
import twmap
from twmap_pipeline import assign_tiles, require_version

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / 'data/maps/Neon Relay Warmup.map'
W, H = 176, 48
# Inclusive X intervals, floor Y. Authored blocks, no randomness.
FLOORS = [(2,16,36),(17,19,35),(20,22,34),(23,25,33),(26,42,32),
          (47,58,30),(63,74,29),(79,92,28),(101,104,35),(107,110,32),
          (113,125,28),(126,131,29),(132,137,30),(138,144,31),(145,173,32)]
PITS = [(43,46),(59,62),(75,78),(93,100),(105,106),(111,112)]
CHECKPOINTS = [(1,38,31,40,30),(2,84,27,86,26),(3,121,27,123,26)]


def geometry():
    game = np.zeros((H,W,2),dtype=np.uint8)
    game[0,:,0]=3;game[44:,:,0]=3;game[:,:2,0]=3;game[:,174:,0]=3
    for left,right,floor in FLOORS:game[floor:44,left:right+1,0]=3
    game[19:21,94:114,0]=1 # hookable beam, separate from no-hook stage platforms
    game[35,5]=(192,0)
    game[1:36,10,0]=33
    game[1:32,160,0]=34
    tele=np.zeros((H,W,2),dtype=np.uint8)
    for number,x,bottom,ox,oy in CHECKPOINTS:
        tele[1:bottom+1,x]=(number,29)
        tele[oy,ox]=(number,30)
    for left,right in PITS:tele[40:44,left:right+1]=(1,63)
    return game,tele


def build(output=OUTPUT):
    require_version()
    m=twmap.Map.empty('DDNet06')
    m.info.author='The Neon Relay Authors'
    m.info.version='warmup-test-2'
    m.info.credits='Original authored geometry; original Neon Relay code-built artwork'
    m.info.license='Zlib'
    m.info.settings=['sv_solo_server 1']
    image_ids={}
    for kind,name in [('terrain','terrain'),('symbols','symbols'),('sky','atmosphere'),('oil','oil')]:
        image_ids[kind]=len(m.images)
        m.images.new_from_file(str(ROOT/f'data/mapres/neonrelay_learn_{name}.png'))

    def quad(layer,x0,y0,x1,y1,color=(255,255,255,255),uv=None):
        q=layer.quads.new((x0+x1)/2,(y0+y1)/2,x1-x0,y1-y0)
        q.corners=[(x0,y0),(x1,y0),(x0,y1),(x1,y1)]
        q.position=((x0+x1)/2,(y0+y1)/2)
        q.colors=[color]*4
        if uv:q.texture_coords=uv
        return q
    def envelope(name,kind,frames,curve='Linear'):
        index=len(m.envelopes);e=m.envelopes.new(kind);e.name=name;e.synchronized=True
        for time,value in frames:
            point=e.points.new(time);point.content=value;point.curve=curve
        return index
    bg=m.groups.new();bg.name='Sound sky';bg.parallax_x=0;bg.parallax_y=0
    sky=bg.layers.new_quads();sky.name='Atmosphere';sky.image=image_ids['sky']
    quad(sky,-100,-70,100,70)
    waves=bg.layers.new_quads();waves.name='Sound waves'
    drift=envelope('Wave', 'Position',[(0,(0,0,0)),(3000,(0,.4,0)),(6000,(0,0,0))],'Smooth')
    for lane in range(3):
        for x in range(-50,50):
            y=lane*2+math.sin(x*.15+lane)
            q=quad(waves,x,y,x+1,y+.04,(176,108,210,28));q.position_env=drift;q.position_env_offset=lane*500
            corners=q.corners;yn=lane*2+math.sin((x+1)*.15+lane)
            corners[1]=(x+1,yn);corners[3]=(x+1,yn+.04);q.corners=corners
    group=m.groups.new_physics();group.name='Game'
    game_layer=group.layers.new_game(W,H);game,tele=geometry();assign_tiles(game_layer,game)
    tele_layer=group.layers.new_physics('Tele');assign_tiles(tele_layer,tele)

    # Geometry-matched, stationary material. No rectangles pretending to be collision.
    terrain=group.layers.new_tiles(W,H);terrain.name='Stage';terrain.image=image_ids['terrain']
    visual=terrain.tiles
    def solid(x,y):return 0<=x<W and 0<=y<H and game[y,x,0] in (1,3)
    surfaces=[]
    for y in range(H):
        for x in range(W):
            v=game[y,x,0]
            if v not in (1,3):continue
            mask=sum(bit for dx,dy,bit in [(0,-1,1),(1,0,2),(0,1,4),(-1,0,8)] if not solid(x+dx,y+dy))
            visual[y,x,0]=(16 if v==1 else 32)+mask
            if mask&1 and 2<x<174 and y<44 and x%6==0:surfaces.append((x,y))
    assign_tiles(terrain,visual)
    meters=group.layers.new_quads();meters.name='Meters'
    peaks=group.layers.new_quads();peaks.name='Peak motion'
    motion=[]
    for k in range(4):
        motion.append(envelope('Peak '+str(k),'Position',[(0,(0,0,0)),(400,(0,-.55,0)),(1000,(0,0,0))]))
    for x,y in surfaces:
        for c in range(2):
            xx=x+.15+c*.38
            for row,color in enumerate([(216,116,187),(182,116,214),(143,140,213),(102,177,200)]):
                quad(meters,xx,y+.22+row*.18,xx+.23,y+.31+row*.18,(*color,200))
            q=quad(peaks,xx,y+.86,xx+.23,y+.91,(239,222,246,240))
            q.position_env=motion[(x+c)%4];q.position_env_offset=(x%4)*250
    signs=group.layers.new_tiles(W,H);signs.name='Route icons';signs.image=image_ids['symbols']
    marks=signs.tiles
    for x,y,tile in [(10,35,33),(160,31,34),(94,21,5),(113,21,5)]:marks[y,x,0]=tile
    for _,x,bottom,_,_ in CHECKPOINTS:marks[bottom,x,0]=29
    assign_tiles(signs,marks)
    gates=group.layers.new_quads();gates.name='Race gates'
    for x,floor in [(10,36),(160,32)]:
        for xx in (x-.55,x+1.55):quad(gates,xx,floor-4,xx+.08,floor,(119,235,153,170))
        quad(gates,x-.55,floor-4,x+1.63,floor-3.92,(119,235,153,190))
    # Boiling oil is exactly the return-hazard area, not new damage/physics.
    oil=group.layers.new_quads();oil.name='Oil return';oil.image=image_ids['oil']
    frames=[]
    for frame in range(16):
        frames.append(envelope('Oil '+str(frame),'Color',
            [(j*80,(1,1,1,1 if j%16==frame else 0)) for j in range(17)],'Step'))
    for left,right in PITS:
        for y in range(40,44):
            for x in range(left,right+1,2):
                for frame,eid in enumerate(frames):
                    idx=frame if y==40 else frame+16;u=(idx%8)/8;v=(idx//8)/8
                    q=quad(oil,x,y,min(x+2,right+1),y+1,uv=[(u,v),(u+.125,v),(u,v+.125),(u+.125,v+.125)])
                    q.color_env=eid;q.color_env_offset=(x%3)*80
    output=Path(output);output.parent.mkdir(parents=True,exist_ok=True);m.save(str(output))
    return m


if __name__=='__main__':
    build()
    print(OUTPUT)
