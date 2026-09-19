"""Chrome materials with photo background plus code-driven effects."""
import math
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
    # Chrome field – periodic, world-sampled, no per-cell moire
    y, x = np.mgrid[0:512, 0:512]; u = x/512; v = y/512
    phase = v + .025*np.sin(u*2*math.pi) + .009*np.sin(u*6*math.pi)
    ramp = .5-.5*np.cos(phase*2*math.pi)
    stops = np.array([0,.08,.22,.34,.40,.46,.60,.80,1])
    colors = np.array([[255,255,255],[223,233,255],[143,163,216],[42,50,102],
                       [14,18,48],[85,104,168],[199,211,245],[255,255,255],[127,139,189]])
    rgb = np.stack([np.interp(ramp, stops, colors[:,c]) for c in range(3)], axis=-1)
    film = .5+.5*np.cos(2*math.pi*(u[:,:,None]+v[:,:,None]+np.array([0,.33,.67])))
    rgb = rgb*.94 + film*12 + (np.sin(y*math.pi/2)*.7)[:,:,None]
    field = Image.fromarray(np.clip(rgb,0,255).astype('uint8')).convert('RGBA')
    atlas = Image.new('RGBA', (1024,1024))
    for yy in range(8):
        for xx in range(8):
            idx = 1+yy*8+xx
            atlas.paste(field.crop((xx*64,yy*64,xx*64+64,yy*64+64)), ((idx%16)*64,(idx//16)*64))
    atlas.save(folder/'chrome.png')

    edges = Image.new('RGBA', (1024,1024))
    for mask in range(1,16):
        tile = Image.new('RGBA', (64,64)); d = ImageDraw.Draw(tile)
        for bit, line, inner in [(1,(0,0,63,0),(0,3,63,3)),(2,(63,0,63,63),(60,0,60,63)),
                                 (4,(0,63,63,63),(0,60,63,60)),(8,(0,0,0,63),(3,0,3,63))]:
            if mask & bit:
                d.line(line, fill=(16,27,58,255), width=5)
                d.line(inner, fill=(237,248,255,230) if bit in (1,8) else (124,164,212,210), width=2)
        edges.paste(tile, ((mask%16)*64,(mask//16)*64))
    edges.save(folder/'bevels.png')

    # Photo background + code effects: user wanted a beautiful photo with effects on top
    # Load AI-generated chrome atrium photo (original, Zlib) and blend procedural veil
    photo_path = ROOT / '.cache/chrome-dm/photo_bg.jpg'
    if not photo_path.exists():
        # fallback to procedural if photo missing (CI will have it from cache or generate)
        photo = Image.new('RGB', (1600,960), (200,210,230))
    else:
        photo = Image.open(photo_path).convert('RGB').resize((1600,960), Image.Resampling.LANCZOS)

    yy, xx = np.mgrid[0:960, 0:1600]; px = xx/440; py = yy/440
    qx = fbm(px, py); qy = fbm(px+5.2, py+1.3)
    f = fbm(px+2.5*qx, py+2.5*qy)

    # Domain-warp pastel veil
    pal = .5+.5*np.cos(2*math.pi*(f[:,:,None]*1.2+qx[:,:,None]*.5+np.array([0,.33,.67])))
    veil = pal*.28 + np.array([.78,.83,.96])*.72
    veil *= (.86+.14*f)[:,:,None]
    ribbon = np.exp(-((np.mod(f*5,1)-.5)/.055)**2)
    veil = veil*(1-ribbon[:,:,None]*.14)+ribbon[:,:,None]*.14
    veil_img = Image.fromarray(np.clip(veil*255,0,255).astype('uint8'))

    # Light ribbons – thin-film curves following domain warp
    light = Image.new('RGBA', (1600,960), (0,0,0,0))
    ld = ImageDraw.Draw(light)
    for k in range(6):
        pts = []
        for x in range(0,1600,8):
            y = 120 + k*140 + 60*math.sin(x/220 + k*1.3) + 30*math.sin(x/90)
            pts.append((x,y))
        ld.line(pts, fill=(120+k*20, 230, 255, 35), width=6)
        ld.line(pts, fill=(255,255,255,90), width=2)

    # Composite: photo * 0.85 + veil * 0.35 + light ribbons
    base = np.array(photo).astype(float)
    veil_arr = np.array(veil_img).astype(float)
    blended = base*0.72 + veil_arr*0.32
    # subtle vignette
    vy, vx = np.mgrid[0:960,0:1600]
    vign = 1 - 0.18*np.sqrt(((vx-800)/800)**2 + ((vy-480)/480)**2)
    blended = blended * vign[:,:,None]
    result = Image.fromarray(np.clip(blended,0,255).astype('uint8')).convert('RGBA')
    result.alpha_composite(light)
    # soft bloom
    bloom = result.filter(ImageFilter.GaussianBlur(1.2))
    result = Image.blend(result, bloom, 0.18)
    result.save(folder/'pastel.png')

    # Film torus
    yy, xx = np.mgrid[0:128,0:128]; dx=(xx-64)/64; dy=(yy-64)/64; r=np.sqrt(dx*dx+dy*dy)
    a=np.arctan2(dy,dx); profile=np.clip(1-np.abs(r-.78)/.07,0,1)
    spec=np.clip(.55+.45*np.cos(a+2.2),0,1)
    c=(.5+.5*np.cos(a[:,:,None]+np.array([0,.33,.67])*2*math.pi))*.18+.68
    c*= (.4+.6*profile*spec)[:,:,None]
    rgba=np.dstack((np.clip(c*255,0,255),np.clip(profile*190,0,190))).astype('uint8')
    Image.fromarray(rgba).save(folder/'ring.png')
