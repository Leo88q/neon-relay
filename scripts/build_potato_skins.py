#!/usr/bin/env python3
"""Bake generated RGBA bodies with painted faces and separate animated limbs.
No rematting of canonical sources; no procedural face or legacy skin regeneration.
"""
from pathlib import Path
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'assets-src/potato/generated_bodies'
POTATOES = ["cool_guy_1", "cool_girl_1", "guy_2", "girl_2", "guy_3",
           "girl_3", "guy_4", "girl_4", "legend_guy", "legend_girl"]


def build_sheet(name):
    with Image.open(SRC / f'{name}.png') as image:
        assert image.mode == 'RGBA' and image.size == (1024, 1024)
        art = image.crop(image.getchannel('A').getbbox())
    # Reserve a margin for antialiasing and outline; render metrics stay bounded.
    art.thumbnail((76, 76), Image.Resampling.LANCZOS)
    sheet = Image.new('RGBA', (256, 128))
    sheet.paste(art, ((96-art.width)//2, (96-art.height)//2))
    mask = sheet.crop((0, 0, 96, 96)).getchannel('A').filter(ImageFilter.MaxFilter(3))
    border = Image.new('RGBA', (96, 96), '#192333'); border.putalpha(mask)
    sheet.paste(border, (96, 0))
    with Image.open(SRC / 'limbs.png') as limbs:
        sheet.paste(limbs, (192, 0))
    # Entire eye row deliberately empty: face is in the generated body art.
    return sheet


def main():
    for name in POTATOES:
        build_sheet(name).save(ROOT / f'data/skins/potato_{name}.png')
    print('PASS: ten generated bodies, independent limbs, no eye/emote cells')


if __name__ == '__main__':
    main()
