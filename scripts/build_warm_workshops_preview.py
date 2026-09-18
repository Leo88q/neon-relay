#!/usr/bin/env python3
"""Build an isolated art-direction preview. Does NOT write playable .map files."""
import argparse
import shutil
from pathlib import Path
from PIL import Image, ImageFilter
import numpy as np
ROOT = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path, required=True)
out = parser.parse_args().output.resolve()
out.mkdir(parents=True, exist_ok=True)
src = ROOT/'assets-src/maps/warm-workshops'
shutil.copyfile(src/'background.png', out/'background.png')
shutil.copyfile(ROOT/'design/warm-workshops/index.html', out/'index.html')
im = Image.open(src/'props-chroma.png').convert('RGBA')
a = np.array(im).astype(np.int16)
key = (a[...,0] > a[...,1]+60) & (a[...,2] > a[...,1]+60)
a[...,3] = np.where(key, 0, 255)
matte = Image.fromarray(a.astype('uint8'))
matte.putalpha(matte.getchannel('A').filter(ImageFilter.MinFilter(3)))
w,h=matte.size
for name, box in [('platform',(0,0,w//2,h//2)), ('lantern',(w//2,0,w,h//2)),
                  ('ivy',(0,h//2,w//2,h)), ('pipes',(w//2,h//2,w,h))]:
    prop=matte.crop(box)
    bbox=prop.getchannel('A').getbbox()
    assert bbox, name
    prop=prop.crop(bbox)
    # Fully transparent padding keeps linear texture sampling away from edges.
    padded=Image.new('RGBA',(prop.width+8,prop.height+8))
    padded.paste(prop,(4,4))
    padded.save(out/f'{name}.png')
print(f'Art prototype built at {out}; not a playable map.')
