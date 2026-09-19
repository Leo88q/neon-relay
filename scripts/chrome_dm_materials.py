"""v6 final – bright space, visible freeze, large meteors."""
import math
import random
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent

def noise(x, y):
    ix = np.floor(x); iy = np.floor(y); fx = x-ix; fy = y-iy
    def h(a,b): return np.mod(np.sin(a*127.1+b*311.7)*43758.5453, 1)
    u = fx*fx*(3-2*fx); v = fy*fy*(3-2*fy)
    a = h(ix, iy); b = h(ix+1, iy); c = h(ix, iy+1); d = h(ix+1, iy+1)
    return a+(b-a)*u+(c-a)*v+(a-b-c+d)*u*v

def fbm(x, y):
    out = np.zeros_like(x); amp = .5
    for _ in range(5):
        out += amp*noise(x, y); x = x*2.02; y = y*2.02; amp *= .5
    return out

def textures(folder):
    folder = Path(folder)
    rng = random.Random(1337)

    atlas = Image.new('RGBA', (1024,1024), (0,0,0,0))
    for yy in range(8):
        for xx in range(8):
            idx = 1+yy*8+xx
            base_lum = 14 + yy*3
            tile = Image.new('RGBA', (64,64), (base_lum-2, base_lum, base_lum+8, 255))
            d = ImageDraw.Draw(tile)
            for py in range(0,64,8):
                for px in range(0,64,8):
                    if rng.random() < 0.12:
                        col = (18, 28, 52, 255) if rng.random()<0.6 else (22, 34, 62, 255)
                        d.rectangle((px,py,px+6,py+6), fill=col)
            for _ in range(18):
                px = rng.randint(2,61); py = rng.randint(4,61)
                if rng.random() < 0.5:
                    d.point((px,py), fill=(77,227,247,180))
                else:
                    d.point((px,py), fill=(255,46,136,140))
            shade = int(6 + yy*2.2)
            d.rectangle((0,64-shade,63,63), fill=(4,6,16,200))
            if yy==0 or rng.random()<0.35:
                d.line((0,0,63,0), fill=(77,227,247,255), width=3)
                d.line((0,1,63,1), fill=(140,245,255,180), width=1)
            d.line((0,0,0,63), fill=(10,16,32,255), width=2)
            d.line((63,0,63,63), fill=(10,16,32,255), width=2)
            atlas.paste(tile, ((idx%16)*64,(idx//16)*64))
    atlas.save(folder/'chrome.png')

    edges = Image.new('RGBA', (1024,1024), (0,0,0,0))
    for mask in range(1,16):
        tile = Image.new('RGBA', (64,64), (0,0,0,0)); d = ImageDraw.Draw(tile)
        for bit, line, inner in [(1,(0,0,63,0),(0,3,63,3)),(2,(63,0,63,63),(60,0,60,63)),
                                 (4,(0,63,63,63),(0,60,63,60)),(8,(0,0,0,63),(3,0,3,63))]:
            if mask & bit:
                d.line(line, fill=(6,10,22,255), width=5)
                if bit==1:
                    d.line(inner, fill=(77,227,247,220), width=2)
                else:
                    d.line(inner, fill=(30,50,90,200), width=2)
        edges.paste(tile, ((mask%16)*64,(mask//16)*64))
    edges.save(folder/'bevels.png')

    # Bright freeze – visible walls
    freeze_atlas = Image.new('RGBA', (256,256), (0,0,0,0))
    for yy in range(4):
        for xx in range(4):
            tile = Image.new('RGBA', (64,64), (22,48,92,255))
            d = ImageDraw.Draw(tile)
            d.rectangle((0,0,63,63), outline=(77,227,247,255), width=3)
            d.rectangle((2,2,61,61), outline=(140,245,255,200), width=1)
            for i in range(0,64,16):
                d.line((i,0,i,63), fill=(80,140,200,140), width=1)
                d.line((0,i,63,i), fill=(80,140,200,140), width=1)
            d.ellipse((14,14,50,50), fill=(77,227,247,110), outline=(190,250,255,240), width=2)
            d.ellipse((22,22,42,42), fill=(120,240,255,80))
            d.line((32,4,32,60), fill=(77,227,247,180), width=1)
            d.line((4,32,60,32), fill=(77,227,247,180), width=1)
            freeze_atlas.paste(tile, (xx*64, yy*64))
    freeze_atlas.save(folder/'freeze.png')

    # Bright space – photo kept bright
    space_path = ROOT / '.cache/chrome-dm/space_bg.jpg'
    if not space_path.exists():
        photo = Image.new('RGB', (1600,960), (18,24,48))
    else:
        photo = Image.open(space_path).convert('RGB').resize((1600,960), Image.Resampling.LANCZOS)
        dark = Image.new('RGB', photo.size, (12,18,36))
        photo = Image.blend(photo, dark, 0.12)
        arr = np.array(photo).astype(float)
        arr[:,:,0] *= 1.0
        arr[:,:,1] *= 1.12
        arr[:,:,2] *= 1.38
        arr = np.clip(arr*1.4, 0, 255)
        photo = Image.fromarray(arr.astype('uint8'))

    yy, xx = np.mgrid[0:960, 0:1600]; px = xx/290; py = yy/290
    qx = fbm(px, py); qy = fbm(px+4.2, py+1.1)
    f = fbm(px+2.2*qx, py+2.2*qy)

    pal = .5+.5*np.cos(2*math.pi*(f[:,:,None]*1.35+qx[:,:,None]*.55+np.array([0.55,0.65,0.9])))
    veil = pal*.60 + np.array([.18,.26,.50])*.40
    veil *= (.90+.10*f)[:,:,None]
    ribbon = np.exp(-((np.mod(f*3.0,1)-.5)/.045)**2)
    veil = veil*(1-ribbon[:,:,None]*.08)+ribbon[:,:,None]*np.array([0.40,0.92,1.0])*0.60
    veil_img = Image.fromarray(np.clip(veil*255,0,255).astype('uint8'))

    stars = Image.new('RGBA', (1600,960), (0,0,0,0))
    sd = ImageDraw.Draw(stars)
    for _ in range(1500):
        x = rng.randint(0,1599); y = rng.randint(0,959)
        b = rng.randint(200,255)
        sd.point((x,y), fill=(b,b,min(255,b+12), rng.randint(150,255)))
        if rng.random()<0.18:
            sd.ellipse((x-1,y-1,x+1,y+1), fill=(b,b,255,110))
        if rng.random()<0.05:
            sd.ellipse((x-2,y-2,x+2,y+2), fill=(b,b,255,60))

    base = np.array(photo).astype(float)
    veil_arr = np.array(veil_img).astype(float)
    blended = base*0.98 + veil_arr*0.82
    vy, vx = np.mgrid[0:960,0:1600]
    vign = 1 - 0.10*np.sqrt(((vx-800)/800)**2 + ((vy-480)/480)**2)
    blended = blended * vign[:,:,None]
    result = Image.fromarray(np.clip(blended,0,255).astype('uint8')).convert('RGBA')
    result.alpha_composite(stars)
    bloom = result.filter(ImageFilter.GaussianBlur(2.0))
    result = Image.blend(result, bloom, 0.38)
    glow = Image.new('RGBA', (1600,960), (0,0,0,0))
    gd = ImageDraw.Draw(glow)
    for _ in range(14):
        x = rng.randint(120,1480); y = rng.randint(60,900)
        r = rng.randint(100,280)
        gd.ellipse((x-r,y-r,x+r,y+r), fill=(77,227,247, rng.randint(12,26)))
    for _ in range(8):
        x = rng.randint(120,1480); y = rng.randint(60,900)
        r = rng.randint(80,200)
        gd.ellipse((x-r,y-r,x+r,y+r), fill=(255,46,136, rng.randint(8,18)))
    result = Image.alpha_composite(result, glow)
    result.save(folder/'pastel.png')

    # Large bright meteors
    meteor_atlas = Image.new('RGBA', (256,256), (0,0,0,0))
    for i in range(4):
        x = (i%2)*128; y = (i//2)*128
        tile = Image.new('RGBA', (128,128), (0,0,0,0))
        d = ImageDraw.Draw(tile)
        d.ellipse((16,26,104,94), fill=(85,70,62,255), outline=(150,130,110,255), width=2)
        d.ellipse((24,34,96,86), fill=(110,92,80,255))
        d.ellipse((32,42,88,78), fill=(140,120,105,255))
        for t in range(10):
            alpha = int(180*(1-t/10))
            d.ellipse((0+t*5,34+t*3,26+t*5,64+t*3), fill=(77,227,247,alpha))
            d.ellipse((2+t*5,38+t*3,22+t*5,60+t*3), fill=(170,245,255,alpha//2))
        d.ellipse((64,44,78,58), fill=(255,235,150,255))
        d.ellipse((68,48,74,54), fill=(255,255,255,230))
        meteor_atlas.paste(tile, (x,y))
    meteor_atlas.save(folder/'meteor.png')

    yy, xx = np.mgrid[0:128,0:128]; dx=(xx-64)/64; dy=(yy-64)/64; r=np.sqrt(dx*dx+dy*dy)
    a=np.arctan2(dy,dx); profile=np.clip(1-np.abs(r-.78)/.07,0,1)
    spec=np.clip(.55+.45*np.cos(a+2.2),0,1)
    c=(.5+.5*np.cos(a[:,:,None]+np.array([0.55,0.65,0.85])*2*math.pi))*.18+.55
    c*= (.35+.65*profile*spec)[:,:,None]
    rgba=np.dstack((np.clip(c*255,0,255),np.clip(profile*160,0,160))).astype('uint8')
    Image.fromarray(rgba).save(folder/'ring.png')

if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', default='.cache/chrome-dm')
    args = parser.parse_args()
    textures(Path(args.output))
    print(f"Generated textures in {args.output}")
