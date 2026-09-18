"""Native background architecture anchored to real race/teleporter regions, no collision."""
from PIL import Image, ImageDraw
from world_palette import PORTAL,RACE
from learn_visibility import ROOT,OUT

def build():
    atlas=Image.new('RGBA',(1024,1024))
    for style in range(4):
        im=Image.new('RGBA',(512,512));d=ImageDraw.Draw(im)
        def block(x,y,w,h,base=(49,61,80)):
            d.rectangle((x,y,x+w,y+h),fill=(*base,255))
            d.polygon([(x,y),(x+9,y-9),(x+w+9,y-9),(x+w,y)],fill=tuple(v+17 for v in base)+(255,))
            d.polygon([(x+w,y),(x+w+9,y-9),(x+w+9,y+h-9),(x+w,y+h)],fill=tuple(v-13 for v in base)+(255,))
            d.line((x+3,y+3,x+w-3,y+3),fill=tuple(v+29 for v in base)+(255,),width=2)
        if style==2:
            # Dark distant stepped towers: never use the playable surface's bright edge.
            for x,height in [(36,155),(126,264),(216,355),(306,210),(396,104)]:
                for y in range(480-height,480,32):block(x,y,63,29,(25,34,49))
                d.rectangle((x+22,488-height,x+30,512-height),fill=(57,73,92,255))
        else:
            c=PORTAL if style==0 else RACE
            for y in range(174,458,47):
                for x in (95,365):block(x,y,44,43)
            for x,y in [(126,135),(169,98),(212,78),(255,78),(298,98),(341,135)]:block(x,y,43,43)
            for x in (77,350):block(x,458,82,24)
            d.line((148,446,148,190,192,143,222,125,293,125,352,189,352,446),fill=(*c,245),width=7)
            d.line((159,430,159,196,201,154,226,139,288,139,338,197,338,430),fill=(*c,65),width=3)
            if style==0:
                for inset,a in [(0,125),(23,65),(44,28)]:
                    d.ellipse((180+inset//2,195+inset,326-inset//2,423-inset),outline=(*c,a),width=5)
                d.polygon([(251,52),(273,74),(251,96),(229,74)],fill=(*c,255))
            else:
                d.rectangle((180,187,324,224),fill=(14,32,28,240))
                if style==3:
                    for x in range(183,321,17):
                        for y in (191,208):
                            if (x//17+y//17)%2:d.rectangle((x,y,x+14,y+13),fill=(*c,255))
                else:d.polygon([(235,194),(260,205),(235,216)],fill=(*c,255))
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
