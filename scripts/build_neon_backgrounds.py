#!/usr/bin/env python3
"""Original background/celestial art for the shipped mapres sheets.

Replaces the upstream background sheets (mountain ranges, jungle layers,
clouds, sun/moon/stars/snow) with new pixels painted in the Neon Relay
night-drive style. Only functional facts are honored:

* exact pixel dimensions (read from the current files),
* anchoring the maps rely on (ranges sit on the bottom edge, discs are
  centered, jungle layers keep canopy-top / ground-bottom bands),
* horizontal seamlessness where quad texture coordinates exceed 1.0
  (all *mountains sheets + jungle_background; see tiling analysis).

Every shape, color, crater and snow cap below is authored for this project.
Stdlib only (see scripts/neon_png.py).
"""

from __future__ import annotations

import math
import random
import sys

sys.path.insert(0, str(__file__ and __import__("pathlib").Path(__file__).resolve().parent))

from neon_png import Canvas, NIGHT1, NIGHT2, CYAN, ICE, DIM, read_png, png_info  # noqa: E402
import pathlib  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
MAPRES = ROOT / "data" / "mapres"


def check_dims(name: str, canvas: Canvas) -> None:
    w, h, _, _ = png_info(MAPRES / name)
    assert (canvas.w, canvas.h) == (w, h), f"{name}: want {w}x{h}, got {canvas.w}x{canvas.h}"


# ----------------------------------------------------------------------------
# ridges (mountains, desert_mountains*, winter_mountains*)
# ----------------------------------------------------------------------------

def skyline(w: int, base: int, amp: int, seed: int, waves=((3, 1.0), (7, 0.45), (13, 0.2))) -> list[int]:
    """Periodic skyline heights (tileable): sum of integer-period sines."""
    rng = random.Random(seed)
    phases = [rng.uniform(0, 2 * math.pi) for _ in waves]
    out = []
    for x in range(w):
        t = x / w * 2 * math.pi
        v = sum(a * math.sin(p * t + ph) for (p, a), ph in zip(waves, phases))
        norm = sum(a for _, a in waves)
        out.append(int(base - amp * (0.5 + 0.5 * v / norm)))
    return out


def paint_ridge(c: Canvas, tops: list[int], far: tuple, near: tuple, rim: tuple,
                strata: tuple | None, seed: int, snow: tuple | None = None,
                snowline: int | None = None) -> None:
    """Fill below tops[] with a vertical gradient + strata + rim light."""
    w, h = c.w, c.h
    rng = random.Random(seed)
    # coarse tileable variation grid for strata wobble
    gw = 128
    warp = [rng.uniform(-6, 6) for _ in range(gw + 1)]
    warp[-1] = warp[0]
    for x in range(w):
        top = tops[x]
        if top >= h:
            continue
        span = max(1, h - 1 - top)
        wob = warp[(x * gw // w) % gw]
        for y in range(top, h):
            t = (y - top) / span
            r = int(far[0] + (near[0] - far[0]) * t)
            g = int(far[1] + (near[1] - far[1]) * t)
            b = int(far[2] + (near[2] - far[2]) * t)
            if strata and int(y + wob) % 46 < 3:
                r, g, b = strata[0], strata[1], strata[2]
            c.set(x, y, (r, g, b, 255))
        # rim light on the exposed top edge + short falloff
        c.set(x, top, rim)
        if top + 1 < h:
            c.blend(x, top + 1, rim[:3] + (140,))
        if top + 2 < h:
            c.blend(x, top + 2, rim[:3] + (60,))
    if snow is not None and snowline is not None:
        for x in range(w):
            top = tops[x]
            cap = snowline + int(warp[(x * gw // w) % gw] * 2)
            for y in range(top, min(cap, h)):
                # noisy snow boundary, thicker near the peaks
                depth = (cap - y) / max(1, cap - top)
                if rng.random() < 0.25 + 0.75 * depth:
                    c.set(x, y, snow)
        # sparkle
        capped = [x for x in range(w) if tops[x] < snowline]
        for _ in range(len(capped) // 3):
            x = rng.choice(capped)
            y = rng.randrange(max(0, tops[x]), min(snowline, h))
            c.set(x, y, (255, 255, 255, 255))


def buttes(w: int, base: int, amp: int, seed: int) -> list[int]:
    """Flat-top desert buttes: quantized periodic skyline with cliffs."""
    tops = skyline(w, base, amp, seed, waves=((2, 1.0), (5, 0.5), (9, 0.25)))
    step = max(8, amp // 3)
    return [t // step * step for t in tops]


def sheet_mountains() -> Canvas:
    c = Canvas(1024, 512)
    tops = skyline(1024, 430, 190, 11)
    # far layer: paint first, slightly higher and lighter
    far_tops = [t - 46 for t in skyline(1024, 430, 150, 12)]
    paint_ridge(c, far_tops, (44, 58, 110), (30, 40, 84), (94, 180, 220, 255), None, 13)
    paint_ridge(c, tops, (26, 34, 72), (13, 17, 44), (77, 227, 247, 235), (20, 28, 60), 14)
    return c


def sheet_desert_mountains() -> Canvas:
    c = Canvas(1024, 512)
    paint_ridge(c, buttes(1024, 440, 200, 21),
                (64, 44, 78), (30, 22, 52), (255, 176, 120, 235), (52, 36, 66), 22)
    return c


def sheet_desert_mountains2() -> Canvas:
    c = Canvas(1024, 512)
    far = [t - 40 for t in skyline(1024, 450, 90, 23, waves=((4, 1.0), (8, 0.3)))]
    paint_ridge(c, far, (58, 40, 72), (38, 26, 54), (200, 140, 160, 200), None, 24)
    paint_ridge(c, buttes(1024, 445, 170, 25),
                (48, 32, 62), (22, 16, 40), (255, 190, 130, 235), (40, 27, 52), 26)
    return c


def sheet_winter_mountains() -> Canvas:
    c = Canvas(1024, 512)
    # one dominant smooth peak per period + low shoulders
    tops = skyline(1024, 470, 260, 31, waves=((1, 1.0), (3, 0.28), (6, 0.12)))
    paint_ridge(c, tops, (52, 84, 140), (22, 36, 72), (150, 220, 245, 235),
                (40, 66, 112), 32, snow=(226, 240, 252, 255), snowline=330)
    return c


def sheet_winter_mountains2() -> Canvas:
    c = Canvas(1024, 512)
    tops = skyline(1024, 460, 220, 33, waves=((2, 1.0), (5, 0.4), (11, 0.15)))
    paint_ridge(c, tops, (48, 78, 132), (20, 33, 66), (150, 220, 245, 235),
                (38, 62, 106), 34, snow=(226, 240, 252, 255), snowline=340)
    return c


def sheet_winter_mountains3() -> Canvas:
    c = Canvas(1024, 512)
    far = [t - 60 for t in skyline(1024, 470, 170, 35, waves=((3, 1.0), (7, 0.35)))]
    paint_ridge(c, far, (56, 88, 146), (34, 54, 96), (170, 225, 245, 200), None, 36)
    tops = skyline(1024, 475, 200, 37, waves=((2, 1.0), (4, 0.55), (9, 0.2)))
    paint_ridge(c, tops, (44, 72, 124), (18, 30, 60), (150, 220, 245, 235),
                (34, 56, 98), 38, snow=(222, 238, 250, 255), snowline=360)
    return c


# ----------------------------------------------------------------------------
# jungle layers
# ----------------------------------------------------------------------------

def _blob_row(c: Canvas, y0: int, y1: int, seed: int, n: int,
              color: tuple, rmin: int, rmax: int, wrap: bool = True) -> None:
    rng = random.Random(seed)
    w = c.w
    for _ in range(n):
        cx = rng.randrange(w)
        cy = rng.randrange(y0, y1)
        r = rng.randrange(rmin, rmax)
        for ox in (-w, 0, w) if wrap else (0,):
            c.circle(cx + ox, cy, r, color)


def sheet_jungle_background() -> Canvas:
    w, h = 809, 1312
    c = Canvas(w, h)
    # canopy mass: dark base, mid layer, cyan-kissed top edge
    _blob_row(c, 0, 760, 41, 90, (18, 40, 52, 255), 40, 110)
    _blob_row(c, 0, 640, 42, 70, (26, 62, 66, 255), 30, 80)
    _blob_row(c, 0, 300, 43, 40, (46, 110, 104, 255), 20, 55)
    # leaf speckle on the canopy
    c.speckle(0, 0, w, 700, 44, (120, 230, 200, 160), 0.012)
    # trunks: verticals with roots, wrapped
    rng = random.Random(45)
    for _ in range(14):
        x = rng.randrange(w)
        thick = rng.randrange(10, 26)
        top = rng.randrange(500, 800)
        for ox in (-w, 0, w):
            c.rect(x + ox - thick // 2, top, x + ox + thick // 2, h - 160, (24, 30, 44, 255))
            c.rect(x + ox - thick // 2, top, x + ox - thick // 2 + 3, h - 160, (70, 120, 110, 200))
    # undergrowth band at the bottom
    _blob_row(c, h - 260, h, 46, 60, (20, 48, 50, 255), 25, 70)
    _blob_row(c, h - 160, h, 47, 40, (52, 120, 108, 255), 12, 40)
    c.speckle(0, h - 200, w, h, 48, (140, 240, 210, 170), 0.015)
    return c


def sheet_jungle_midground() -> Canvas:
    w, h = 1024, 1024
    c = Canvas(w, h)
    # canopy band across the top third, transparent breathing room below it
    _blob_row(c, 0, 300, 51, 80, (22, 52, 58, 255), 35, 95)
    _blob_row(c, 0, 220, 52, 55, (40, 96, 90, 255), 22, 60)
    _blob_row(c, 0, 110, 53, 30, (80, 170, 150, 255), 12, 34)
    c.speckle(0, 0, w, 280, 54, (150, 240, 210, 150), 0.010)
    # hanging vines from the canopy
    rng = random.Random(55)
    for _ in range(26):
        x = rng.randrange(w)
        length = rng.randrange(60, 200)
        c.vline(x, 250, 250 + length, (30, 80, 72, 220))
        c.circle(x, 250 + length, 6, (60, 150, 130, 220))
    # grass band along the bottom edge (integer periods => seamless wrap)
    for x in range(w):
        t = x / w * 2 * math.pi
        gh = 60 + int(40 * (0.5 + 0.5 * math.sin(3 * t + 1.0)) * math.sin(7 * t))
        c.vline(x, h - gh, h, (26, 66, 60, 255))
    _blob_row(c, h - 120, h, 56, 50, (52, 130, 112, 255), 10, 30)
    return c


# ----------------------------------------------------------------------------
# clouds
# ----------------------------------------------------------------------------

def _puff(c: Canvas, cx: int, cy: int, r: int, seed: int, body: tuple, light: tuple) -> None:
    rng = random.Random(seed)
    for _ in range(16):
        ox = rng.randrange(-r * 85 // 100, r * 85 // 100)
        oy = rng.randrange(-r * 45 // 100, r * 45 // 100)
        rr = rng.randrange(r // 2, r)
        c.circle(cx + ox, cy + oy, rr, body)
    x0, x1 = max(0, cx - 2 * r), min(c.w, cx + 2 * r)
    y0, y1 = max(0, cy - 2 * r), min(c.h, cy + 2 * r)
    solid = [[c.px[(y * c.w + x) * 4 + 3] > 100 for x in range(x0, x1)] for y in range(y0, y1)]
    # mottled interior: soft billow patches darker and lighter than the body
    for _ in range(r // 2):
        px = rng.randrange(x0, x1)
        py = rng.randrange(y0, y1)
        if 0 <= py - y0 < y1 - y0 and 0 <= px - x0 < x1 - x0 and solid[py - y0][px - x0]:
            up = rng.random() < 0.5
            col = (170, 205, 235, 36) if up else (12, 20, 44, 40)
            c.circle(px, py, rng.randrange(r // 8, r // 3), col)
    # unify: moonlit silhouette on top-exposed edges, shadow tucked below
    for yy in range(y1 - y0):
        for xx in range(x1 - x0):
            if not solid[yy][xx]:
                continue
            x, y = x0 + xx, y0 + yy
            if yy == 0 or not solid[yy - 1][xx]:
                c.blend(x, y, light[:3] + (225,))
                if yy + 1 < y1 - y0 and solid[yy + 1][xx]:
                    c.blend(x, y + 1, light[:3] + (110,))
                if yy + 2 < y1 - y0 and solid[yy + 2][xx]:
                    c.blend(x, y + 2, light[:3] + (45,))
            elif yy == y1 - y0 - 1 or not solid[yy + 1][xx]:
                c.blend(x, y, (8, 12, 28, 170))


def sheet_bg_cloud1() -> Canvas:
    c = Canvas(2048, 1024)
    _puff(c, 1450, 480, 220, 61, (40, 58, 100, 255), (150, 200, 235, 130))
    _puff(c, 500, 640, 130, 62, (34, 50, 88, 255), (140, 190, 225, 120))
    return c


def sheet_bg_cloud2() -> Canvas:
    c = Canvas(2048, 1024)
    _puff(c, 600, 420, 190, 63, (40, 58, 100, 255), (150, 200, 235, 130))
    _puff(c, 1500, 620, 150, 64, (34, 50, 88, 255), (140, 190, 225, 120))
    _puff(c, 1050, 300, 100, 65, (46, 64, 108, 255), (160, 205, 240, 130))
    return c


def sheet_bg_cloud3() -> Canvas:
    c = Canvas(1024, 512)
    _puff(c, 700, 260, 130, 66, (40, 58, 100, 255), (150, 200, 235, 130))
    _puff(c, 260, 330, 80, 67, (34, 50, 88, 255), (140, 190, 225, 120))
    return c


# ----------------------------------------------------------------------------
# small celestials
# ----------------------------------------------------------------------------

def sheet_snow() -> Canvas:
    c = Canvas(64, 64)
    cx = cy = 32
    # six-arm flake + ring + hot core, centered like the original particle
    for k in range(6):
        a = math.pi * k / 3
        x1, y1 = int(cx + 22 * math.cos(a)), int(cy + 22 * math.sin(a))
        c.line(cx, cy, x1, y1, (190, 235, 250, 255), 3)
        mx, my = int(cx + 13 * math.cos(a)), int(cy + 13 * math.sin(a))
        for s in (-1, 1):
            b = a + s * 0.5
            c.line(mx, my, int(mx + 7 * math.cos(b)), int(my + 7 * math.sin(b)),
                   (190, 235, 250, 220), 2)
    c.circle(cx, cy, 26, (150, 210, 235, 130), fill=False, width=2)
    c.circle(cx, cy, 7, (235, 252, 255, 255))
    c.circle(cx, cy, 4, (77, 227, 247, 255))
    return c


def sheet_stars() -> Canvas:
    w, h = 265, 128
    c = Canvas(w, h)
    rng = random.Random(71)
    # faint wash (wrapped both axes so the strip tiles cleanly)
    for _ in range(26):
        x, y = rng.randrange(w), rng.randrange(h)
        for ox in (-w, 0, w):
            for oy in (-h, 0, h):
                c.disc_gradient(x + ox, y + oy, rng.randrange(8, 22),
                                (70, 90, 150, 26), (70, 90, 150, 0))
    for _ in range(90):
        x, y = rng.randrange(w), rng.randrange(h)
        gold = rng.random() < 0.18
        col = (255, 214, 140, 255) if gold else (216, 238, 252, 255)
        r = 2 if rng.random() < 0.85 else 3
        for ox in (-w, 0, w):
            for oy in (-h, 0, h):
                c.circle(x + ox, y + oy, r, col)
                if r == 3:  # sparkle cross on the bright ones
                    c.hline(x + ox - 5, x + ox + 6, y + oy, col[:3] + (150,))
                    c.vline(x + ox, y + oy - 5, y + oy + 6, col[:3] + (150,))
    return c


def sheet_sun() -> Canvas:
    c = Canvas(512, 512)
    cx = cy = 256
    c.disc_gradient(cx, cy, 210, (255, 236, 190, 255), (255, 176, 60, 255))
    # inner rings, own pattern
    c.circle(cx, cy, 165, (255, 200, 120, 90), fill=False, width=10)
    c.circle(cx, cy, 120, (255, 220, 170, 80), fill=False, width=8)
    # mottling
    rng = random.Random(73)
    for _ in range(26):
        a = rng.uniform(0, 2 * math.pi)
        d = rng.uniform(30, 175)
        x, y = int(cx + d * math.cos(a)), int(cy + d * math.sin(a))
        c.circle(x, y, rng.randrange(6, 18), (255, 150, 60, 60))
    # bright rim + soft outer falloff
    c.circle(cx, cy, 210, (255, 244, 214, 255), fill=False, width=6)
    for r, alpha in ((214, 90), (220, 40), (228, 16)):
        c.circle(cx, cy, r, (255, 220, 150, alpha), fill=False, width=5)
    return c


def sheet_moon() -> Canvas:
    c = Canvas(1024, 1024)
    cx = cy = 512
    c.disc_gradient(cx, cy, 420, (232, 246, 252, 255), (170, 205, 225, 255))
    # craters, own placement
    rng = random.Random(74)
    for _ in range(14):
        a = rng.uniform(0, 2 * math.pi)
        d = rng.uniform(40, 330)
        x, y = int(cx + d * math.cos(a)), int(cy + d * math.sin(a))
        r = rng.randrange(18, 70)
        c.circle(x, y, r, (150, 185, 205, 130))
        c.circle(x - r // 4, y - r // 4, r // 2, (240, 250, 255, 90))
    # maria blotches
    for _ in range(5):
        a = rng.uniform(0, 2 * math.pi)
        d = rng.uniform(60, 280)
        x, y = int(cx + d * math.cos(a)), int(cy + d * math.sin(a))
        c.ellipse(x, y, rng.randrange(50, 110), rng.randrange(35, 70), (160, 195, 215, 70))
    c.circle(cx, cy, 420, (245, 252, 255, 255), fill=False, width=8)
    for r, alpha in ((428, 70), (442, 30), (460, 12)):
        c.circle(cx, cy, r, (200, 230, 245, alpha), fill=False, width=7)
    return c


SHEETS = {
    "mountains.png": sheet_mountains,
    "desert_mountains.png": sheet_desert_mountains,
    "desert_mountains2.png": sheet_desert_mountains2,
    "winter_mountains.png": sheet_winter_mountains,
    "winter_mountains2.png": sheet_winter_mountains2,
    "winter_mountains3.png": sheet_winter_mountains3,
    "jungle_background.png": sheet_jungle_background,
    "jungle_midground.png": sheet_jungle_midground,
    "bg_cloud1.png": sheet_bg_cloud1,
    "bg_cloud2.png": sheet_bg_cloud2,
    "bg_cloud3.png": sheet_bg_cloud3,
    "snow.png": sheet_snow,
    "stars.png": sheet_stars,
    "sun.png": sheet_sun,
    "moon.png": sheet_moon,
}


def main() -> int:
    for name, fn in SHEETS.items():
        canvas = fn()
        check_dims(name, canvas)
        canvas.save(MAPRES / name)
        print(f"  painted {name} ({canvas.w}x{canvas.h})")
    print(f"background pass done: {len(SHEETS)} sheets")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
