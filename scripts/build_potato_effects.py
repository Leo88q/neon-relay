#!/usr/bin/env python3
"""Cosmetic potato damage; HUD ammo/health/armor now use original neon icons."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageOps, ImageChops

ROOT = Path(__file__).resolve().parent.parent
# Only damage fragments remain potato-themed; ammo/health/armor use original neon art.
EFFECT_RECTS = {name: (x*32, y*32, 64, 64) for name, x, y in [
    ('damage0', 15, 0), ('damage1', 17, 0), ('damage2', 19, 0),
]}

def potato(size=64, fragment=None):
    body = Image.open(ROOT/'data/skins/potato_cool_guy_1.png').convert('RGBA').crop((0, 0, 96, 96))
    body = body.crop(body.getchannel('A').getbbox())
    if fragment is not None:
        body = body.crop((0, body.height//2, body.width, body.height))
        body = ImageOps.fit(body, (64, 64), method=Image.Resampling.LANCZOS)
        shapes = [[(8,17),(49,10),(58,45),(25,57)],[(12,10),(56,25),(42,56),(8,43)],[(9,30),(35,7),(58,32),(37,57)]]
        mask = Image.new('L', (64, 64))
        ImageDraw.Draw(mask).polygon(shapes[fragment%3], fill=255)
        body.putalpha(ImageChops.multiply(body.getchannel('A'), mask))
        d = ImageDraw.Draw(body)
        d.line(shapes[fragment%3][:3], fill=(255,221,153,255), width=5)
    spr = ImageOps.contain(body, (size-8, size-8), method=Image.Resampling.LANCZOS)
    tile = Image.new('RGBA', (size, size))
    tile.alpha_composite(spr, ((size-spr.width)//2, (size-spr.height)//2))
    return tile

def game_sheet():
    im = Image.open(ROOT/'data/game.png').convert('RGBA')
    for name, (x, y, w, h) in EFFECT_RECTS.items():
        tile = potato(w)
        im.paste(tile, (x, y))
    return im

def particles():
    im = Image.new('RGBA', (512, 512))
    for col in range(5):
        im.paste(potato(64, None if col==1 else col%3), (col*64, 0))
    im.paste(potato(128, 1), (0, 128))
    for x, y, size, color in [(0,64,64,(207,167,111)),(0,256,256,(236,195,132)),(128,128,128,(108,210,234)),(256,64,128,(248,213,148))]:
        tile = Image.new('RGBA', (size, size))
        d = ImageDraw.Draw(tile)
        for r in range(size//2-2, 0, -1):
            a = round(100*(1-r/(size/2))**1.6)
            d.ellipse((size//2-r, size//2-r, size//2+r, size//2+r), fill=(*color, a))
        if size>=128:
            d.ellipse((size*.18, size*.18, size*.82, size*.82), outline=(*color, 170), width=2)
        im.paste(tile, (x, y))
    return im

if __name__ == '__main__':
    game_sheet().save(ROOT/'data/game.png')
