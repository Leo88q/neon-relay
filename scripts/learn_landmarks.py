"""Holographic Sound landmarks anchored to race/teleporter regions, no collision."""
import math
from PIL import Image, ImageDraw
from world_palette import PORTAL,RACE
from learn_visibility import ROOT,OUT

def build():
    atlas=Image.new('RGBA',(1024,1024))
    for style in range(4):
        im=Image.new('RGBA',(512,512));d=ImageDraw.Draw(im)
        if style==2:
            # Recessive acoustic-bank silhouette, not masonry or climbable-looking ruins.
            for k,x in enumerate(range(58,450,32)):
                height=80+int(170*(.5+.5*math.sin(k*.75)))
                d.rounded_rectangle((x,480-height,x+13,480),4,fill=(40,24,56,145))
                for y in range(485-height,480,24):d.line((x+3,y,x+10,y),fill=(91,52,105,95),width=2)
        else:
            c=PORTAL if style==0 else RACE
            if style==0:
                for width,alpha in [(30,12),(18,25),(10,65),(4,235)]:
                    d.ellipse((137,94,375,464),outline=(*c,alpha),width=width)
                d.arc((152,110,360,448),210,345,fill=(*c,255),width=7)
                d.arc((152,110,360,448),30,155,fill=(*c,180),width=4)
                for x,y in [(150,180),(355,355),(256,98)]:
                    d.ellipse((x-7,y-7,x+7,y+7),fill=(*c,240))
            else:
                for x in (141,365):
                    d.rounded_rectangle((x-13,156,x+13,476),10,fill=(24,19,39,240))
                    d.line((x,166,x,465),fill=(*c,220),width=4)
                d.arc((141,61,365,266),180,360,fill=(*c,150),width=5)
                d.line((173,151,333,151),fill=(*c,90),width=2)
                if style==3:
                    for x in range(191,320,18):
                        for y in (105,123):
                            if (x//18+y//18)%2:d.rectangle((x,y,x+14,y+14),fill=(*c,230))
                else:d.polygon([(239,106),(268,121),(239,136)],fill=(*c,235))
            d.ellipse((109,467,404,487),outline=(*c,95),width=3)
        atlas.paste(im,((style%2)*512,(style//2)*512))
    atlas.save(OUT/'neonrelay_learn_landmarks.png')

def regions(values,w,h,types):
    """Connect short interruptions in vertical trigger lines (START/TP alternation)."""
    remaining={i for i,v in enumerate(values) if v in types};out=[]
    while remaining:
        seed=min(remaining);remaining.remove(seed);todo=[seed];cells=[]
        while todo:
            i=todo.pop();cells.append(i)
            x,y=i%w,i//w
            for dx,dy in [(1,0),(-1,0),(0,1),(0,-1),(0,2),(0,-2),(0,3),(0,-3),(0,4),(0,-4)]:
                xx,yy=x+dx,y+dy;j=yy*w+xx
                if 0<=xx<w and 0<=yy<h and j in remaining:
                    remaining.remove(j);todo.append(j)
        out.append((min(i%w for i in cells),min(i//w for i in cells),max(i%w for i in cells),max(i//w for i in cells)))
    return out

if __name__=='__main__':build()
