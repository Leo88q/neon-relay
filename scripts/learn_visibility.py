"""Explicit visual coverage for LearnToPlay game/front/tele/speed/switch layers."""
from pathlib import Path
import math
import struct
from collections import Counter
from PIL import Image,ImageDraw,ImageFont
import numpy as np
ROOT=Path(__file__).resolve().parent.parent
OUT=ROOT/'data/mapres'
FAMILIES=['freeze','deep','thaw','stop','tele','evil','switch','speed','through']
COLORS=[(111,215,251),(187,139,255),(91,237,166),(255,195,89),(152,173,255),(244,126,182),(255,205,117),(76,229,203),(133,171,188)]

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
                if not family or family in ('stop','switch','speed') or (name=='tele' and v in (26,27,30)) or (x%3==0 and y%3==0):
                    glyph[i*4]=v
                    if family=='stop':glyph[i*4+1]=flags
                    if name=='speed':
                        angle=struct.unpack_from('<h',raw,i*stride+4)[0]%360
                        assert angle in (0,90,180,270), 'Add exact visual support for non-cardinal boosts'
                        glyph[i*4+1]={0:0,90:8,180:3,270:11}[angle]
        audit[name]={str(v):{'count':n,'visual':routes[v]} for v,n in sorted(counts.items())}
        result[name]=(bound,glyph)
    return result,audit

def build():
    OUT.mkdir(exist_ok=True)
    atlas=Image.new('RGBA',(1024,1024))
    for nohook in (False,True):
        for mask in range(16):
            t=Image.new('RGBA',(64,64),(43,47,63,255) if nohook else (32,64,79,255));d=ImageDraw.Draw(t)
            # Solid matte material with broad bevels, not yellow crosshatching.
            for y in range(64):
                c=(46+y//8,49+y//8,64+y//8) if nohook else (30+y//10,61+y//10,76+y//10)
                d.line((0,y,63,y),fill=(*c,255))
            edge=(255,205,113,255) if nohook else (153,238,247,255)
            for bit,line in [(1,(0,1,63,1)),(2,(62,0,62,63)),(4,(0,62,63,62)),(8,(1,0,1,63))]:
                if mask&bit:d.line(line,fill=edge,width=4)
            if nohook and mask:
                # A restrained identification notch. Never overwrite the collision outline.
                d.line((24,12,40,12),fill=(211,172,106,255),width=3)
                d.line((24,17,40,17),fill=(211,172,106,255),width=2)
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
    symbols=Image.new('RGBA',(1024,1024));font=ImageFont.truetype(str(ROOT/'data/fonts/DejaVuSans.ttf'),15)
    labels={5:'HOOK',9:'ICE',11:'THAW',12:'DEEP',13:'THAW',17:'∞ H',18:'H −',21:'SOLO',22:'TEAM',23:'SW−',24:'SW+',25:'SW−',26:'IN',27:'OUT',28:'→',29:'TP',30:'OUT',33:'START',34:'END',60:'↓',61:'↕',62:'STOP',63:'TP!',89:'J −',90:'JET −',105:'∞ J',106:'JET +',190:'HUD',191:'HUD',210:'SW',211:'SW',212:'SW',240:'DOOR'}
    for v in range(1,256):
        t=Image.new('RGBA',(64,64));d=ImageDraw.Draw(t)
        family=kind('game',v);c=COLORS[FAMILIES.index(family)] if family else (186,201,220)
        if v in (26,27,29,30,63):c=COLORS[5 if v==63 else 4]
        text=labels.get(v, str(v-34) if 35<=v<=59 else str(v))
        d.rounded_rectangle((4,19,59,45),5,fill=(8,15,28,215),outline=(*c,220),width=2)
        d.text((32,32),text,font=font,anchor='mm',fill=(*c,255))
        symbols.paste(t,((v%16)*64,(v//16)*64))
    symbols.save(OUT/'neonrelay_learn_symbols.png')
    # Seamless, low-contrast atmospheric texture; no photo rights/tiling artifacts.
    n=768;yy,xx=np.meshgrid(np.linspace(0,math.tau,n),np.linspace(0,math.tau,n),indexing='ij')
    cloud=np.sin(xx+np.sin(yy*2))*.45+np.cos(yy+np.sin(xx*3))*.3+np.sin(xx*4+yy*3)*.12
    img=np.stack([15+cloud*3,21+cloud*4,35+cloud*7],axis=-1).clip(0,255).astype('uint8')
    # Explicit identical opposite edges for lossless tiling.
    img[-1]=img[0];img[:,-1]=img[:,0]
    Image.fromarray(img).save(OUT/'neonrelay_learn_atmosphere.png')

if __name__=='__main__':build()
