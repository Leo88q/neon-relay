#!/usr/bin/env python3
"""Original procedural prototype: separate classic 0.6 body/feet/hand/eye cells.
No engine/physics changes. Draw at 4x resolution for clean transparent edges.
Ten articulated characters; archived female face references remain untouched.
"""
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SCALE = 4
INK = '#172538'
EYE_OUTWARD_SHIFT = 1.5  # source pixels; mirrored second eye moves outward too


def canvas(size):
    return Image.new('RGBA', (size[0]*SCALE, size[1]*SCALE))


def ellipse(draw, box, fill):
    draw.ellipse(tuple(int(v*SCALE) for v in box), fill=fill)


def polygon(draw, points, fill):
    draw.polygon([(int(x*SCALE), int(y*SCALE)) for x, y in points], fill=fill)


def line(draw, points, fill, width=1):
    draw.line([(int(x*SCALE), int(y*SCALE)) for x, y in points], fill=fill, width=int(width*SCALE), joint='curve')


def finish(image):
    return image.resize((image.width//SCALE, image.height//SCALE), Image.Resampling.LANCZOS)


def outline(image):
    # Dark edge, not the old white sticker silhouette. Entire mask stays within cell.
    result = Image.new('RGBA', image.size, INK)
    result.putalpha(image.getchannel('A').filter(ImageFilter.MaxFilter(9)))
    return result


# Colors and silhouette accents follow the archived v2 character references.
PROFILES = {
    'cool_guy_1': ('#344b60', '#293e52', '#57d4d2', None, 'leather'),
    'cool_girl_1': ('#26a9b8', '#31778e', '#f771cf', '#ee48b7', 'bomber'),
    'guy_2': ('#454179', '#292e59', '#3de0d8', None, 'cap'),
    'girl_2': ('#a644a8', '#522e72', '#e996ec', '#8c47c8', 'punk'),
    'guy_3': ('#426b97', '#294b73', '#6dddda', None, 'denim'),
    'guy_4': ('#4c4547', '#2e2b36', '#eebd76', None, 'bandana'),
    'girl_3': ('#674889', '#3e376d', '#64eee6', '#3ed3d7', 'varsity'),
    'girl_4': ('#424355', '#282b3e', '#ec8cbd', '#efd285', 'biker'),
    'legend_guy': ('#9d6532', '#6b3c39', '#ffe298', None, 'gold'),
    'legend_girl': ('#4a428b', '#292d67', '#66eee5', '#e64baa', 'crown'),
}


def decorate_head(body, hair, style):
    layer = canvas((96, 96)); d = ImageDraw.Draw(layer)
    if hair:
        # Hair frames the face; eyes remain independent emote sprites.
        polygon(d, [(14, 54), (16, 29), (26, 15), (51, 11), (73, 22), (82, 48),
                    (75, 62), (68, 39), (65, 28), (48, 31), (30, 26), (24, 53)], hair)
        polygon(d, [(21, 32), (28, 19), (51, 14), (64, 19), (46, 21), (31, 29)], '#f6b8dc' if style != 'varsity' else '#a2fff0')
        for x in (20, 24, 70, 74):
            line(d, [(x, 33), (x-1, 42), (x+2, 54)], '#743b79' if style != 'varsity' else '#218496', .75)
        line(d, [(44, 55), (48, 57), (53, 54)], '#9f465a', 1)
        ellipse(d, (46, 57, 51, 58), '#e8818c')
        for x in (25, 69):
            ellipse(d, (x-1, 48, x+1, 51), '#efc772')
    if style == 'cap':
        polygon(d, [(21, 29), (24, 16), (39, 11), (60, 14), (70, 29)], '#292949')
        line(d, [(40, 14), (39, 27)], '#675daa', 1.5)
        polygon(d, [(23, 27), (68, 27), (77, 31), (21, 33)], '#49c4cc')
        line(d, [(26, 30), (70, 30)], '#b0ece5', 1)
    if style == 'bandana':
        polygon(d, [(17, 29), (23, 19), (71, 20), (79, 30)], '#673d42')
        line(d, [(22, 26), (74, 26)], '#c67a66', 1)
        for x in (30, 43, 56, 69):
            polygon(d, [(x, 22), (x+2, 25), (x, 28), (x-2, 25)], '#d6aa7a')
        line(d, [(36, 54), (41, 59), (55, 59), (61, 53)], '#624130', 3)
    if style in ('gold', 'crown'):
        polygon(d, [(31, 26), (28, 15), (38, 20), (46, 10), (54, 20), (65, 14), (61, 27)], '#b67c32')
        line(d, [(31, 23), (61, 23)], '#ffe49c', 2)
        for x in (35, 46, 57):
            ellipse(d, (x-1.5, 20, x+1.5, 23), '#ed6ba7' if style == 'crown' else '#62e3d9')
    # Accessories never enlarge the body collision/render silhouette.
    from PIL import ImageChops
    layer.putalpha(ImageChops.multiply(layer.getchannel('A'), body.getchannel('A')))
    body.alpha_composite(layer)


def build_sheet(name='cool_guy_1', high_resolution=False):
    primary, secondary, accent, hair, style = PROFILES[name]
    body = canvas((96, 96))
    d = ImageDraw.Draw(body)
    ellipse(d, (12, 12, 84, 83), '#ac713b')
    ellipse(d, (14, 11, 82, 81), '#d6a25c')
    ellipse(d, (17, 12, 77, 74), '#e9bc74')
    ellipse(d, (23, 16, 64, 51), '#f1ce8c')
    # Continuous warm lighting instead of concentric flat-colour ellipses.
    # Keep the approved silhouette alpha unchanged, including anti-aliased edges.
    pixels = np.array(body)
    y, x = np.mgrid[:body.height, :body.width] / SCALE
    light = np.exp(-((x-34)**2 / 1300 + (y-29)**2 / 1800))
    for channel, (shadow, highlight) in enumerate([(157, 249), (99, 210), (49, 139)]):
        pixels[..., channel] = np.clip(shadow + (highlight-shadow)*light, 0, 255).astype(np.uint8)
    body = Image.fromarray(pixels)
    d = ImageDraw.Draw(body)
    # Sparse skin pores and paired dimple shadow/highlight, not photo noise.
    for px, py, r in [(25, 28, 1.6), (68, 25, 1.2), (72, 46, 1.5),
                     (23, 48, 1.2), (59, 20, 1), (20, 38, .6), (76, 37, .7)]:
        ellipse(d, (px-r, py-r, px+r, py+r), '#b58347')
        ellipse(d, (px-r*.7, py, px+r*.7, py+r*1.3), '#f1cd8a')
        ellipse(d, (px-r*.4, py-r*.6, px+r*.3, py), '#976338')
    for px, py in [(29, 22), (24, 34), (19, 44), (70, 32), (75, 43), (64, 22), (26, 51)]:
        ellipse(d, (px, py, px+.55, py+.6), '#c79756')
    polygon(d, [(31, 19), (34, 12), (44, 13), (51, 10), (59, 16), (48, 19)], '#654534')
    line(d, [(35, 15), (43, 16), (50, 13)], '#aa7846', 1)
    line(d, [(40, 18), (49, 17), (54, 15)], '#885735', .75)
    if name != "cool_guy_1":
        decorate_head(body, hair, style)
    # Raised collar/lapels remain visible above the separate animated feet.
    jacket = canvas((96, 96)); j = ImageDraw.Draw(jacket)
    polygon(j, [(10, 60), (29, 49), (47, 60), (67, 48), (86, 59), (86, 90), (10, 90)], INK)
    polygon(j, [(16, 61), (29, 51), (44, 63), (39, 86), (14, 86)], '#344b60')
    polygon(j, [(52, 63), (67, 50), (82, 60), (84, 85), (54, 86)], '#293e52')
    polygon(j, [(42, 61), (48, 64), (54, 60), (54, 85), (41, 85)], '#10212e')
    # Leather-panel highlights and folds, bounded to the body by the mask below.
    polygon(j, [(20, 62), (29, 54), (37, 62), (30, 70), (23, 76)], '#40596c')
    polygon(j, [(65, 55), (76, 62), (72, 76), (63, 68)], '#334b62')
    polygon(j, [(28, 50), (43, 60), (35, 68), (38, 59)], '#50677a')
    polygon(j, [(67, 49), (53, 61), (60, 68), (58, 58)], '#435971')
    line(j, [(29, 51), (39, 60), (35, 68)], '#57d4d2', 1)
    line(j, [(66, 51), (57, 61), (60, 68)], '#b38be2', 1)
    line(j, [(19, 65), (22, 75), (33, 79)], '#203345', 1)
    line(j, [(76, 66), (71, 77), (62, 79)], '#172c40', 1)
    # Angled zipped pockets and small metallic fasteners.
    line(j, [(25, 68), (33, 71)], '#142737', 2)
    line(j, [(25, 67), (33, 70)], '#a7b6bd', .75)
    line(j, [(64, 70), (72, 66)], '#142737', 2)
    line(j, [(64, 69), (72, 65)], '#8dabb7', .75)
    for px, py in [(33, 57), (62, 56), (33, 71), (64, 70)]:
        ellipse(j, (px-.7, py-.7, px+.7, py+.7), '#b8c9ce')
    line(j, [(48, 63), (47, 83)], '#788e9f', 1)
    for py in range(65, 83, 2):
        line(j, [(46.5, py), (49, py)], '#c3d0ce', .5)
    polygon(j, [(47, 63), (49, 64), (49, 67), (47, 68)], '#d0d9d2')
    line(j, [(25, 80), (40, 83)], '#517280', .75)
    line(j, [(56, 83), (72, 79)], '#415c74', .75)
    if name != 'cool_guy_1':
        from PIL import ImageColor
        pixels = np.array(jacket)
        for old, new in [('#344b60', primary), ('#293e52', secondary), ('#57d4d2', accent),
                         ('#40596c', primary), ('#334b62', secondary), ('#50677a', accent)]:
            mask = (pixels[..., :3] == ImageColor.getrgb(old)).all(axis=2)
            pixels[mask, :3] = ImageColor.getrgb(new)
        jacket = Image.fromarray(pixels); j = ImageDraw.Draw(jacket)
        if style == 'cap':
            for x in (22, 30, 65, 72):
                line(j, [(x, 62), (x, 75), (x+4, 75), (x+4, 79)], accent, .75)
                ellipse(j, (x-1, 61, x+1, 63), '#c9f4e7')
        elif style in ('bomber', 'varsity', 'denim'):
            polygon(j, [(25, 62), (31, 62), (32, 70), (25, 70)], accent)
            line(j, [(27, 64), (30, 65), (27, 66), (27, 69)], INK, .75)
            for y in (77, 79, 81):
                line(j, [(20, y), (37, y+2)], accent, .5)
        elif style in ('punk', 'biker', 'bandana'):
            for x in (23, 28, 65, 70):
                polygon(j, [(x, 61), (x+1, 63), (x, 65), (x-1, 63)], '#d4dce0')
            line(j, [(32, 66), (40, 73), (53, 73), (63, 65)], '#c2a983', 1)
        elif style in ('gold', 'crown'):
            for y in (61, 65):
                line(j, [(27, y), (37, y+8), (49, y+10), (62, y+3), (69, y-2)], '#f4ce72', 1.5)
            polygon(j, [(48, 69), (52, 74), (48, 79), (44, 74)], accent)
            line(j, [(20, 70), (26, 80), (33, 76)], '#e58acb', 1)
    # Clip the jacket to the original rounded body alpha, not a human silhouette.
    from PIL import ImageChops
    jacket.putalpha(ImageChops.multiply(jacket.getchannel('A'), body.getchannel('A')))
    body.alpha_composite(jacket)

    foot = canvas((64, 32)); d = ImageDraw.Draw(foot)
    ellipse(d, (17, 8, 49, 26), INK)
    ellipse(d, (19, 9, 47, 23), '#334a62')
    line(d, [(21, 23), (44, 23)], '#51c9cb', 1.2)
    line(d, [(23, 12), (35, 12)], '#6e86a0', 1.4)

    hand = canvas((32, 32)); d = ImageDraw.Draw(hand)
    ellipse(d, (7, 7, 25, 25), '#b98245')
    ellipse(d, (8, 7, 23, 22), '#e9bc74')
    line(d, [(12, 11), (18, 10)], '#f7d99f', 1.5)

    factor = SCALE if high_resolution else 1
    sheet = Image.new('RGBA', (256*factor, 128*factor))
    for art, pos, border in [(body, (0, 0), (96, 0)), (hand, (192, 0), (224, 0)), (foot, (192, 32), (192, 64))]:
        sheet.paste(art if high_resolution else finish(art), tuple(v*factor for v in pos))
        edge = outline(art)
        sheet.paste(edge if high_resolution else finish(edge), tuple(v*factor for v in border))
    # One lens/eye per cell: the renderer mirrors it for the second eye and
    # applies gaze/blink/emote transforms. No eyes are baked into the body.
    for index in range(6):
        eye = canvas((32, 32)); d = ImageDraw.Draw(eye)
        if index in (0, 1, 5):
            ellipse(d, (7, 4, 25, 28), INK)
            ellipse(d, (9, 6, 23, 25), '#39c9de')
            ellipse(d, (11, 7, 20, 18), '#96e7ea')
            line(d, [(12, 10), (16, 8)], '#d6f6ed', 2)
            if index == 1:
                polygon(d, [(5, 2), (27, 11), (27, 16), (5, 7)], INK)
            if index == 5:
                ellipse(d, (13, 12, 19, 22), '#244457')
        elif index == 2:
            line(d, [(9, 8), (22, 16), (9, 24)], INK, 3)
        elif index == 3:
            line(d, [(8, 21), (11, 12), (16, 9), (21, 12), (24, 21)], INK, 3)
        else:
            line(d, [(9, 8), (23, 24)], INK, 3)
            line(d, [(23, 8), (9, 24)], INK, 3)
        if hair and index in (0, 1, 5):
            # Expressive iris and lashes, not replacement black-dot faces.
            ellipse(d, (13, 13, 20, 24), '#754e9c' if style in ('punk', 'crown') else '#267f88')
            ellipse(d, (15, 15, 18, 23), '#24304a')
            ellipse(d, (13, 13, 16, 16), '#f6eee0')
            line(d, [(8, 8), (5, 5)], INK, 1.5)
            line(d, [(10, 6), (8, 3)], INK, 1.5)
        if style == 'gold' and index in (0, 1, 5):
            line(d, [(8, 7), (12, 5), (23, 8)], '#f4cb70', 1.5)
        shifted = canvas((32, 32))
        shifted.alpha_composite(eye, (-int(EYE_OUTWARD_SHIFT*SCALE), 0))
        sheet.paste(shifted if high_resolution else finish(shifted), ((64 + index*32)*factor, 96*factor))
    return sheet


def main():
    for name in PROFILES:
        build_sheet(name).save(ROOT / f'data/skins/potato_{name}.png')


if __name__ == '__main__':
    main()
