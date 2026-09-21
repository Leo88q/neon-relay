#!/usr/bin/env python3
"""Original terrain, marker and doodad tilesets for the shipped mapres sheets.

Covers the 12 tile sheets referenced by shipped maps: the four ``*_main``
terrain sets, the four gameplay-marker sets (unhookable / deathtiles) and
the four ``*_doodad`` decoration sets.

Method (per sheet):

* The upstream pixels are read for geometry only: per-cell alpha masks and
  the used/empty cell grid. Masks encode tile connectivity (which edges a
  cell exposes), a functional interface dictated by placed tile ids in the
  shipped maps — like an API. No upstream color or texture is reused.
* Autotile cells (terrain connectivity + all marker cells): the sheet is
  filled with a new continuous theme texture (continuous so neighboring
  cells join seamlessly in-game), cut by the exact upstream alpha, then
  styled along the mask boundary with original rim light / caps / shading.
* Decoration cells: pixel-connected components are measured; sub-prop
  fragments (blades, dots) become themed ground scatter, while bigger
  connected art is classified by shape (single / run / pole / feature /
  mass) and painted with original parametric prop painters scaled to the
  fragment's own pixel footprint. Empty cells stay empty.

Stdlib only (see scripts/neon_png.py).
"""

from __future__ import annotations

import math
import random
import sys

sys.path.insert(0, str(__file__ and __import__("pathlib").Path(__file__).resolve().parent))

from neon_png import Canvas, read_png, png_info  # noqa: E402
import pathlib  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
MAPRES = ROOT / "data" / "mapres"
CELL = 64
DETAIL_PX = 150  # smaller fragments become ground scatter, not props


def check_dims(name: str, canvas: Canvas) -> None:
    w, h, _, _ = png_info(MAPRES / name)
    assert (canvas.w, canvas.h) == (w, h), f"{name}: want {w}x{h}"


def solid_field(px: bytes | bytearray, w: int, h: int, threshold: int = 100) -> bytearray:
    out = bytearray(w * h)
    for i in range(w * h):
        out[i] = 1 if px[i * 4 + 3] > threshold else 0
    return out


def used_grid(solid: bytes | bytearray, w: int, h: int) -> list[list[bool]]:
    cols, rows = w // CELL, h // CELL
    grid = [[False] * cols for _ in range(rows)]
    for cy in range(rows):
        for cx in range(cols):
            n = 0
            for y in range(cy * CELL, (cy + 1) * CELL):
                base = y * w + cx * CELL
                for x in range(CELL):
                    n += solid[base + x]
            grid[cy][cx] = n > 50
    return grid


# ----------------------------------------------------------------------------
# theme fills (painted over the whole sheet, then cut by the alpha mask)
# ----------------------------------------------------------------------------

def paint_fill(c: Canvas, seed: int, deep: tuple, mid: tuple, pale: tuple,
               strata_every: int = 18, strata_col: tuple | None = None) -> None:
    """Continuous cloudy fill + horizontal strata + speckle."""
    w, h = c.w, c.h
    rng = random.Random(seed)
    gw, gh = 48, 48
    grid = [[rng.random() for _ in range(gw + 1)] for _ in range(gh + 1)]
    for y in range(gh + 1):
        grid[y][gw] = grid[y][0]
    grid[gh] = list(grid[0])
    for y in range(h):
        fy = y / h * gh
        gy = int(fy)
        ty = fy - gy
        ty = ty * ty * (3 - 2 * ty)
        for x in range(w):
            fx = x / w * gw
            gx = int(fx)
            tx = fx - gx
            tx = tx * tx * (3 - 2 * tx)
            v = (grid[gy][gx] * (1 - tx) + grid[gy][gx + 1] * tx) * (1 - ty) + \
                (grid[gy + 1][gx] * (1 - tx) + grid[gy + 1][gx + 1] * tx) * ty
            if v < 0.5:
                t = v * 2
                col = tuple(int(deep[i] + (mid[i] - deep[i]) * t) for i in range(3))
            else:
                t = v * 2 - 1
                col = tuple(int(mid[i] + (pale[i] - mid[i]) * t) for i in range(3))
            if strata_col is not None and (y + int(v * 9)) % strata_every < 2:
                col = strata_col
            c.set(x, y, col + (255,))
    c.speckle(0, 0, w, h, seed + 1, pale + (70,), 0.02)
    c.speckle(0, 0, w, h, seed + 2, deep + (90,), 0.02)


def apply_mask_and_style(c: Canvas, solid: bytes | bytearray, mask_cells,
                         rim: tuple, cap: tuple, cap_depth: int,
                         shadow: tuple = (6, 8, 18, 110)) -> None:
    """Cut canvas alpha by the upstream mask; style exposed boundaries."""
    w, h = c.w, c.h
    for y in range(h):
        cy = y // CELL
        for x in range(w):
            i = y * w + x
            if not solid[i] or not mask_cells[cy][x // CELL]:
                c.px[i * 4 + 3] = 0
    for y in range(h):
        cy = y // CELL
        for x in range(w):
            if not mask_cells[cy][x // CELL]:
                continue
            i = y * w + x
            if not solid[i]:
                continue
            up = solid[i - w] if y > 0 else 0
            if not up:
                c.set(x, y, rim)
                for d in range(1, cap_depth):
                    yy = y + d
                    if yy < h and solid[yy * w + x]:
                        t = d / cap_depth
                        col = tuple(int(cap[j] + (rim[j] - cap[j]) * (1 - t)) for j in range(3))
                        c.blend(x, yy, col + (200,))
                    else:
                        break
            else:
                dn = solid[i + w] if y < h - 1 else 0
                lf = solid[i - 1] if x > 0 else 0
                rt = solid[i + 1] if x < w - 1 else 0
                if not dn:
                    c.blend(x, y, shadow)
                elif not lf or not rt:
                    c.blend(x, y, shadow[:3] + (60,))


# ----------------------------------------------------------------------------
# decor components: pixel-connected art -> cells + size + footprint
# ----------------------------------------------------------------------------

def components(solid: bytes | bytearray, w: int, h: int,
               grid: list[list[bool]], decor_ok):
    """Pixel-connected components inside decor+used cells.

    Cell-grid adjacency would fuse whole doodad sheets into one blob (cells
    are densely packed); only art that actually touches across a cell
    boundary belongs to one picture (fence runs, statues), while gapped
    neighbors stay separate. Returns (cells, pixel_count, pixel_bbox).
    """
    cols, rows = w // CELL, h // CELL
    eligible = bytearray(w * h)
    for cy in range(rows):
        for cx in range(cols):
            if grid[cy][cx] and decor_ok(cy, cx):
                for y in range(cy * CELL, (cy + 1) * CELL):
                    base = y * w + cx * CELL
                    for x in range(CELL):
                        eligible[base + x] = solid[base + x]
    seen = bytearray(w * h)
    out = []
    for sy in range(h):
        for sx in range(w):
            si = sy * w + sx
            if seen[si] or not eligible[si]:
                continue
            cells: set[tuple[int, int]] = set()
            npix = 0
            bx0, by0, bx1, by1 = sx, sy, sx, sy
            stack = [(sx, sy)]
            seen[si] = 1
            while stack:
                x, y = stack.pop()
                cells.add((x // CELL, y // CELL))
                npix += 1
                if x < bx0:
                    bx0 = x
                elif x > bx1:
                    bx1 = x
                if y < by0:
                    by0 = y
                elif y > by1:
                    by1 = y
                if x > 0 and eligible[y * w + x - 1] and not seen[y * w + x - 1]:
                    seen[y * w + x - 1] = 1
                    stack.append((x - 1, y))
                if x < w - 1 and eligible[y * w + x + 1] and not seen[y * w + x + 1]:
                    seen[y * w + x + 1] = 1
                    stack.append((x + 1, y))
                if y > 0 and eligible[(y - 1) * w + x] and not seen[(y - 1) * w + x]:
                    seen[(y - 1) * w + x] = 1
                    stack.append((x, y - 1))
                if y < h - 1 and eligible[(y + 1) * w + x] and not seen[(y + 1) * w + x]:
                    seen[(y + 1) * w + x] = 1
                    stack.append((x, y + 1))
            out.append((sorted(cells), npix, (bx0, by0, bx1, by1)))
    return out


# ----------------------------------------------------------------------------
# single-cell props (scale-aware: sized by the fragment's own footprint)
# ----------------------------------------------------------------------------

def _unit(x0, y0, x1, y1) -> float:
    return max(0.2, min(x1 - x0, y1 - y0) / 64.0)


def p_bush(t: Canvas, x0, y0, x1, y1, rng, pal) -> None:
    u = _unit(x0, y0, x1, y1)
    cx, ground = (x0 + x1) // 2, y1 - max(2, int(6 * u))
    n = max(2, int(6 * (x1 - x0) * (y1 - y0) / 4096))
    for _ in range(n):
        t.circle(cx + rng.randrange(-int(18 * u), int(18 * u) + 1),
                 ground - rng.randrange(int(8 * u), int(30 * u) + 1),
                 max(1, rng.randrange(int(10 * u), int(20 * u) + 1)), pal["leaf"])
    t.speckle(x0, y0, x1, y1, rng.randrange(9999), pal["leaf_light"], 0.03)


def p_rock(t: Canvas, x0, y0, x1, y1, rng, pal) -> None:
    u = _unit(x0, y0, x1, y1)
    cx, ground = (x0 + x1) // 2, y1 - max(1, int(4 * u))
    rw = max(2, rng.randrange(int(16 * u), int(26 * u) + 1))
    rh = max(2, rng.randrange(int(14 * u), int(24 * u) + 1))
    t.ellipse(cx, ground - rh, rw, rh, pal["stone"])
    t.ellipse(cx - rw // 3, ground - rh - rh // 3, max(1, rw // 2), max(1, rh // 3),
              pal["stone_light"])
    if u > 0.4:
        t.line(cx - 4, ground - rh * 2 + 4, cx + 3, ground - 8, pal["crack"], 1)


def p_tuft(t: Canvas, x0, y0, x1, y1, rng, pal) -> None:
    u = _unit(x0, y0, x1, y1)
    cx, ground = (x0 + x1) // 2, y1 - max(1, int(4 * u))
    n = max(2, int(9 * (x1 - x0) * (y1 - y0) / 4096))
    for _ in range(n):
        tipx = cx + rng.randrange(-int(20 * u), int(20 * u) + 1)
        t.line(cx + rng.randrange(-int(6 * u), int(6 * u) + 1), ground,
               tipx, ground - rng.randrange(int(12 * u), int(30 * u) + 1),
               pal["leaf"], 2 if u > 0.5 else 1)


def p_crystal(t: Canvas, x0, y0, x1, y1, rng, pal) -> None:
    u = _unit(x0, y0, x1, y1)
    cx, ground = (x0 + x1) // 2, y1 - max(1, int(4 * u))
    for _ in range(rng.randrange(1, 4)):
        bx = cx + rng.randrange(-int(14 * u), int(14 * u) + 1)
        hh = rng.randrange(int(20 * u), int(44 * u) + 1)
        ww = max(1, rng.randrange(int(5 * u), int(9 * u) + 1))
        lean = rng.randrange(-int(6 * u), int(6 * u) + 1)
        wdt = 2 if u > 0.5 else 1
        t.line(bx - ww, ground, bx + lean, ground - hh, pal["crystal"], wdt)
        t.line(bx + ww, ground, bx + lean, ground - hh, pal["crystal"], wdt)
        t.line(bx - ww, ground, bx + ww, ground, pal["crystal"], wdt)
        t.circle(bx + lean // 2, ground - hh // 2, max(1, int(3 * u)),
                 pal["crystal_hot"])


def p_lantern(t: Canvas, x0, y0, x1, y1, rng, pal) -> None:
    u = _unit(x0, y0, x1, y1)
    cx, ground = (x0 + x1) // 2, y1 - 2
    arm = max(4, int(10 * u))
    t.vline(cx, y0 + 4, ground, pal["wood"])
    if u > 0.5:
        t.vline(cx + 1, y0 + 4, ground, pal["wood"])
    t.hline(cx - arm, cx + arm, y0 + 6, pal["wood"])
    lx = cx + rng.choice((-arm, arm))
    lamp = max(2, int(5 * u))
    t.vline(lx, y0 + 6, y0 + 6 + lamp, pal["wood"])
    t.rect(lx - lamp, y0 + 6 + lamp, lx + lamp, y0 + 6 + lamp * 2, pal["lamp"])
    t.circle(lx, y0 + 6 + lamp * 2 - 2, max(2, int(9 * u)), pal["lamp_glow"])


def p_cactus(t: Canvas, x0, y0, x1, y1, rng, pal) -> None:
    u = _unit(x0, y0, x1, y1)
    cx, ground = (x0 + x1) // 2, y1 - max(1, int(4 * u))
    hh = rng.randrange(int(30 * u), int(48 * u) + 1)
    hw = max(1, int(5 * u))
    t.rect(cx - hw, ground - hh, cx + hw, ground, pal["leaf"])
    t.circle(cx, ground - hh, hw, pal["leaf"])
    for s in (-1, 1):
        if rng.random() < 0.8:
            ay = ground - rng.randrange(int(12 * u), max(int(12 * u) + 1, hh - int(8 * u)))
            ahw = max(1, int(3 * u))
            t.rect(cx + s * hw - ahw, ay - int(12 * u), cx + s * hw + ahw, ay + 2, pal["leaf"])
            t.rect(cx, ay - 2, cx + s * (hw + 3), ay + 2, pal["leaf"])
            t.circle(cx + s * hw, ay - int(12 * u), ahw, pal["leaf"])


def p_barrel(t: Canvas, x0, y0, x1, y1, rng, pal) -> None:
    u = _unit(x0, y0, x1, y1)
    cx, ground = (x0 + x1) // 2, y1 - max(1, int(4 * u))
    rw = max(3, int(16 * u))
    rh = max(4, int(22 * u))
    t.ellipse(cx, ground - rh, rw, max(2, rw // 2), pal["wood_dark"])
    t.rect(cx - rw, ground - rh, cx + rw, ground - 2, pal["wood"])
    t.ellipse(cx, ground - 2, rw, max(1, rw // 3), pal["wood_dark"])
    for f in (0.35, 0.65):
        yy = ground - int(rh * f)
        t.hline(cx - rw, cx + rw, yy, pal["metal"])


def p_signpost(t: Canvas, x0, y0, x1, y1, rng, pal) -> None:
    u = _unit(x0, y0, x1, y1)
    cx, ground = (x0 + x1) // 2, y1 - 2
    t.vline(cx, y0 + 6, ground, pal["wood"])
    if u > 0.5:
        t.vline(cx + 1, y0 + 6, ground, pal["wood"])
    bl = max(6, int(22 * u))
    bh = max(3, int(8 * u))
    for i, yy in enumerate((y0 + int(12 * u), y0 + int(24 * u))):
        if yy + bh > ground:
            break
        s = 1 if (i + rng.randrange(2)) % 2 == 0 else -1
        x_from, x_to = (cx, cx + s * bl) if s > 0 else (cx + s * bl, cx)
        t.rect(x_from, yy, x_to, yy + bh, pal["wood_light"])
        t.line(x_to, yy, x_to + s * max(2, bl // 3), yy + bh // 2, pal["wood_light"], 1)
        t.line(x_to + s * max(2, bl // 3), yy + bh // 2, x_to, yy + bh, pal["wood_light"], 1)


def p_pine(t: Canvas, x0, y0, x1, y1, rng, pal) -> None:
    u = _unit(x0, y0, x1, y1)
    cx, ground = (x0 + x1) // 2, y1 - 2
    t.rect(cx - max(1, int(3 * u)), ground - int(10 * u), cx + max(1, int(3 * u)),
           ground, pal["wood"])
    tiers = 3 if u > 0.45 else 2
    for i in range(tiers):
        yy = ground - int(10 * u) - i * max(4, int(12 * u))
        half = max(2, int((20 - i * 5) * u))
        th = max(3, int(12 * u))
        for d in range(th):
            inset = d * half // th
            t.hline(cx - half + inset, cx + half - inset, yy - d, pal["leaf"])
        t.hline(cx - half + 2, cx + half - 2, yy - th + 1, pal["snow"])


def p_snowbeing(t: Canvas, x0, y0, x1, y1, rng, pal) -> None:
    u = _unit(x0, y0, x1, y1)
    cx, ground = (x0 + x1) // 2, y1 - max(1, int(4 * u))
    r1, r2 = max(2, int(13 * u)), max(2, int(9 * u))
    t.circle(cx, ground - r1, r1, pal["snow"])
    t.circle(cx, ground - 2 * r1 - r2 + 2, r2, pal["snow"])
    hy = ground - 2 * r1 - r2 + 2
    if u > 0.45:
        e = max(1, int(3 * u))
        t.rect(cx - r2 // 2 - e, hy - 2, cx - r2 // 2 + e, hy + 2, pal["coal"])
        t.rect(cx + r2 // 2 - e, hy - 2, cx + r2 // 2 + e, hy + 2, pal["coal"])
        t.hline(cx - r2, cx + r2, hy + r2, pal["scarf"])
        t.hline(cx - r2, cx + r2, hy + r2 + 1, pal["scarf"])


# -- ground scatter (replaces sub-prop detail: blades, pebbles, shards) -----

def s_grass(t: Canvas, cx: int, cy: int, rng, pal) -> None:
    x0, y0 = cx * CELL, cy * CELL
    for _ in range(rng.randrange(8, 15)):
        bx = x0 + rng.randrange(6, 58)
        t.line(bx, y0 + rng.randrange(40, 60), bx + rng.randrange(-8, 8),
               y0 + rng.randrange(18, 38), pal["leaf"], 2)
    for _ in range(rng.randrange(2, 5)):
        t.circle(x0 + rng.randrange(6, 58), y0 + rng.randrange(44, 58),
                 rng.randrange(2, 4), pal["stone"])
    for _ in range(rng.randrange(0, 3)):
        fx, fy = x0 + rng.randrange(10, 54), y0 + rng.randrange(30, 50)
        t.vline(fx, fy, fy + 8, pal["leaf"])
        t.circle(fx, fy, 3, pal["bloom"])


def s_desert(t: Canvas, cx: int, cy: int, rng, pal) -> None:
    x0, y0 = cx * CELL, cy * CELL
    for _ in range(rng.randrange(4, 9)):
        t.circle(x0 + rng.randrange(6, 58), y0 + rng.randrange(40, 58),
                 rng.randrange(2, 5), pal["stone"])
    for _ in range(rng.randrange(2, 5)):
        bx = x0 + rng.randrange(6, 58)
        t.line(bx, y0 + 58, bx + rng.randrange(-6, 6), y0 + rng.randrange(38, 48),
               pal["wood_light"], 2)
    for _ in range(rng.randrange(0, 2)):
        sx, sy = x0 + rng.randrange(10, 50), y0 + rng.randrange(42, 54)
        t.line(sx, sy, sx + 8, sy, pal["gold"], 2)
        t.line(sx, sy, sx + 4, sy - 6, pal["gold"], 2)
        t.line(sx + 4, sy - 6, sx + 8, sy, pal["gold"], 2)


def s_jungle(t: Canvas, cx: int, cy: int, rng, pal) -> None:
    x0, y0 = cx * CELL, cy * CELL
    for _ in range(rng.randrange(6, 11)):
        t.ellipse(x0 + rng.randrange(8, 56), y0 + rng.randrange(20, 56),
                  rng.randrange(4, 8), rng.randrange(2, 4), pal["leaf"])
    for _ in range(rng.randrange(1, 4)):
        mx, my = x0 + rng.randrange(10, 54), y0 + rng.randrange(40, 56)
        t.vline(mx, my - 6, my, pal["wood_light"])
        t.circle(mx, my - 7, 4, pal["bloom"])
    for _ in range(rng.randrange(2, 4)):
        t.circle(x0 + rng.randrange(6, 58), y0 + rng.randrange(44, 58),
                 rng.randrange(2, 4), pal["stone"])


def s_winter(t: Canvas, cx: int, cy: int, rng, pal) -> None:
    x0, y0 = cx * CELL, cy * CELL
    for _ in range(rng.randrange(4, 9)):
        t.circle(x0 + rng.randrange(6, 58), y0 + rng.randrange(36, 58),
                 rng.randrange(3, 7), pal["snow"])
    for _ in range(rng.randrange(2, 5)):
        ix = x0 + rng.randrange(8, 56)
        t.line(ix, y0 + rng.randrange(48, 56), ix + rng.randrange(-4, 4),
               y0 + rng.randrange(30, 42), pal["ice"], 2)
    for _ in range(rng.randrange(1, 3)):
        t.circle(x0 + rng.randrange(6, 58), y0 + rng.randrange(44, 58),
                 rng.randrange(2, 3), pal["stone"])


# -- horizontal runs ----------------------------------------------------------

def p_fence(t: Canvas, x0, y0, x1, y1, rng, pal) -> None:
    ground = y1 - 6
    for x in range(x0 + 8, x1 - 4, 26):
        t.rect(x - 3, ground - 30, x + 3, ground, pal["wood"])
        t.circle(x, ground - 30, 3, pal["wood"])
    for yy in (ground - 24, ground - 12):
        t.rect(x0, yy, x1, yy + 3, pal["wood_light"])


def p_garland(t: Canvas, x0, y0, x1, y1, rng, pal) -> None:
    top = y0 + 8
    for x in range(x0 + 8, x1 - 4, 52):
        t.rect(x - 2, top - 6, x + 2, top + 34, pal["wood"])
    x = x0 + 8
    while x < x1 - 8:
        nx = min(x + 52, x1 - 8)
        for i in range(9):
            t0, t1 = i / 8, (i + 1) / 8
            sx = int(x + (nx - x) * t0)
            ex = int(x + (nx - x) * t1)
            sy = top + int(16 * 4 * t0 * (1 - t0))
            ey = top + int(16 * 4 * t1 * (1 - t1))
            t.line(sx, sy, ex, ey, pal["metal"], 1)
            if i % 2 == 0:
                t.circle(sx, sy + 2, 3, pal["lamp"])
                t.circle(sx, sy + 2, 6, pal["lamp_glow"])
        x = nx


# -- vertical poles -----------------------------------------------------------

def p_totem(t: Canvas, x0, y0, x1, y1, rng, pal) -> None:
    cx = (x0 + x1) // 2
    half = min(14, (x1 - x0) // 2 - 4)
    t.rect(cx - half, y0 + 2, cx + half, y1 - 2, pal["stone"])
    t.rect(cx - half, y0 + 2, cx - half + 3, y1 - 2, pal["stone_light"])
    nfaces = max(1, (y1 - y0) // 64)
    for f in range(nfaces):
        fy = y0 + 12 + f * 64
        if fy + 20 > y1 - 4:
            break
        t.rect(cx - 8, fy, cx - 3, fy + 6, pal["eye"])
        t.rect(cx + 3, fy, cx + 8, fy + 6, pal["eye"])
        t.rect(cx - 6, fy + 12, cx + 6, fy + 15, pal["eye"])
    t.rect(cx - half - 2, y0, cx + half + 2, y0 + 4, pal["stone_light"])


def p_vinepole(t: Canvas, x0, y0, x1, y1, rng, pal) -> None:
    cx = (x0 + x1) // 2
    for y in range(y0, y1, 4):
        sway = int(6 * math.sin(y * 0.09 + rng.random()))
        t.set(cx + sway, y, pal["leaf"])
        t.set(cx + sway + 1, y, pal["leaf"])
        if y % 16 == 0:
            t.ellipse(cx + sway + 6, y, 6, 3, pal["leaf"])
            t.ellipse(cx + sway - 6, y + 8, 6, 3, pal["leaf"])


def p_icicles(t: Canvas, x0, y0, x1, y1, rng, pal) -> None:
    t.rect(x0, y0, x1, y0 + 8, pal["snow"])
    x = x0 + 6
    while x < x1 - 4:
        length = rng.randrange(14, (y1 - y0) - 10)
        ww = rng.randrange(3, 6)
        for d in range(length):
            half = max(1, ww * (length - d) // length)
            t.hline(x - half, x + half, y0 + 8 + d, pal["ice"])
        t.vline(x, y0 + 8, y0 + 8 + length // 2, pal["snow"])
        x += ww * 2 + rng.randrange(4, 10)


# -- multi-cell features ------------------------------------------------------

def p_statue(t: Canvas, x0, y0, x1, y1, rng, pal) -> None:
    cx, ground = (x0 + x1) // 2, y1 - 2
    third = (x1 - x0) // 3
    t.rect(x0 + 4, ground - 12, x1 - 4, ground, pal["stone"])
    t.rect(cx - third // 2, ground - (y1 - y0) // 2, cx + third // 2, ground - 12,
           pal["stone"])
    hy = ground - (y1 - y0) // 2
    t.circle(cx, hy - 12, 12, pal["stone"])
    t.rect(cx - 12, hy - 20, cx + 12, hy - 16, pal["stone_light"])
    t.rect(cx - 7, hy - 14, cx - 2, hy - 8, pal["eye"])
    t.rect(cx + 2, hy - 14, cx + 7, hy - 8, pal["eye"])
    t.rect(cx - third // 2, ground - (y1 - y0) // 2,
           cx - third // 2 + 3, ground - 12, pal["stone_light"])


def p_tree(t: Canvas, x0, y0, x1, y1, rng, pal) -> None:
    cx, ground = (x0 + x1) // 2, y1 - 2
    t.rect(cx - 6, ground - (y1 - y0) // 2, cx + 6, ground, pal["wood"])
    for _ in range(10):
        t.circle(cx + rng.randrange(-(x1 - x0) // 3, (x1 - x0) // 3),
                 y0 + rng.randrange(6, (y1 - y0) // 2),
                 rng.randrange(12, 26), pal["leaf"])
    t.speckle(x0, y0, x1, (y0 + y1) // 2, rng.randrange(9999), pal["leaf_light"], 0.04)


def p_arch(t: Canvas, x0, y0, x1, y1, rng, pal) -> None:
    leg = min(18, (x1 - x0) // 6)
    t.rect(x0 + 2, y0 + 10, x0 + 2 + leg, y1 - 2, pal["stone"])
    t.rect(x1 - 2 - leg, y0 + 10, x1 - 2, y1 - 2, pal["stone"])
    t.rect(x0 + 2, y0 + 2, x1 - 2, y0 + 12, pal["stone"])
    t.rect(x0 + 2, y0 + 2, x1 - 2, y0 + 5, pal["stone_light"])
    t.rect(x0 + 2, y0 + 10, x0 + 5, y1 - 2, pal["stone_light"])
    t.rect(x1 - 5, y0 + 10, x1 - 2, y1 - 2, pal["stone_light"])


def p_idol(t: Canvas, x0, y0, x1, y1, rng, pal) -> None:
    cx, ground = (x0 + x1) // 2, y1 - 2
    w2 = (x1 - x0) // 2 - 6
    t.rect(cx - w2, ground - (y1 - y0) + 10, cx + w2, ground, pal["gold"])
    t.rect(cx - w2, ground - (y1 - y0) + 10, cx + w2, ground - (y1 - y0) + 16,
           pal["gold_light"])
    ey = ground - (y1 - y0) + 30
    t.circle(cx - w2 // 2, ey, 7, pal["eye"])
    t.circle(cx + w2 // 2, ey, 7, pal["eye"])
    t.circle(cx - w2 // 2, ey, 3, pal["eye_hot"])
    t.circle(cx + w2 // 2, ey, 3, pal["eye_hot"])
    t.rect(cx - 10, ey + 16, cx + 10, ey + 20, pal["eye"])


# -- masses -------------------------------------------------------------------

def p_ruin(t: Canvas, x0, y0, x1, y1, rng, pal) -> None:
    ground = y1 - 2
    x = x0 + 2
    while x < x1 - 6:
        bw = rng.randrange(14, 30)
        bh = rng.randrange(20, y1 - y0 - 8)
        t.rect(x, ground - bh, x + bw, ground, pal["stone"])
        t.rect(x, ground - bh, x + bw, ground - bh + 3, pal["stone_light"])
        if rng.random() < 0.5:
            wy = ground - bh // 2
            t.rect(x + 3, wy, x + bw - 3, wy + 8, (8, 10, 20, 255))
        x += bw + rng.randrange(2, 10)


def p_foliage(t: Canvas, x0, y0, x1, y1, rng, pal) -> None:
    for _ in range((x1 - x0) * (y1 - y0) // 900):
        t.circle(rng.randrange(x0, x1), rng.randrange(y0, y1),
                 rng.randrange(12, 30), pal["leaf"])
    t.speckle(x0, y0, x1, y1, rng.randrange(9999), pal["leaf_light"], 0.03)
    for _ in range((x1 - x0) // 40):
        t.circle(rng.randrange(x0, x1), rng.randrange(y0, y1), 4, pal["bloom"])


def p_rockwall(t: Canvas, x0, y0, x1, y1, rng, pal) -> None:
    t.rect(x0, y0, x1, y1, pal["stone"])
    for yy in range(y0 + 10, y1, 20):
        t.hline(x0, x1, yy, pal["crack"])
        for xx in range(x0 + rng.randrange(8, 20), x1, 26):
            t.vline(xx, yy, min(yy + 20, y1), pal["crack"])
    t.rect(x0, y0, x1, y0 + 5, pal["stone_light"])


# ----------------------------------------------------------------------------
# palettes + sheet configs
# ----------------------------------------------------------------------------

PAL_GRASS = {
    "leaf": (34, 110, 88, 255), "leaf_light": (120, 235, 195, 255),
    "stone": (44, 54, 84, 255), "stone_light": (110, 130, 175, 255),
    "crack": (16, 20, 36, 255), "crystal": (77, 227, 247, 255),
    "crystal_hot": (230, 252, 255, 255), "wood": (96, 66, 44, 255),
    "wood_light": (150, 108, 72, 255), "wood_dark": (60, 40, 28, 255),
    "metal": (140, 150, 175, 255), "lamp": (255, 220, 150, 255),
    "lamp_glow": (255, 200, 120, 60), "eye": (10, 14, 26, 255),
    "eye_hot": (77, 227, 247, 255),
    "gold": (140, 110, 60, 255), "gold_light": (220, 180, 110, 255),
    "bloom": (255, 120, 170, 255),
}
PAL_DESERT = {
    "leaf": (52, 120, 84, 255), "leaf_light": (140, 230, 170, 255),
    "stone": (88, 64, 88, 255), "stone_light": (165, 135, 170, 255),
    "crack": (30, 20, 40, 255), "crystal": (255, 176, 120, 255),
    "crystal_hot": (255, 240, 220, 255), "wood": (110, 76, 48, 255),
    "wood_light": (170, 122, 78, 255), "wood_dark": (70, 46, 30, 255),
    "metal": (150, 140, 160, 255), "lamp": (255, 220, 150, 255),
    "lamp_glow": (255, 200, 120, 60), "eye": (12, 10, 22, 255),
    "eye_hot": (255, 200, 120, 255),
    "gold": (150, 110, 50, 255), "gold_light": (230, 190, 110, 255),
    "bloom": (255, 150, 120, 255),
}
PAL_JUNGLE = {
    "leaf": (30, 110, 80, 255), "leaf_light": (130, 240, 180, 255),
    "stone": (52, 58, 80, 255), "stone_light": (120, 135, 165, 255),
    "crack": (14, 20, 30, 255), "crystal": (120, 255, 200, 255),
    "crystal_hot": (235, 255, 245, 255), "wood": (90, 62, 44, 255),
    "wood_light": (145, 102, 68, 255), "wood_dark": (56, 38, 26, 255),
    "metal": (135, 145, 165, 255), "lamp": (255, 220, 150, 255),
    "lamp_glow": (255, 200, 120, 60), "eye": (200, 60, 80, 255),
    "eye_hot": (255, 220, 150, 255),
    "gold": (150, 110, 50, 255), "gold_light": (230, 190, 110, 255),
    "bloom": (255, 90, 140, 255),
}
PAL_WINTER = {
    "leaf": (40, 90, 90, 255), "leaf_light": (150, 225, 220, 255),
    "stone": (58, 80, 120, 255), "stone_light": (150, 185, 225, 255),
    "crack": (20, 30, 52, 255), "crystal": (150, 220, 250, 255),
    "crystal_hot": (240, 250, 255, 255), "wood": (96, 70, 52, 255),
    "wood_light": (155, 115, 80, 255), "wood_dark": (62, 44, 32, 255),
    "metal": (150, 160, 185, 255), "lamp": (255, 220, 150, 255),
    "lamp_glow": (255, 200, 120, 60), "eye": (10, 14, 26, 255),
    "eye_hot": (150, 220, 250, 255),
    "snow": (232, 242, 252, 255), "ice": (140, 195, 230, 255),
    "coal": (20, 24, 34, 255), "scarf": (255, 90, 110, 255),
    "bloom": (200, 220, 250, 255),
}


def grass_rect(cy, cx):
    if cy <= 3:
        return True
    if 4 <= cy <= 6 and cx <= 10:
        return True
    return False


def desert_rect(cy, cx):
    if cy <= 9 and cx <= 9:
        return True
    if 10 <= cy <= 13 and cx <= 7:
        return True
    return False


def jungle_rect(cy, cx):
    return cy <= 8 and cx <= 11


def winter_rect(cy, cx):
    if cy <= 9:
        return True
    return cy == 10 and cx <= 10


SINGLE_GRASS = [p_bush, p_rock, p_tuft, p_crystal, p_lantern, p_signpost]
SINGLE_DESERT = [p_cactus, p_rock, p_barrel, p_crystal, p_signpost, p_tuft]
SINGLE_JUNGLE = [p_bush, p_rock, p_crystal, p_lantern, p_tuft]
SINGLE_WINTER = [p_pine, p_rock, p_crystal, p_lantern, p_snowbeing]
RUNS_ALL = [p_fence, p_garland]
POLE_ALL = [p_totem, p_vinepole]
POLE_WINTER = [p_totem, p_icicles]
FEAT_GRASS = [p_statue, p_tree, p_arch, p_crystal]
FEAT_DESERT = [p_statue, p_arch, p_ruin, p_cactus]
FEAT_JUNGLE = [p_statue, p_tree, p_arch, p_idol]
FEAT_WINTER = [p_pine, p_snowbeing, p_arch, p_statue]
MASS_GRASS = [p_foliage, p_rockwall, p_ruin]
MASS_DESERT = [p_ruin, p_rockwall, p_foliage]
MASS_JUNGLE = [p_foliage, p_ruin, p_rockwall]
MASS_WINTER = [p_rockwall, p_foliage, p_ruin]

# name -> (fill colors, rim, cap, cap_depth, mask predicate or None,
#           palette, singles, runs, poles, feats, masses, seed)
CONFIGS = {
    "grass_main.png": (
        {"deep": (10, 22, 26), "mid": (18, 44, 44), "pale": (34, 84, 76),
         "strata": (14, 32, 32)},
        (98, 255, 196, 255), (30, 90, 78, 255), 4, grass_rect,
        PAL_GRASS, SINGLE_GRASS, RUNS_ALL, POLE_ALL, FEAT_GRASS, MASS_GRASS, 101),
    "desert_main.png": (
        {"deep": (24, 16, 34), "mid": (48, 32, 58), "pale": (84, 58, 92),
         "strata": (36, 24, 46)},
        (255, 190, 130, 255), (96, 64, 96, 255), 3, desert_rect,
        PAL_DESERT, SINGLE_DESERT, RUNS_ALL, POLE_ALL, FEAT_DESERT, MASS_DESERT, 102),
    "jungle_main.png": (
        {"deep": (12, 20, 30), "mid": (24, 46, 44), "pale": (44, 90, 78),
         "strata": (18, 34, 32)},
        (120, 255, 200, 255), (36, 96, 80, 255), 4, jungle_rect,
        PAL_JUNGLE, SINGLE_JUNGLE, RUNS_ALL, POLE_ALL, FEAT_JUNGLE, MASS_JUNGLE, 103),
    "winter_main.png": (
        {"deep": (16, 28, 52), "mid": (34, 56, 92), "pale": (62, 96, 142),
         "strata": (26, 42, 72)},
        (235, 246, 255, 255), (200, 225, 245, 255), 5, winter_rect,
        PAL_WINTER, SINGLE_WINTER, RUNS_ALL, POLE_WINTER, FEAT_WINTER, MASS_WINTER, 104),
    "grass_doodads.png": (
        None, (0, 0, 0, 0), (0, 0, 0, 0), 0, None,
        PAL_GRASS, SINGLE_GRASS, RUNS_ALL, POLE_ALL, FEAT_GRASS, MASS_GRASS, 111),
    "desert_doodads.png": (
        None, (0, 0, 0, 0), (0, 0, 0, 0), 0, None,
        PAL_DESERT, SINGLE_DESERT, RUNS_ALL, POLE_ALL, FEAT_DESERT, MASS_DESERT, 112),
    "jungle_doodads.png": (
        None, (0, 0, 0, 0), (0, 0, 0, 0), 0, None,
        PAL_JUNGLE, SINGLE_JUNGLE, RUNS_ALL, POLE_ALL, FEAT_JUNGLE, MASS_JUNGLE, 113),
    "winter_doodads.png": (
        None, (0, 0, 0, 0), (0, 0, 0, 0), 0, None,
        PAL_WINTER, SINGLE_WINTER, RUNS_ALL, POLE_WINTER, FEAT_WINTER, MASS_WINTER, 114),
    "generic_unhookable.png": (
        {"deep": (40, 12, 24), "mid": (88, 22, 44), "pale": (150, 44, 74),
         "strata": (64, 16, 34)},
        (255, 90, 120, 255), (170, 40, 70, 255), 2, lambda cy, cx: True,
        PAL_DESERT, [], [], [], [], [], 121),
    "generic_deathtiles.png": (
        {"deep": (16, 10, 14), "mid": (52, 18, 26), "pale": (120, 36, 52),
         "strata": (36, 14, 20)},
        (255, 70, 90, 255), (150, 30, 50, 255), 2, lambda cy, cx: True,
        PAL_DESERT, [], [], [], [], [], 122),
    "jungle_deathtiles.png": (
        {"deep": (14, 18, 16), "mid": (44, 40, 24), "pale": (110, 70, 40),
         "strata": (30, 28, 20)},
        (255, 110, 70, 255), (160, 60, 40, 255), 2, lambda cy, cx: True,
        PAL_JUNGLE, [], [], [], [], [], 123),
    "jungle_unhookables.png": (
        {"deep": (30, 14, 30), "mid": (80, 26, 60), "pale": (150, 52, 110),
         "strata": (58, 20, 44)},
        (255, 100, 150, 255), (170, 50, 100, 255), 2, lambda cy, cx: True,
        PAL_JUNGLE, [], [], [], [], [], 124),
}

SCATTER_FN = {
    "grass_main.png": s_grass, "grass_doodads.png": s_grass,
    "desert_main.png": s_desert, "desert_doodads.png": s_desert,
    "jungle_main.png": s_jungle, "jungle_doodads.png": s_jungle,
    "winter_main.png": s_winter, "winter_doodads.png": s_winter,
}


def pick(painters: list, seed: int):
    return painters[seed % len(painters)] if painters else None


def paint_sheet(name: str):
    (fill, rim, cap, cap_depth, mask_pred, pal, singles, runs, poles, feats,
     masses, seed) = CONFIGS[name]
    w0, h0, upx = read_png(MAPRES / name)
    solid = solid_field(upx, w0, h0)
    grid = used_grid(solid, w0, h0)
    rows, cols = len(grid), len(grid[0])

    mask_cells = [[bool(mask_pred(cy, cx)) if mask_pred else False
                   for cx in range(cols)] for cy in range(rows)]

    c = Canvas(w0, h0)
    if fill is not None:
        paint_fill(c, seed, fill["deep"], fill["mid"], fill["pale"],
                   strata_col=fill["strata"])
        apply_mask_and_style(c, solid, mask_cells, rim, cap, cap_depth)

    def decor_ok(cy, cx):
        return not mask_cells[cy][cx]

    # sub-prop fragments (< DETAIL_PX: blades, dots, texture bits) become
    # ground scatter instead of full props
    comps = components(solid, w0, h0, grid, decor_ok)
    kept = [(cells, n, bb) for cells, n, bb in comps if n >= DETAIL_PX]
    detail_cells: set[tuple[int, int]] = set()
    for cells, n, bb in comps:
        if n < DETAIL_PX:
            detail_cells.update(cells)
    scatter = SCATTER_FN.get(name)
    if scatter is not None:
        for cx, cy in detail_cells:
            rng = random.Random(seed * 1000003 + cx * 911 + cy * 37)
            scatter(c, cx, cy, rng, pal)

    n_comp = 0
    for cells, _npix, bb in kept:
        xs = [p[0] for p in cells]
        ys = [p[1] for p in cells]
        bw, bh = max(xs) - min(xs) + 1, max(ys) - min(ys) + 1
        x0, y0 = min(xs) * CELL, min(ys) * CELL
        tmp = Canvas(bw * CELL, bh * CELL)
        comp_seed = seed * 100003 + min(xs) * 131 + min(ys) * 17 + len(cells)
        rng = random.Random(comp_seed)
        if len(cells) == 1:
            # paint inside the fragment's own pixel footprint (padded),
            # so a small bit becomes a small prop, not a cell-filling one
            (fx0, fy0, fx1, fy1) = bb
            cx, cy = xs[0] * CELL, ys[0] * CELL
            px0 = max(0, fx0 - cx - 2)
            py0 = max(0, fy0 - cy - 2)
            px1 = min(CELL, fx1 - cx + 3)
            py1 = min(CELL, fy1 - cy + 3)
            fn = pick(singles, comp_seed)
            if fn:
                fn(tmp, px0, py0, px1, py1, rng, pal)
        elif bh == 1:
            fn = pick(runs, comp_seed)
            if fn:
                fn(tmp, 0, 0, tmp.w, tmp.h, rng, pal)
        elif bw == 1:
            fn = pick(poles, comp_seed)
            if fn:
                fn(tmp, 0, 0, tmp.w, tmp.h, rng, pal)
        elif (bw <= 3 and bh <= 3) or fill is not None:
            # mains decor never becomes a mass: features scale to the box
            fn = pick(feats, comp_seed)
            if fn:
                fn(tmp, 0, 0, tmp.w, tmp.h, rng, pal)
        else:
            fn = pick(masses, comp_seed)
            if fn:
                fn(tmp, 0, 0, tmp.w, tmp.h, rng, pal)
        # blit clipped to used cells
        for cx, cy in cells:
            for y in range(CELL):
                for x in range(CELL):
                    r, g, b, a = tmp.get((cx * CELL + x) - x0, (cy * CELL + y) - y0)
                    if a:
                        c.set(cx * CELL + x, cy * CELL + y, (r, g, b, a))
        n_comp += 1
    return c, n_comp, len(detail_cells)


def main() -> int:
    for name in CONFIGS:
        canvas, n_comp, n_detail = paint_sheet(name)
        check_dims(name, canvas)
        canvas.save(MAPRES / name)
        print(f"  painted {name} ({canvas.w}x{canvas.h}, "
              f"{n_comp} props, {n_detail} scatter cells)")
    print(f"tileset pass done: {len(CONFIGS)} sheets")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
