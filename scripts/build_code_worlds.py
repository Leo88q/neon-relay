#!/usr/bin/env python3
"""Deterministic original map materials. Pure code; no generated image inputs."""
from pathlib import Path
import colorsys, math, random
from PIL import Image, ImageDraw, ImageFilter
from world_palette import PORTAL,RACE
ROOT=Path(__file__).resolve().parent.parent
OUT=ROOT/'data/mapres'
STYLES=('sound','folds','circuit','chrome')

def rgb(h,s,l):
    return tuple(round(v*255) for v in colorsys.hls_to_rgb((h%360)/360,l,s))

def tile(style,mask,nohook=False,depth=0):
    im=Image.new('RGBA',(64,64));d=ImageDraw.Draw(im)
    for y in range(64):
        if style=='sound': c=rgb(315-y*2,.65,.10+(64-y)*.001)
        elif style=='folds': c=(176+y//7,92+y//8,66+y//10)
        elif style=='circuit': c=(8,49-y//4,43-y//5)
        else:
            v=int(120+95*math.cos((depth*64+y)/640*math.pi*2)+10*math.sin(y*.03));c=(max(15,v-15),max(20,v-2),min(255,v+25))
        d.line((0,y,63,y),fill=(*c,255))
    if style=='sound':
        for x in range(5,64,14):
            for y in range(7,61,9):
                d.rounded_rectangle((x,y,x+8,y+5),1,fill=(*rgb(315-depth*13-y*.12,.78,.48-y*.001),255))
                d.line((x+1,y,x+7,y),fill=(*rgb(315-depth*13,.65,.75),150))
    elif style=='folds':
        for x in range(0,64,16):
            d.polygon([(x,0),(x+8,0),(x+8,64),(x,64)],fill=(230,145,103,255))
            d.line((x+8,0,x+8,63),fill=(136,66,49,255))
        r=random.Random(341)
        for _ in range(450):
            x,y=r.randrange(64),r.randrange(64);v=r.randrange(135,210)
            d.point((x,y),fill=(v,int(v*.65),int(v*.43),255))
    elif style=='circuit':
        for k in range(3):
            y=16+k*15;pts=[(0,y),(18,y),(26,y-8),(45,y-8),(53,y),(64,y)]
            d.line(pts,fill=(169,122,50,255),width=2)
            d.ellipse((41,y-12,48,y-5),outline=(231,187,83,255),width=2)
        d.rounded_rectangle((9,31,24,45),2,fill=(6,24,25,255),outline=(70,121,109,255))
    else:
        sheen=Image.new('RGBA',im.size);sd=ImageDraw.Draw(sheen)
        for x in range(64):sd.line((x,0,x,63),fill=(*rgb(220+x*2,.8,.7),35))
        im=Image.alpha_composite(im,sheen);d=ImageDraw.Draw(im)
    edge=(255,206,126,255) if nohook else {'sound':(255,185,235,255),'folds':(255,224,168,255),'circuit':(111,240,203,255),'chrome':(248,245,255,255)}[style]
    # Border only at exposed geometry; no artificial grid lines inside terrain.
    for bit,line in [(1,(0,1,63,1)),(2,(62,0,62,63)),(4,(0,62,63,62)),(8,(1,0,1,63))]:
        if mask&bit:d.line(line,fill=edge,width=3)
    if nohook:
        for x in range(-32,64,20):d.line((x,64,x+64,0),fill=(215,150,53,255),width=3)
    if mask&1:
        if style=='folds':
            for x in range(4,60,10):d.line((x,7,x+5,7),fill=(255,223,185,255),width=1)
        if style=='circuit':
            for x in range(5,61,13):d.rectangle((x,5,x+6,10),fill=(230,185,88,255))
    return im

def atlas(style):
    im=Image.new('RGBA',(1024,1024))
    for nohook in (False,True):
        for mask in range(16):
            idx=(32 if nohook else 16)+mask
            im.paste(tile(style,mask,nohook),((idx%16)*64,(idx//16)*64))
    if style in ('sound','chrome'):
        for depth in range(10):
            for mask in range(16):
                idx=80+depth*16+mask
                im.paste(tile(style,mask,depth=depth),((idx%16)*64,(idx//16)*64))
    for idx in range(64,70):
        t=Image.new('RGBA',(64,64));d=ImageDraw.Draw(t)
        if idx==64:
            d.rectangle((0,28,63,63),fill=(72,17,42,255))
            for x in range(0,64,16):d.polygon([(x,29),(x+8,5),(x+16,29)],fill=(255,80,119,255))
        elif idx in (65,66):
            d.line((12,8,12,62),fill=(246,227,182,255),width=3)
            d.polygon([(14,8),(53,8),(43,25),(14,25)],fill=(*RACE,255))
            if idx==66:
                for x in range(16,44,8):d.rectangle((x,10,x+3,14),fill=(80,53,40,255))
        elif idx==67:
            d.polygon([(32,8),(48,29),(32,50),(16,29)],outline=(252,202,104,255),width=3)
        else:
            col=(*PORTAL,255)
            for j in (4,10,16):d.ellipse((j,j,63-j,63-j),outline=col,width=2)
            d.line((22,32,42,32),fill=col,width=3)
            d.line((36,26,42,32,36,38),fill=col,width=3)
        im.paste(t,((idx%16)*64,(idx//16)*64))
    im.save(OUT/f'neonrelay_{style}_tiles.png')

def backgrounds(style):
    w,h=1536,768
    im=Image.new('RGB',(w,h));d=ImageDraw.Draw(im)
    palettes={'sound':((16,7,37),(49,19,65)),'folds':((248,227,185),(228,168,133)), 'circuit':((4,12,20),(13,40,42)), 'chrome':((189,177,211),(234,200,217))}
    a,b=palettes[style]
    for y in range(h):
        d.line((0,y,w,y),fill=tuple(round(a[k]+(b[k]-a[k])*y/h) for k in range(3)))
    r=random.Random(381)
    if style=='chrome':
        # Domain-warped trigonometric interference baked to PNG, not live GLSL.
        import numpy as np
        yy,xx=np.mgrid[0:h,0:w];u=xx/w*6;v=yy/h*4
        f=np.sin(u+np.sin(v*1.8))+.5*np.cos(v*2+np.sin(u*1.3))
        arr=np.stack([180+47*np.cos(f*1.5+i*1.2) for i in range(3)],axis=-1).clip(0,255).astype('uint8')
        im=Image.fromarray(arr);d=ImageDraw.Draw(im)
        for i in range(16):
            x,y=r.randrange(w),r.randrange(h);rad=r.randrange(18,90)
            d.ellipse((x-rad,y-rad,x+rad,y+rad),outline=(231,234,249),width=2)
    elif style=='folds':
        for rad,c in [(115,(224,158,82)),(99,(244,188,99)),(79,(252,216,146))]:d.ellipse((1100-rad,190-rad,1100+rad,190+rad),fill=c)
        for base,amp,col in [(570,180,(210,136,112)),(720,170,(132,169,148))]:
            for x in range(-150,w,140):
                d.polygon([(x,base),(x+75,base-amp),(x+150,base),(x+150,h),(x,h)],fill=col)
                d.polygon([(x+75,base-amp),(x+150,base),(x+150,h),(x+75,h)],fill=tuple(int(c*.9) for c in col))
    elif style=='sound':
        for j in range(3):
            pts=[(x,270+j*55+math.sin(x*.007+j)*35+math.sin(x*.013)*12) for x in range(0,w,3)]
            d.line(pts,fill=[(66,69,111),(124,57,114),(75,107,130)][j],width=2)
        for x in range(0,w,22):
            height=int(45+85*(.5+.5*math.sin(x*.018))*(.5+.5*math.cos(x*.031)))
            d.rectangle((x,h-height,x+13,h),fill=(57,35,80))
    else:
        for _ in range(60):
            x,y=r.randrange(w),r.randrange(h);length=r.randrange(30,180)
            d.line([(x,y),(x+length,y),(x+length+22,y-22)],fill=(20,53,58),width=2)
    im.save(OUT/f'neonrelay_{style}_sky.png')
    mid=Image.new('RGBA',(1024,512));d=ImageDraw.Draw(mid)
    for i in range(12):
        x=i*90-30;top=r.randrange(120,350)
        if style=='circuit':
            d.rounded_rectangle((x,top,x+60,512),12,fill=(10,36,44,210),outline=(45,85,84,220),width=2)
            for y in range(top+20,500,25):d.rectangle((x+9,y,x+30,y+3),fill=(114,170,143,160))
        elif style=='folds':
            d.polygon([(x,512),(x+45,top),(x+90,512)],fill=(131,99,77,80))
        elif style=='sound':
            for y in range(top,512,14):d.rectangle((x,y,x+12,y+8),fill=(171,87,169,80))
        else:d.ellipse((x,top,x+50,top+50),outline=(252,240,255,75),width=2)
    mid.save(OUT/f'neonrelay_{style}_mid.png')
    glow=Image.new('RGBA',(128,128));d=ImageDraw.Draw(glow)
    for radius in range(63,0,-1):
        alpha=int(75*(1-radius/64)**2);d.ellipse((64-radius,64-radius,64+radius,64+radius),fill=(255,187,217,alpha))
    glow.save(OUT/'neonrelay_pulse.png')

def main():
    OUT.mkdir(exist_ok=True)
    for style in STYLES:atlas(style);backgrounds(style)

if __name__=='__main__':main()
