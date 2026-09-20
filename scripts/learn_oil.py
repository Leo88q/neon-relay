"""Native boiling-oil visual skin for existing fall hazards. Never creates damage/collision."""
from pathlib import Path
import math
from PIL import Image,ImageDraw
ROOT=Path(__file__).resolve().parent.parent
FRAMES=16
FRAME_MS=80

def pools(m):
    layers=dict(m.items[5]);p=layers[32];w,h=p[4:6]
    game=m.raws[p[14]][::4]
    front=m.raws[layers[33][20]][::4]
    tele=m.raws[layers[35][18]][1::2]
    # Explicitly exclude safe thaw tiles. A cyan rectangle is NOT necessarily a pit.
    hazard={i for i in range(w*h) if game[i] not in (1,3,11,13,60,61,62) and front[i] not in (11,13,60,61,62)
            and (game[i] in (2,9,12) or front[i] in (2,9,12) or tele[i] in (10,63))}
    surfaces=set();cells=set()
    for y in range(1,h):
        x=0
        while x<w:
            def exposed(xx):
                i=y*w+xx
                return i in hazard and i-w not in hazard and game[i-w] not in (1,3)
            if not exposed(x):x+=1;continue
            start=x
            while x<w and exposed(x):x+=1
            # Narrow vertical ice columns and ceiling traps retain the ice treatment.
            if x-start<3:continue
            for xx in range(start,x):
                surfaces.add(y*w+xx)
                yy=y
                while yy<h and yy*w+xx in hazard:
                    cells.add(yy*w+xx);yy+=1
    return cells,surfaces

def build():
    atlas=Image.new('RGBA',(1024,1024))
    # Sixteen genuinely different fluid frames, not a brightness-only animation.
    for frame in range(FRAMES):
        t=frame/FRAMES;im=Image.new('RGBA',(128,128));d=ImageDraw.Draw(im)
        for x in range(128):
            surface=round(9+3*math.sin(x*math.tau/128+t*math.tau)+2*math.sin(x*math.tau/64-t*math.tau))
            for y in range(surface,128):
                depth=(y-surface)/128
                swirl=math.sin(x*.08+y*.11-t*math.tau)*4
                d.point((x,y),fill=(int(126-55*depth+swirl),int(65-39*depth+swirl*.5),int(21-10*depth),240))
            d.line((x,surface,x,surface+3),fill=(255,191,69,245))
            d.line((x,surface+4,x,surface+7),fill=(211,127,34,220))
        for k in range(7):
            phase=(t+k*.173)%1;cx=12+(k*37)%104
            cy=108-phase*94;r=3+phase*7
            if phase<.8:
                d.ellipse((cx-r,cy-r,cx+r,cy+r),fill=(93,42,13,240),outline=(225,145,45,230),width=2)
                d.arc((cx-r+2,cy-r+2,cx+r-2,cy+r-2),190,270,fill=(255,218,125,245),width=2)
            else:
                # Expanding broken crown + droplets: distinct popping/splash stage.
                spread=(phase-.8)*45
                d.arc((cx-9-spread,8,cx+9+spread,19),5,175,fill=(250,186,73,220),width=2)
                for direction in (-1,1):
                    px=cx+direction*(7+spread);py=7-6*math.sin((phase-.8)*math.pi/.2)
                    d.ellipse((px-2,py,px+2,py+4),fill=(255,208,100,220))
        atlas.paste(im,((frame%8)*128,(frame//8)*128))
    # Deep liquid has internal flow frames but no second artificial waterline.
    for frame in range(FRAMES):
        im=Image.new('RGBA',(128,128),(78,31,12,238));d=ImageDraw.Draw(im);t=frame/FRAMES
        for k in range(6):
            x=(k*29+17)%128;y=(k*43-int(t*128))%128
            d.ellipse((x-6,y-8,x+6,y+8),outline=(174,96,30,160),width=2)
        idx=frame+16;atlas.paste(im,((idx%8)*128,(idx//8)*128))
    path=ROOT/'data/mapres/neonrelay_learn_oil.png';atlas.save(path)
    return path

def add(m,env,quad,quads_at,image):
    import struct
    cells,surfaces=pools(m);w=dict(m.items[5])[32][4]
    envelopes=[]
    for frame in range(FRAMES):
        frames=[(j*FRAME_MS,[1024,1024,1024,1024 if j%FRAMES==frame else 0]) for j in range(FRAMES+1)]
        eid=env('Oil frame '+str(frame),4,frames)
        # Step sampling selects exactly one frame, avoiding blended/doubled bubbles.
        desc=dict(m.items[3])[eid];points=dict(m.items[6])[0]
        for n in range(desc[2],desc[2]+desc[3]):points[n*6+1]=0
        envelopes.append(eid)
    quads=[]
    # Merge deep horizontal runs: bounded draw count, while the surface keeps detailed cells.
    runs=[]
    for y in range(dict(m.items[5])[32][5]):
        x=0
        while x<w:
            i=y*w+x
            if i not in cells:x+=1;continue
            top=i in surfaces;start=x;x+=1
            limit=2 if top else 4
            while x<w and y*w+x in cells and ((y*w+x in surfaces)==top) and x-start<limit:x+=1
            runs.append((start,y,x-start,top))
    for x,y,width,top in runs:
        for frame,eid in enumerate(envelopes):
            q=list(struct.unpack('<38i',quad(x*32,y*32,(x+width)*32,(y+1)*32,colour=eid,phase=(x//3%4)*FRAME_MS)))
            idx=frame if top else frame+16;u=idx%8*128;v=idx//8*128
            q[26:34]=[u,v,u+128,v,u,v+128,u+128,v+128]
            quads.append(struct.pack('<38i',*q))
    quads_at(50,quads,image,'Boiling oil')
    return {'cells':len(cells),'surface_cells':len(surfaces),'quads':len(quads),'frames':FRAMES,'period_ms':FRAMES*FRAME_MS,
            'semantics':'Existing freeze / evil-return fall hazards; no new burn damage. Safe thaw and narrow ice columns excluded.'}

if __name__=='__main__':build()
