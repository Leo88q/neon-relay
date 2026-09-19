"""Dark pixel neon materials with space background and meteors."""
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

    # Dark pixel neon chrome
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

    # Bevels – dark with cyan
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

    # Freeze visible texture – cyan pixel freeze wall
    freeze_atlas = Image.new('RGBA', (256,256), (0,0,0,0))
    for yy in range(4):
        for xx in range(4):
            tile = Image.new('RGBA', (64,64), (8,18,36,255))
            d = ImageDraw.Draw(tile)
            # ice crystal pattern
            d.rectangle((0,0,63,63), outline=(77,200,230,180), width=2)
            for i in range(0,64,16):
                d.line((i,0,i,63), fill=(30,60,110,90), width=1)
                d.line((0,i,63,i), fill=(30,60,110,90), width=1)
            # cyan center glow
            d.ellipse((20,20,44,44), fill=(77,227,247,40), outline=(120,240,255,120), width=2)
            freeze_atlas.paste(tile, (xx*64, yy*64))
    freeze_atlas.save(folder/'freeze.png')

    # Space background – photo + code effects – BRIGHTER v6 for visible cosmos
    space_path = ROOT / '.cache/chrome-dm/space_bg.jpg'
    if not space_path.exists():
        photo = Image.new('RGB', (1600,960), (10,14,28))
    else:
        photo = Image.open(space_path).convert('RGB').resize((1600,960), Image.Resampling.LANCZOS)
        # Keep photo bright – only 15% dark blend, boost blue
        dark = Image.new('RGB', photo.size, (6,8,18))
        photo = Image.blend(photo, dark, 0.15)
        arr = np.array(photo).astype(float)
        arr[:,:,0] *= 0.95
        arr[:,:,1] *= 1.05
        arr[:,:,2] *= 1.25
        # boost overall brightness
        arr = arr * 1.15 + 10
        photo = Image.fromarray(np.clip(arr,0,255).astype('uint8'))

    yy, xx = np.mgrid[0:960, 0:1600]; px = xx/380; py = yy/380
    qx = fbm(px, py); qy = fbm(px+4.2, py+1.1)
    f = fbm(px+2.2*qx, py+2.2*qy)

    # Nebula veil – brighter
    pal = .5+.5*np.cos(2*math.pi*(f[:,:,None]*1.0+qx[:,:,None]*.35+np.array([0.55,0.65,0.9])))
    veil = pal*.35 + np.array([.12,.18,.36])*.65
    veil *= (.85+.15*f)[:,:,None]
    ribbon = np.exp(-((np.mod(f*4,1)-.5)/.07)**2)
    veil = veil*(1-ribbon[:,:,None]*.15)+ribbon[:,:,None]*np.array([0.3,0.8,1.0])*0.35
    veil_img = Image.fromarray(np.clip(veil*255,0,255).astype('uint8'))

    # Starfield overlay – more stars, brighter
    stars = Image.new('RGBA', (1600,960), (0,0,0,0))
    sd = ImageDraw.Draw(stars)
    for _ in range(1200):
        x = rng.randint(0,1599); y = rng.randint(0,959)
        b = rng.randint(180,255)
        sd.point((x,y), fill=(b,b,b+15, rng.randint(120,255)))
        if rng.random()<0.15:
            sd.ellipse((x-1,y-1,x+1,y+1), fill=(b,b,255,90))
            sd.point((x,y), fill=(255,255,255,220))
    # extra nebula sparkles
    for _ in range(80):
        x = rng.randint(0,1599); y = rng.randint(0,959)
        sd.ellipse((x-2,y-2,x+2,y+2), fill=(77,227,247,40))

    base = np.array(photo).astype(float)
    veil_arr = np.array(veil_img).astype(float)
    blended = base*0.92 + veil_arr*0.48
    vy, vx = np.mgrid[0:960,0:1600]
    vign = 1 - 0.18*np.sqrt(((vx-800)/800)**2 + ((vy-480)/480)**2)
    blended = blended * vign[:,:,None]
    # slight contrast boost
    blended = np.clip((blended-128)*1.08+128,0,255)
    result = Image.fromarray(np.clip(blended,0,255).astype('uint8')).convert('RGBA')
    result.alpha_composite(stars)
    bloom = result.filter(ImageFilter.GaussianBlur(1.0))
    result = Image.blend(result, bloom, 0.22)
    result.save(folder/'pastel.png')

    # Meteors – small pixel meteors with trail
    meteor_atlas = Image.new('RGBA', (256,256), (0,0,0,0))
    for i in range(4):
        x = (i%2)*128; y = (i//2)*128
        tile = Image.new('RGBA', (128,128), (0,0,0,0))
        d = ImageDraw.Draw(tile)
        # meteor body – dark rock with cyan glow
        d.ellipse((30,40,90,80), fill=(40,30,28,255), outline=(80,60,50,200), width=2)
        d.ellipse((35,45,85,75), fill=(60,50,45,255))
        # glow trail
        for t in range(5):
            alpha = int(120*(1-t/5))
            d.ellipse((10+t*4,45+t*2,30+t*4,65+t*2), fill=(77,227,247,alpha))
        # pixel sparkle
        d.point((70,50), fill=(255,200,100,200))
        meteor_atlas.paste(tile, (x,y))
    meteor_atlas.save(folder/'meteor.png')

    # Ring (kept for parallax bubbles)
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
