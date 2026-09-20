#!/usr/bin/env python3
"""Clearly-labelled offline layer preview. Not a native client capture or play test."""
import argparse,math,struct
from pathlib import Path
from PIL import Image,ImageDraw,ImageFont
from datafile_v4 import read
ROOT=Path(__file__).resolve().parent.parent

def render(output):
    m=read(ROOT/'data/maps/LearnToPlay Sound Heights.map');layers=dict(m.items[5]);images={}
    for i,p in m.items[2]:
        if not p[3]:images[i]=Image.frombytes('RGBA',(p[1],p[2]),m.raws[p[5]])
    W,H=1120,448;left,top=345*32,12*32
    envs=dict(m.items[3]);points=dict(m.items[6])[0];cached={}
    def evaluate(eid,time):
        key=(eid,time)
        if key in cached:return cached[key]
        p=envs[eid];frames=[points[j*6:j*6+6] for j in range(p[2],p[2]+p[3])]
        t=time%frames[-1][0] if frames[-1][0] else 0
        for a,b in zip(frames,frames[1:]):
            if a[0]<=t<b[0]:
                mix=0 if a[1]==0 else (t-a[0])/(b[0]-a[0])
                result=[(a[k]+(b[k]-a[k])*mix)/1024 for k in range(2,6)]
                cached[key]=result;return result
        return [v/1024 for v in frames[0][2:]]
    prepared=[]
    for lid in [23,24,37,38,39,*range(40,51)]:
        p=layers[lid];image=p[6] if p[1]==3 else p[13];tex=images.get(image)
        if p[1]==3:
            quads=[]
            for off in range(0,len(m.raws[p[5]]),152):
                q=struct.unpack_from('<38i',m.raws[p[5]],off)
                x,y=q[0]//1024-left,q[1]//1024-top;w,h=(q[2]-q[0])//1024,(q[5]-q[1])//1024
                if x+w<0 or y+h+32<0 or x>W or y-32>H or w<=0 or h<=0:continue
                if tex:
                    uv=q[26:34];box=(uv[0]*tex.width//1024,uv[1]*tex.height//1024,uv[2]*tex.width//1024,uv[5]*tex.height//1024)
                    sprite=tex.crop(box).resize((w,h),Image.Resampling.LANCZOS)
                else:sprite=Image.new('RGBA',(w,h),tuple(q[10:14]))
                quads.append((q,x,y,sprite))
            prepared.append(('quads',quads))
        else:
            plate=Image.new('RGBA',(W,H));w,h=p[4:6];raw=m.raws[p[14]]
            for y in range(top//32,min(h,(top+H)//32+1)):
                for x in range(left//32,min(w,(left+W)//32+1)):
                    i=(y*w+x)*4;v=raw[i]
                    if not v:continue
                    tile=tex.crop((v%16*64,v//16*64,v%16*64+64,v//16*64+64)).resize((32,32),Image.Resampling.LANCZOS)
                    f=raw[i+1]
                    if f&1:tile=tile.transpose(Image.Transpose.FLIP_TOP_BOTTOM)
                    if f&2:tile=tile.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
                    if f&8:tile=tile.transpose(Image.Transpose.ROTATE_270)
                    plate.alpha_composite(tile,(x*32-left,y*32-top))
            prepared.append(('tiles',plate))
    frames=[];font=ImageFont.truetype(str(ROOT/'data/fonts/DejaVuSans.ttf'),16)
    for time in range(0,1280,80):
        scene=Image.open(ROOT/'data/mapres/neonrelay_learn_atmosphere.png').convert('RGBA').resize((W,H))
        for kind,content in prepared:
            if kind=='tiles':scene.alpha_composite(content);continue
            for q,x,y,sprite in content:
                alpha=q[13]/255
                if q[-2]>=0:alpha*=evaluate(q[-2],time+q[-1])[3]
                if alpha<=0:continue
                dx=dy=0
                if q[-4]>=0:dx,dy,*_=evaluate(q[-4],time+q[-3])
                spr=sprite.copy();spr.putalpha(spr.getchannel('A').point(lambda v:round(v*alpha)))
                scene.alpha_composite(spr,(round(x+dx),round(y+dy)))
        frame=Image.new('RGB',(W,H+62),(11,8,22));frame.paste(scene,(0,62));d=ImageDraw.Draw(frame)
        d.text((20,10),'SOUND / NEON  •  КИПЯЩЕЕ МАСЛО',font=font,fill=(233,201,237))
        d.text((20,35),'Предпросмотр слоёв карты и цикла анимации — не запись нативного клиента.',font=font,fill=(169,149,187))
        frames.append(frame)
    output=Path(output);output.parent.mkdir(parents=True,exist_ok=True)
    frames[0].save(output.with_suffix('.png'))
    frames[0].save(output,save_all=True,append_images=frames[1:],duration=80,loop=0,disposal=2)

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('output');render(p.parse_args().output)
