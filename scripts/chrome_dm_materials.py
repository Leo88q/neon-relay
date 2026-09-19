"""Dark pixel neon materials with photo background plus code effects."""
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

    # Dark pixel neon chrome – 8x8 tiles, each 64x64, dark base with pixel noise and cyan top
    atlas = Image.new('RGBA', (1024,1024), (0,0,0,0))
    for yy in range(8):
        for xx in range(8):
            idx = 1+yy*8+xx
            # Dark base varies slightly with depth
            base_lum = 14 + yy*3
            tile = Image.new('RGBA', (64,64), (base_lum-2, base_lum, base_lum+8, 255))
            d = ImageDraw.Draw(tile)
            # Subtle pixel grid – 8px blocks
            for py in range(0,64,8):
                for px in range(0,64,8):
                    if rng.random() < 0.12:
                        col = (18, 28, 52, 255) if rng.random()<0.6 else (22, 34, 62, 255)
                        d.rectangle((px,py,px+6,py+6), fill=col)
            # Pixel sparkles – cyan/magenta single pixels
            for _ in range(18):
                px = rng.randint(2,61); py = rng.randint(4,61)
                if rng.random() < 0.5:
                    d.point((px,py), fill=(77,227,247,180))
                else:
                    d.point((px,py), fill=(255,46,136,140))
            # Darker bottom shade for depth
            shade = int(6 + yy*2.2)
            d.rectangle((0,64-shade,63,63), fill=(4,6,16,200))
            # Top cyan neon edge – stronger for top tiles (yy==0)
            if yy==0 or rng.random()<0.35:
                d.line((0,0,63,0), fill=(77,227,247,255), width=3)
                d.line((0,1,63,1), fill=(140,245,255,180), width=1)
                d.line((0,2,63,2), fill=(40,120,160,90), width=1)
            # Side pixel bevel – dark
            d.line((0,0,0,63), fill=(10,16,32,255), width=2)
            d.line((63,0,63,63), fill=(10,16,32,255), width=2)

            atlas.paste(tile, ((idx%16)*64,(idx//16)*64))

    atlas.save(folder/'chrome.png')

    # Bevels – dark with cyan inner highlight
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

    # Photo background – now darkened for neon dark theme
    photo_path = ROOT / '.cache/chrome-dm/photo_bg.jpg'
    if not photo_path.exists():
        photo = Image.new('RGB', (1600,960), (10,12,24))
    else:
        photo = Image.open(photo_path).convert('RGB').resize((1600,960), Image.Resampling.LANCZOS)
        # Darken photo for dark theme
        dark = Image.new('RGB', photo.size, (8,10,22))
        photo = Image.blend(photo, dark, 0.62)
        # Add slight blue tint
        arr = np.array(photo).astype(float)
        arr[:,:,0] *= 0.75
        arr[:,:,1] *= 0.85
        arr[:,:,2] *= 1.05
        photo = Image.fromarray(np.clip(arr,0,255).astype('uint8'))

    yy, xx = np.mgrid[0:960, 0:1600]; px = xx/440; py = yy/440
    qx = fbm(px, py); qy = fbm(px+5.2, py+1.3)
    f = fbm(px+2.5*qx, py+2.5*qy)

    # Dark neon veil – less pastel, more indigo/cyan
    pal = .5+.5*np.cos(2*math.pi*(f[:,:,None]*1.1+qx[:,:,None]*.4+np.array([0.55,0.65,0.85])))
    veil = pal*.22 + np.array([.12,.18,.32])*.78
    veil *= (.82+.18*f)[:,:,None]
    ribbon = np.exp(-((np.mod(f*4.5,1)-.5)/.06)**2)
    veil = veil*(1-ribbon[:,:,None]*.18)+ribbon[:,:,None]*np.array([0.3,0.9,1.0])*0.22
    veil_img = Image.fromarray(np.clip(veil*255,0,255).astype('uint8'))

    # Neon light ribbons – cyan/magenta on dark
    light = Image.new('RGBA', (1600,960), (0,0,0,0))
    ld = ImageDraw.Draw(light)
    for k in range(7):
        pts = []
        for x in range(0,1600,8):
            y = 100 + k*130 + 50*math.sin(x/200 + k*1.1) + 25*math.sin(x/80)
            pts.append((x,y))
        col = (77,227,247,28) if k%2==0 else (255,46,136,22)
        ld.line(pts, fill=col, width=7)
        ld.line(pts, fill=(200,240,255,70) if k%2==0 else (255,180,210,50), width=2)

    base = np.array(photo).astype(float)
    veil_arr = np.array(veil_img).astype(float)
    blended = base*0.78 + veil_arr*0.45
    vy, vx = np.mgrid[0:960,0:1600]
    vign = 1 - 0.32*np.sqrt(((vx-800)/800)**2 + ((vy-480)/480)**2)
    blended = blended * vign[:,:,None]
    result = Image.fromarray(np.clip(blended,0,255).astype('uint8')).convert('RGBA')
    result.alpha_composite(light)
    bloom = result.filter(ImageFilter.GaussianBlur(1.4))
    result = Image.blend(result, bloom, 0.22)
    # Add subtle pixel dither for pixel neon feel
    dither = Image.new('RGBA', result.size, (0,0,0,0))
    dd = ImageDraw.Draw(dither)
    for _ in range(800):
        x = rng.randint(0,1599); y = rng.randint(0,959)
        dd.point((x,y), fill=(77,227,247,60))
    result.alpha_composite(dither)
    result.save(folder/'pastel.png')

    # Film torus – keep but darker
    yy, xx = np.mgrid[0:128,0:128]; dx=(xx-64)/64; dy=(yy-64)/64; r=np.sqrt(dx*dx+dy*dy)
    a=np.arctan2(dy,dx); profile=np.clip(1-np.abs(r-.78)/.07,0,1)
    spec=np.clip(.55+.45*np.cos(a+2.2),0,1)
    c=(.5+.5*np.cos(a[:,:,None]+np.array([0.55,0.65,0.85])*2*math.pi))*.18+.55
    c*= (.35+.65*profile*spec)[:,:,None]
    rgba=np.dstack((np.clip(c*255,0,255),np.clip(profile*160,0,160))).astype('uint8')
    Image.fromarray(rgba).save(folder/'ring.png')
