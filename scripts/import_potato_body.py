#!/usr/bin/env python3
"""One-time import of generated art, NOT part of the repeatable sheet bake.
Accept real RGBA or solid green chroma. Inspect the result before publishing;
never re-matte the canonical source during rebuilds.
"""
import argparse
from pathlib import Path
import numpy as np
from PIL import Image, ImageFilter
from build_potato_skins import POTATOES, ROOT

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('image', type=Path)
parser.add_argument('character', choices=POTATOES)
args = parser.parse_args()
im = Image.open(args.image).convert('RGBA')
a = np.array(im).astype(np.int16)
if a[..., 3].min() == 255:
    # Remove chroma everywhere, including enclosed gaps between hair strands.
    # Our agreed costumes use cyan/pink, not chroma green.
    chroma = (a[..., 1] > a[..., 0]+28) & (a[..., 1] > a[..., 2]+28)
    if chroma.mean() < .2:
        raise SystemExit('No alpha or solid green background detected; manual matting required')
    alpha = Image.fromarray(np.where(chroma, 0, 255).astype('uint8'))
    alpha = alpha.filter(ImageFilter.MinFilter(5)).filter(ImageFilter.GaussianBlur(.35))
    a[..., 3] = np.array(alpha)
    edge = a[..., 3] < 250
    a[edge, 1] = np.minimum(a[edge, 1], np.maximum(a[edge, 0], a[edge, 2]))
    im = Image.fromarray(a.astype('uint8'))
box = im.getchannel('A').getbbox()
if box is None:
    raise SystemExit('Empty foreground')
im = im.crop(box)
scale = 944/max(im.size)
im = im.resize((round(im.width*scale), round(im.height*scale)), Image.Resampling.LANCZOS)
normalized = Image.new('RGBA', (1024, 1024))
normalized.paste(im, ((1024-im.width)//2, (1024-im.height)//2))
path = ROOT / f'assets-src/potato/generated_bodies/{args.character}.png'
normalized.save(path)
print(path)
