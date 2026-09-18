#!/usr/bin/env python3
"""Non-destructive LearnToPlay -> LearnToPlay Sound. Preserve original mechanics."""
from pathlib import Path
import math,struct,json,hashlib
from PIL import Image
from datafile_v4 import read
from map_format import pack_name,quad_rect
ROOT=Path(__file__).resolve().parent.parent
SOURCE=ROOT/'data/maps/LearnToPlay.map'
OUTPUT=ROOT/'data/maps/LearnToPlay Sound.map'

def transform(source=SOURCE,output=OUTPUT):
    m=read(source)
    layers=dict(m.items[5]);groups=dict(m.items[4])
    assert len(layers)==55 and layers[32][6]==1, 'Unexpected source map; audit layout before transforming'
    assert all(p[0]<3 for _,p in m.items[3]), 'Bezier envelope format needs explicit conversion'
    game=layers[32];w,h=game[4:6];tiles=m.raws[game[14]]
    assert len(tiles)==w*h*4
    grid=tiles[::4]
    original_count=len(m.raws)
    hint_indices=set(range(16,64))|set(range(192,208))
    def embedded(name,path):
        im=Image.open(path).convert('RGBA')
        return m.item(2,[1,im.width,im.height,0,m.string(name),m.raw(im.tobytes())])
    img=embedded('neonrelay_sound_tiles',ROOT/'data/mapres/neonrelay_sound_tiles.png')
    sky=embedded('neonrelay_sound_sky',ROOT/'data/mapres/neonrelay_sound_sky.png')
    points=dict(m.items[6])[0]
    def env(name,channels,frames):
        start=len(points)//6
        for time,values in frames: points.extend([time,1]+list(values)+[0]*(4-len(values)))
        return m.item(3,[2,channels,start,len(frames)]+pack_name(name,8)+[1])
    def quad(x,y,x1,y1,color=(255,255,255,255),position=-1,colour=-1,phase=0):
        q=list(struct.unpack('<38i',quad_rect(x,y,x1,y1,color)))
        q[-4:]=[position,phase,colour,phase]
        return struct.pack('<38i',*q)
    def quads_at(index,quads,image,name):
        layers[index][:]=[0,3,0,2,len(quads),m.raw(b''.join(quads)),image]+pack_name(name)
    # Retain tutorial cards (6..22), map title (25), authors' attribution (54).
    # Source glyphs remain useful instructions; ornamental blocks/faces are retired.
    for i in (23,24,26,27,28,29,30,31,53):quads_at(i,[],-1,'Retired art')
    for i,p in layers.items():
        if p[1]==2 and not p[6] and p[13]==32:
            raw=bytearray(m.raws[p[14]])
            for j in range(0,len(raw),4):
                if raw[j] not in hint_indices:raw[j:j+4]=b'\0'*4
                else:raw[j+2]=0 # skip metadata belongs to the old visual layout
            p[14]=m.raw(raw);p[7:11]=[188,211,237,230]
    # Flat stationary surfaces; animated LED faces never move their collision edge.
    visual=bytearray(w*h*4);bars=[];peaks=[];surfaces=[]
    def solid(x,y):return 0<=x<w and 0<=y<h and grid[y*w+x] in (1,3)
    for y in range(h):
        for x in range(w):
            v=grid[y*w+x]
            if v not in (1,3):continue
            mask=sum(bit for dx,dy,bit in [(0,-1,1),(1,0,2),(0,1,4),(-1,0,8)] if not solid(x+dx,y+dy))
            depth=0
            while depth<9 and solid(x,y-depth-1):depth+=1
            visual[(y*w+x)*4]=(32+mask) if v==3 else (80+16*depth+mask)
            if mask&1 and x%3==0 and v==1:surfaces.append((x,y))
    # 8 independent envelopes: light and peak position share the same 120 BPM clock.
    motion=[]
    segment_envelopes=[]
    for k in range(8):
        frames=[]
        levels=[]
        for j in range(33):
            phase=j/32
            kick=math.exp(-((phase*4)%1)*5)
            level=min(1,max(0,.22+.3*(.5+.5*math.sin(phase*math.tau+k*.81))+.45*kick))
            frames.append((round(phase*2000),[0,round(-20*level*1024),0]))
            levels.append((round(phase*2000),level))
        frames[-1]=(2000,frames[0][1])
        motion.append(env('LED peak '+str(k),3,frames))
        levels[-1]=(2000,levels[0][1])
        segment_envelopes.append([env(f'LED {k} segment {row}',4,
            [(time,[1024,1024,1024,round(max(0,min(1,(level-(4-row)/5)*5))*1024)]) for time,level in levels]) for row in range(5)])
    beat=env('Bass light',4,[(j*25,[1024,1024,1024,round(280+180*(math.exp(-j/20*5) if j<20 else 1))]) for j in range(21)])
    for x,y in surfaces:
        # Sparse animated overlays; static material fills intermediate columns.
        for col in range(2):
            xx=x*32+4+col*13;yy=y*32
            k=(x+y+col)%8
            bars.append(quad(xx-1,yy+5,xx+9,yy+31,(5,10,25,250)))
            for row,c in enumerate([(240,105,215),(205,111,229),(157,126,239),(89,163,225),(65,209,208)]):
                bars.append(quad(xx,yy+6+row*5,xx+8,yy+9+row*5,(*c,230),colour=segment_envelopes[k][row]))
            peaks.append(quad(xx,yy+29,xx+8,yy+31,(245,240,255,230),position=motion[k]))
    # Replace existing decorative slots without renumbering any original item.
    template=[0,2,0,3,w,h,0,255,255,255,255,-1,0,img,m.raw(visual)]+pack_name('LED terrain')+[-1]*5
    layers[37][:]=template
    quads_at(38,bars,-1,'LED segments');quads_at(39,peaks,-1,'Moving peaks')
    # Background and slowly travelling light waves use native position envelopes.
    quads_at(0,[quad(-1600,-1000,1600,1000)],sky,'Sound sky')
    wave=env('Wave drift',3,[(0,[0,0,0]),(3000,[0,14*1024,0]),(6000,[0,0,0])])
    waves=[]
    for lane in range(3):
        for x in range(-1500,1500,12):
            yy=round(-120+lane*45+math.sin(x*.008+lane)*24)
            waves.append(quad(x,yy,x+12,yy+2,[(90,155,210,45),(220,100,200,45),(161,145,222,35)][lane],position=wave,phase=lane*350))
    quads_at(1,waves,-1,'Drifting waves')
    # Mid-distance spectrum anchored in the background group, no collision.
    spectrum=[]
    for x in range(-1500,1500,24):
        height=round(30+60*(.5+.5*math.sin(x*.021)))
        spectrum.append(quad(x,200-height,x+10,200,(145,88,188,48),position=motion[(x//24)%8],colour=beat))
    quads_at(2,spectrum,-1,'Spectrum')
    # Early slots were old decorative shadows/circuit scribbles. Remove them;
    # keep all original gameplay layers, custom items and instructions unchanged.
    for i in (3,4,5):quads_at(i,[],-1,'Retired art')
    m.save(output)
    print(f'{output}: {len(surfaces)*2} animated LED columns; {len(m.items[3])-6} new envelopes; {original_count} original raw blocks retained')
    return m

if __name__=='__main__':transform()
