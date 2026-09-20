"""Explicit visual coverage for LearnToPlay game/front/tele/speed/switch layers."""
from pathlib import Path
import math
import struct
from collections import Counter
from PIL import Image,ImageDraw
import numpy as np
from world_palette import ICE,PORTAL,RACE,MECHANISM,NEUTRAL
ROOT=Path(__file__).resolve().parent.parent
OUT=ROOT/'data/mapres'
FAMILIES=['freeze','deep','thaw','stop','tele','evil','switch','speed','through']
COLORS=[ICE,ICE,ICE,MECHANISM,PORTAL,PORTAL,MECHANISM,MECHANISM,NEUTRAL]

def kind(layer,v):
    if layer=='tele':return 'evil' if v in (10,63) else 'tele'
    if layer=='speed':return 'speed'
    if layer=='switch':return 'switch'
    if v in (9,144):return 'freeze'
    if v==12:return 'deep'
    if v in (11,13,145):return 'thaw'
    if v in (60,61,62):return 'stop'
    if v in (5,6,66,67):return 'through'
    return None

def fields(m):
    layers=dict(m.items[5])
    yield 'game',layers[32],m.raws[layers[32][14]],4,0,1
    for name,i,pointer,stride,index,flags in [('front',33,20,4,0,1),('tele',35,18,2,1,None),('speed',34,19,6,2,None),('switch',36,21,4,1,2)]:
        p=layers[i];yield name,p,m.raws[p[pointer]],stride,index,flags

def visual_layers(m):
    audit={};result={}
    for name,p,raw,stride,offset,flag_offset in fields(m):
        w,h=p[4:6];values=raw[offset::stride];bound=bytearray(w*h*4);glyph=bytearray(w*h*4)
        counts=Counter();routes={}
        for y in range(h):
            for x in range(w):
                i=y*w+x;v=values[i]
                if not v:continue
                counts[v]+=1
                if name=='game' and v in (1,3):routes[v]='opaque-terrain';continue
                if name=='game' and v>=192:routes[v]='runtime-entity';continue
                if v in (190,191):routes[v]='render-metadata-no-marker';continue
                family=kind(name,v)
                flags=(raw[i*stride+flag_offset]&11) if flag_offset is not None else 0
                if family:
                    mask=0
                    for dx,dy,bit in [(0,-1,1),(1,0,2),(0,1,4),(-1,0,8)]:
                        xx,yy=x+dx,y+dy
                        if not(0<=xx<w and 0<=yy<h) or kind(name,values[yy*w+xx])!=family:mask|=bit
                    bound[i*4]=1+16*FAMILIES.index(family)+mask
                    # Only the directional stop plate rotates; region edges are in world space.
                    if family=='stop':bound[i*4+1]=flags
                    routes[v]='boundary-and-symbol'
                else:routes[v]='symbol'
                # Large regions use sparse interior markers, not a field of noisy icons.
                if not family or family in ('stop','switch','speed') or (name=='tele' and (v in (26,27,30) or x%3==0)) or (x%3==0 and y%3==0):
                    # A column of mode/start tiles is one visual sign, not repeated labels.
                    repeated=family not in ('freeze','deep','thaw') and any(y+dy<h and values[i+dy*w]==v for dy in range(1,5))
                    glyph[i*4]=v if family in ('stop','speed') or not repeated else 0
                    if family=='stop':glyph[i*4+1]=flags
                    if name=='speed':
                        angle=struct.unpack_from('<h',raw,i*stride+4)[0]%360
                        assert angle in (0,90,180,270), 'Add exact visual support for non-cardinal boosts'
                        glyph[i*4+1]={0:0,90:8,180:3,270:11}[angle]
        audit[name]={str(v):{'count':n,'visual':routes[v]} for v,n in sorted(counts.items())}
        result[name]=(bound,glyph)
    return result,audit

def symbol(v):
    """No fonts, letters or editor labels: shape + consistent functional color."""
    t=Image.new('RGBA',(128,128));d=ImageDraw.Draw(t)
    family=kind('game',v)
    c=COLORS[FAMILIES.index(family)] if family else NEUTRAL
    if v in (26,27,29,30,31,63):c=PORTAL
    if 33<=v<=59:c=RACE
    if v in (23,24,25,28,210,211,212,240):c=MECHANISM
    c=(*c,255)
    # Dark translucent medallion separates icons from terrain without a text plaque.
    d.ellipse((21,21,107,107),fill=(8,15,29,175))
    if v in (9,11,12,13,144,145):
        for a in range(0,360,60):
            a=math.radians(a);dx,dy=math.cos(a),math.sin(a)
            d.line((64,64,64+35*dx,64+35*dy),fill=c,width=5)
            for side in (-1,1):
                d.line((64+23*dx,64+23*dy,64+14*dx-side*9*dy,64+14*dy+side*9*dx),fill=c,width=4)
        if v in (11,13,145):d.line((33,100,97,28),fill=c,width=6)
        if v==12:d.ellipse((18,18,110,110),outline=c,width=3)
    elif v in (26,27,29,30,31,63):
        d.ellipse((35,22,93,106),outline=c,width=6)
        d.arc((47,34,81,94),65,290,fill=c,width=4)
        if v in (26,27,30):
            pts=[(19,64),(58,64),(45,51),(58,64),(45,77)]
            if v in (27,30):pts=[(128-x,y) for x,y in pts]
            d.line(pts,fill=c,width=6)
        if v==63:d.polygon([(59,10),(69,10),(69,17),(59,17)],fill=c)
    elif 33<=v<=59:
        d.line((29,101,29,30,99,30,99,101),fill=c,width=8)
        if v==34:
            for y in range(37,73,12):
                for x in range(39,91,12):
                    if (x//12+y//12)%2:d.rectangle((x,y,x+10,y+10),fill=c)
        else:d.line((48,65,80,65,68,53,80,65,68,77),fill=c,width=6)
    elif v in (21,22):
        for x in ([64] if v==21 else [46,82]):
            d.ellipse((x-11,33,x+11,55),fill=c)
            d.rounded_rectangle((x-15,62,x+15,95),6,fill=c)
    elif v in (28,60,61,62):
        pts=[(31,64),(96,64),(78,45),(96,64),(78,83)]
        if v in (60,61,62):pts=[(128-y,x) for x,y in pts]
        d.line(pts,fill=c,width=7)
        if v!=28:d.line((26,24,102,24),fill=c,width=7)
    elif v in (17,18,5,6,66,67):
        d.line((72,26,72,73),fill=c,width=6)
        d.arc((34,55,74,97),0,180,fill=c,width=6)
        if v==18:d.line((28,100,100,28),fill=c,width=5)
    elif v in (89,90,105,106):
        d.polygon([(64,23),(86,49),(82,84),(46,84),(42,49)],outline=c,width=5)
        d.line((52,91,47,108),fill=c,width=4);d.line((76,91,81,108),fill=c,width=4)
        if v in (89,90):d.line((28,100,100,28),fill=c,width=5)
    else:
        d.rectangle((32,41,96,87),outline=c,width=5)
        d.line((44,64,83,47),fill=c,width=6)
        d.ellipse((36,57,48,69),fill=c)
        if v in (190,191):return Image.new('RGBA',(64,64)) # render-mode metadata, not an obstacle
    return t.resize((64,64),Image.Resampling.LANCZOS)


def build():
    OUT.mkdir(exist_ok=True)
    atlas=Image.new('RGBA',(1024,1024))
    for nohook in (False,True):
        for mask in range(16):
            # Sound stage, not stone blocks: smooth dark shell, sparse acoustic detail.
            base=(31,17,43) if nohook else (23,23,46)
            t=Image.new('RGBA',(64,64),(*base,255));d=ImageDraw.Draw(t)
            for y in range(64):
                c=tuple(v+round(5*math.cos(y/64*math.pi)) for v in base)
                d.line((0,y,63,y),fill=(*c,255))
            for x in (14,30,46):
                d.line((x,24,x,39),fill=(56,38,72,255),width=2)
            edge=(*NEUTRAL,255)
            for bit,line in [(1,(0,1,63,1)),(2,(62,0,62,63)),(4,(0,62,63,62)),(8,(1,0,1,63))]:
                if mask&bit:d.line(line,fill=edge,width=4)
            if mask&1:
                d.line((0,6,63,6),fill=(178,90,157,255) if nohook else (111,112,174,255),width=2)
                if nohook:d.line((0,10,63,10),fill=(84,41,80,255),width=1)
            idx=32+mask if nohook else 16+mask
            atlas.paste(t,((idx%16)*64,(idx//16)*64))
    atlas.save(OUT/'neonrelay_learn_terrain.png')
    boundaries=Image.new('RGBA',(1024,1024))
    for family,c in zip(FAMILIES,COLORS):
        for mask in range(16):
            t=Image.new('RGBA',(64,64),(*c,48) if family in ('freeze','deep') else (0,0,0,0));d=ImageDraw.Draw(t)
            if family=='stop':
                d.line((0,1,63,1),fill=(*c,255),width=5)
                for x in range(8,60,16):d.polygon([(x,8),(x+8,8),(x+4,15)],fill=(*c,220))
            else:
                for bit,line in [(1,(0,1,63,1)),(2,(62,0,62,63)),(4,(0,62,63,62)),(8,(1,0,1,63))]:
                    if mask&bit:d.line(line,fill=(*c,245),width=3)
                if family in ('freeze','deep'):
                    d.line((18,30,25,21,31,35,39,27),fill=(*c,100),width=2)
            idx=1+16*FAMILIES.index(family)+mask
            boundaries.paste(t,((idx%16)*64,(idx//16)*64))
    boundaries.save(OUT/'neonrelay_learn_boundaries.png')
    symbols=Image.new('RGBA',(1024,1024))
    for v in range(1,256):
        symbols.paste(symbol(v),((v%16)*64,(v//16)*64))
    symbols.save(OUT/'neonrelay_learn_symbols.png')
    # Seamless, low-contrast atmospheric texture; no photo rights/tiling artifacts.
    n=768;yy,xx=np.meshgrid(np.linspace(0,math.tau,n),np.linspace(0,math.tau,n),indexing='ij')
    cloud=np.sin(xx+np.sin(yy*2))*.45+np.cos(yy+np.sin(xx*3))*.3+np.sin(xx*4+yy*3)*.12
    img=np.stack([16+cloud*3,11+cloud*3,31+cloud*7],axis=-1).clip(0,255).astype('uint8')
    # Explicit identical opposite edges for lossless tiling.
    img[-1]=img[0];img[:,-1]=img[:,0]
    Image.fromarray(img).save(OUT/'neonrelay_learn_atmosphere.png')

if __name__=='__main__':
    build()
    from learn_landmarks import build as build_landmarks
    build_landmarks()
    from learn_oil import build as build_oil
    build_oil()
