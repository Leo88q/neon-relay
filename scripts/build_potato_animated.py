#!/usr/bin/env python3
"""Original procedural prototype: separate classic 0.6 body/feet/hand/eye cells.
No engine/physics changes. Draw at 4x resolution for clean transparent edges.
Only cool_guy_1 is migrated; approved female sources remain untouched.
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SCALE = 4
INK = '#172538'


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


def build_sheet():
    body = canvas((96, 96))
    d = ImageDraw.Draw(body)
    ellipse(d, (12, 12, 84, 83), '#ac713b')
    ellipse(d, (14, 11, 82, 81), '#d6a25c')
    ellipse(d, (17, 12, 77, 74), '#e9bc74')
    ellipse(d, (23, 16, 64, 51), '#f1ce8c')
    # Potato dimples, kept outside the animated eye area.
    for x, y, r in [(25, 28, 1.5), (68, 25, 1), (72, 46, 1.5), (23, 48, 1), (59, 20, 1)]:
        ellipse(d, (x-r, y-r, x+r, y+r), '#bb864b')
    # Short asymmetric tuft; no floating spikes beyond the collision silhouette.
    polygon(d, [(31, 19), (34, 12), (44, 13), (51, 10), (59, 16), (48, 19)], '#654534')
    # Jacket occupies lower body; no shoulders, arms, trousers or painted feet.
    jacket = canvas((96, 96)); j = ImageDraw.Draw(jacket)
    polygon(j, [(10, 64), (30, 57), (48, 65), (65, 56), (86, 65), (86, 90), (10, 90)], INK)
    polygon(j, [(16, 67), (30, 60), (43, 69), (38, 86), (14, 86)], '#2e4356')
    polygon(j, [(53, 68), (66, 59), (82, 65), (84, 85), (55, 86)], '#25384d')
    line(j, [(30, 59), (39, 69), (34, 75)], '#49d5d8', 1.3)
    line(j, [(65, 59), (56, 70), (60, 76)], '#ac77da', 1.3)
    line(j, [(48, 68), (47, 83)], '#9eacb9', 1)
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

    sheet = Image.new('RGBA', (256, 128))
    for art, pos, border in [(body, (0, 0), (96, 0)), (hand, (192, 0), (224, 0)), (foot, (192, 32), (192, 64))]:
        sheet.paste(finish(art), pos)
        sheet.paste(finish(outline(art)), border)
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
        sheet.paste(finish(eye), (64 + index*32, 96))
    return sheet


def main():
    build_sheet().save(ROOT / 'data/skins/potato_cool_guy_1.png')


if __name__ == '__main__':
    main()
