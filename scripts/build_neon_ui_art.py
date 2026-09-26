#!/usr/bin/env python3
"""Neon Relay original UI art generator (stage 16).

Replaces the remaining visible upstream art sheets with procedurally drawn,
deterministic Neon Relay originals in the exact same files and grids:

  data/emoticons.png        512x512, 128px cells - emote glyphs (4x4 grid in content.py)
  data/particles.png        512x512, 64px cells - potato fragments / dust
  data/gui_icons.png        384x96,  32px cells - interface line icons (12x3 grid)
  data/hud.png              512x512, 32px cells - HUD glyphs (rows 0-7)
  data/blob.png             512x512 - menu glow blob
  data/arrow.png            48x50  - list arrow chevron
  data/race_flag.png        64x64  - finish flag
  data/strong_weak.png      192x64 - strong/weak indicator glyphs
  data/deadtee.png          64x64  - spectator ghost face
  data/gui_cursor.png       64x64  - pointer + hover states
  data/background_noise.png 128x128 - seamless value-noise tile

Both grids must stay equal to image_size / cell used by the drawing code: the engine selects
a sprite as `x / Gridx .. (x + w) / Gridx`, so a resized sheet with an unresized grid turns a
16px button into a four-icon collage. scripts/test_ui_sheet_grids.py asserts that contract.

Everything is drawn from scratch (no upstream pixels), 4x supersampled and
downscaled with LANCZOS for clean antialiasing. `--check` regenerates into a
temp dir and pixel-compares with the repository files (CI gate).
PNG compression differences are allowed; asset hashes are checked separately.
"""
import argparse
import hashlib
import math
import os
import random
import sys
import tempfile
from PIL import Image, ImageDraw
import build_neon_misc_sheets as misc

SS = 4
# Night Drive synthwave tokens; source of truth: docs/DESIGN_SYNTHWAVE.md
CYAN = (77, 227, 247)      # safe / primary neon
MAGENTA = (255, 46, 136)   # danger / hot accent (night-drive pink)
VIOLET = (108, 96, 255)    # indigo secondary
WHITE = (216, 246, 255)    # ice text
DIM = (96, 116, 148)       # muted grid / disabled states
# Outrun-sun accent (menu / promo surfaces only, concept A hybrid)
SUN_TOP = (255, 95, 109)
SUN_BOTTOM = (255, 176, 32)


def ink(cell_px):
    """Rule P8: one optical stroke everywhere. 2px at a 32px cell, 8px at a 128px cell."""
    return max(2, int(round(cell_px * 0.0625)))


def plate(draw, box, color, cell_px):
    """Chamfered sticker plate: night-1 body, accent rim. Keeps a glyph readable over sky and terrain."""
    x0, y0, x1, y1 = box
    inset = (x1 - x0) * 0.09
    box = (x0 + inset, y0 + inset, x1 - inset, y1 - inset)
    draw.rounded_rectangle(box, radius=(x1 - x0) * 0.18, fill=(10, 14, 30, 232),
                           outline=color + (235,), width=ink(x1 - x0) // 2 + 1)
    return box


def canvas(w, h):
    return Image.new("RGBA", (w * SS, h * SS), (0, 0, 0, 0))


def finish(img, w, h):
    return img.resize((w, h), Image.LANCZOS)


def glow_dot(draw, cx, cy, r, color, steps=6):
    for i in range(steps, 0, -1):
        rr = r * i / steps
        a = int(255 * (1 - (i - 1) / steps) ** 1.6)
        draw.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=color[:3] + (a,))


def stroke(draw, pts, color, width):
    draw.line(pts, fill=color, width=width, joint="curve")


def circle(draw, box, color, width):
    draw.ellipse(box, outline=color, width=width)


# ---------------------------------------------------------------- emoticons
def face(draw, b, mouth, eyes="normal", color=CYAN):
    x0, y0, x1, y1 = b
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    r = (x1 - x0) * 0.36
    circle(draw, [cx - r, cy - r, cx + r, cy + r], color + (235,), max(2, int(r * 0.16)))
    ex, ey = r * 0.42, r * 0.28
    if eyes == "normal":
        for s in (-1, 1):
            glow_dot(draw, cx + s * ex, cy - ey, r * 0.13, WHITE)
    elif eyes == "wink":
        glow_dot(draw, cx - ex, cy - ey, r * 0.13, WHITE)
        stroke(draw, [(cx + ex - r * 0.16, cy - ey), (cx + ex + r * 0.16, cy - ey)], WHITE + (235,), max(2, int(r * 0.12)))
    elif eyes == "shut":
        for s in (-1, 1):
            stroke(draw, [(cx + s * ex - r * 0.16, cy - ey), (cx + s * ex + r * 0.16, cy - ey)], WHITE + (235,), max(2, int(r * 0.12)))
    elif eyes == "angry":
        for s in (-1, 1):
            stroke(draw, [(cx + s * ex - r * 0.18, cy - ey - r * 0.16), (cx + s * ex + r * 0.18, cy - ey + r * 0.06)], MAGENTA + (235,), max(2, int(r * 0.12)))
            glow_dot(draw, cx + s * ex, cy - ey + r * 0.12, r * 0.12, WHITE)
    elif eyes == "heart":
        for s in (-1, 1):
            hx, hy, hr = cx + s * ex, cy - ey, r * 0.16
            draw.polygon([(hx, hy + hr), (hx - hr, hy - hr * 0.4), (hx - hr * 0.5, hy - hr), (hx, hy - hr * 0.4), (hx + hr * 0.5, hy - hr), (hx + hr, hy - hr * 0.4)], fill=MAGENTA + (235,))
    my = cy + r * 0.34
    if mouth == "smile":
        draw.arc([cx - r * 0.5, my - r * 0.4, cx + r * 0.5, my + r * 0.4], 20, 160, fill=WHITE + (235,), width=max(2, int(r * 0.14)))
    elif mouth == "grin":
        draw.pieslice([cx - r * 0.55, my - r * 0.5, cx + r * 0.55, my + r * 0.5], 10, 170, fill=WHITE + (220,))
    elif mouth == "sad":
        draw.arc([cx - r * 0.5, my - r * 0.5, cx + r * 0.5, my + r * 0.3], 200, 340, fill=WHITE + (235,), width=max(2, int(r * 0.14)))
    elif mouth == "flat":
        stroke(draw, [(cx - r * 0.4, my), (cx + r * 0.4, my)], WHITE + (235,), max(2, int(r * 0.14)))
    elif mouth == "open":
        draw.ellipse([cx - r * 0.28, my - r * 0.28, cx + r * 0.28, my + r * 0.28], fill=WHITE + (220,))
    elif mouth == "tongue":
        draw.arc([cx - r * 0.5, my - r * 0.4, cx + r * 0.5, my + r * 0.4], 20, 160, fill=WHITE + (235,), width=max(2, int(r * 0.14)))
        draw.ellipse([cx - r * 0.16, my, cx + r * 0.16, my + r * 0.34], fill=MAGENTA + (235,))


def symbol(draw, b, kind, color):
    x0, y0, x1, y1 = b
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    r = (x1 - x0) * 0.3
    if kind == "heart":
        draw.polygon([(cx, cy + r), (cx - r, cy - r * 0.3), (cx - r * 0.5, cy - r), (cx, cy - r * 0.35), (cx + r * 0.5, cy - r), (cx + r, cy - r * 0.3)], fill=color + (235,))
    elif kind == "star":
        pts = []
        for i in range(10):
            ang = -math.pi / 2 + i * math.pi / 5
            rr = r if i % 2 == 0 else r * 0.45
            pts.append((cx + rr * math.cos(ang), cy + rr * math.sin(ang)))
        draw.polygon(pts, fill=color + (235,))
    elif kind == "bolt":
        draw.polygon([(cx + r * 0.3, cy - r), (cx - r * 0.5, cy + r * 0.1), (cx - r * 0.05, cy + r * 0.1), (cx - r * 0.3, cy + r), (cx + r * 0.5, cy - r * 0.1), (cx + r * 0.05, cy - r * 0.1)], fill=color + (235,))
    elif kind == "note":
        stroke(draw, [(cx + r * 0.35, cy + r * 0.6), (cx + r * 0.35, cy - r * 0.9), (cx + r * 0.8, cy - r * 0.6)], color + (235,), max(2, int(r * 0.18)))
        draw.ellipse([cx - r * 0.45, cy + r * 0.3, cx + r * 0.4, cy + r * 0.95], fill=color + (235,))
    elif kind == "drop":
        draw.polygon([(cx, cy - r), (cx - r * 0.7, cy + r * 0.3), (cx, cy + r), (cx + r * 0.7, cy + r * 0.3)], fill=color + (235,))
    elif kind == "flame":
        draw.polygon([(cx, cy - r), (cx + r * 0.6, cy), (cx + r * 0.3, cy + r * 0.8), (cx - r * 0.3, cy + r * 0.8), (cx - r * 0.6, cy)], fill=color + (235,))
        glow_dot(draw, cx, cy + r * 0.3, r * 0.3, WHITE)
    elif kind == "anger":
        for dx, dy in ((-0.4, -0.4), (0.4, -0.4), (-0.4, 0.4), (0.4, 0.4)):
            stroke(draw, [(cx + dx * r * 0.5, cy + dy * r * 0.5), (cx + dx * r, cy + dy * r)], color + (235,), max(2, int(r * 0.2)))
    elif kind == "zzz":
        for i, (ox, oy, s) in enumerate(((-0.4, -0.5, 0.5), (0.1, 0.0, 0.4), (0.5, 0.45, 0.3))):
            zx, zy = cx + ox * r, cy + oy * r
            stroke(draw, [(zx - s * r * 0.5, zy - s * r * 0.4), (zx + s * r * 0.5, zy - s * r * 0.4), (zx - s * r * 0.5, zy + s * r * 0.4), (zx + s * r * 0.5, zy + s * r * 0.4)], color + (235,), max(2, int(r * 0.14)))


EMOTE_GRID, EMOTE_CELL = 4, 128  # must equal set_emoticons' grid in datasrc/content.py
# Order == SPRITE_OOP .. SPRITE_GHOST in datasrc/content.py (the engine indexes sprites
# contiguously from SPRITE_OOP, see CGameClient::LoadEmoticonSkin).
EMOTE_NAMES = ["oop", "exclamation", "hearts", "drop", "dotdot", "music", "sorry", "ghost"]
EMOTE_ART = {
    "oop": ("face", "open", "normal", CYAN),
    "exclamation": ("symbol", "anger", None, MAGENTA),
    "hearts": ("symbol", "heart", None, MAGENTA),
    "drop": ("symbol", "drop", None, CYAN),
    "dotdot": ("face", "flat", "shut", VIOLET),
    "music": ("symbol", "note", None, CYAN),
    "sorry": ("face", "sad", "wink", VIOLET),
    "ghost": ("face", "smile", "angry", WHITE),
}
EMOTE_CELLS = {name: (i % EMOTE_GRID, i // EMOTE_GRID) for i, name in enumerate(EMOTE_NAMES)}


def build_emoticons():
    w = h = EMOTE_GRID * EMOTE_CELL
    img = canvas(w, h)
    d = ImageDraw.Draw(img)
    for i, name in enumerate(EMOTE_NAMES):
        col, row = i % EMOTE_GRID, i // EMOTE_GRID
        kind, arg, eyes, color = EMOTE_ART[name]
        box = (col * EMOTE_CELL, row * EMOTE_CELL, (col + 1) * EMOTE_CELL, (row + 1) * EMOTE_CELL)
        plate_box = plate(d, tuple(v * SS for v in box), color, EMOTE_CELL)
        # glyph occupies ~62% of the plate, centred, with the same stroke weight as the rest
        g = (plate_box[0] + (plate_box[2] - plate_box[0]) * 0.19,
             plate_box[1] + (plate_box[3] - plate_box[1]) * 0.19,
             plate_box[2] - (plate_box[2] - plate_box[0]) * 0.19,
             plate_box[3] - (plate_box[3] - plate_box[1]) * 0.19)
        if kind == "face":
            face(d, g, arg, eyes, color)
        else:
            symbol(d, g, arg, color)
    return finish(img, w, h)


# ---------------------------------------------------------------- particles
PARTICLE_MASK = [(c, r) for r in range(8) for c in range(12 if r < 2 else (12 if r < 6 else 8))] + \
                [(c, r) for r in range(8, 16) for c in range(8)]


def build_particles():
    from build_potato_effects import particles
    return particles()


# ---------------------------------------------------------------- gui icons
def icon_glyph(d, b, name, color):
    x0, y0, x1, y1 = b
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    r = (x1 - x0) * 0.34
    wd = max(2, int(r * 0.18))
    col = color + (235,)
    if name == "gear":
        circle(d, [cx - r * 0.55, cy - r * 0.55, cx + r * 0.55, cy + r * 0.55], col, wd)
        for i in range(8):
            a = i * math.pi / 4
            stroke(d, [(cx + math.cos(a) * r * 0.6, cy + math.sin(a) * r * 0.6), (cx + math.cos(a) * r, cy + math.sin(a) * r)], col, wd)
    elif name == "friend":
        # Two heads, one in the accent colour: "friend" must read differently from "people".
        d.ellipse([cx - r * 0.72, cy - r * 0.78, cx - r * 0.12, cy - r * 0.18], fill=color + (235,))
        d.arc([cx - r * 0.95, cy - r * 0.05, cx + r * 0.1, cy + r * 1.05], 180, 360, fill=col, width=wd)
        d.ellipse([cx + r * 0.12, cy - r * 0.62, cx + r * 0.7, cy - r * 0.04], fill=MAGENTA + (235,))
        d.arc([cx - r * 0.05, cy + r * 0.1, cx + r * 0.95, cy + r * 1.15], 180, 360, fill=MAGENTA + (235,), width=wd)
    elif name == "mute":
        # Speaker crossed out, so it is unmistakably "off" and not "volume".
        d.polygon([(cx - r * 0.7, cy - r * 0.3), (cx - r * 0.2, cy - r * 0.3), (cx + r * 0.3, cy - r * 0.8),
                   (cx + r * 0.3, cy + r * 0.8), (cx - r * 0.2, cy + r * 0.3), (cx - r * 0.7, cy + r * 0.3)],
                  fill=color + (220,))
        d.line([(cx - r * 0.85, cy + r * 0.85), (cx + r * 0.85, cy - r * 0.85)], fill=MAGENTA + (245,), width=wd + 1)
    elif name == "emoticon_mute":
        d.rounded_rectangle([cx - r * 0.85, cy - r * 0.7, cx + r * 0.85, cy + r * 0.4], radius=r * 0.25,
                            outline=col, width=wd)
        d.polygon([(cx - r * 0.3, cy + r * 0.4), (cx - r * 0.05, cy + r * 0.9), (cx + r * 0.1, cy + r * 0.4)],
                  fill=color + (220,))
        d.line([(cx - r * 0.7, cy + r * 0.55), (cx + r * 0.7, cy - r * 0.75)], fill=MAGENTA + (245,), width=wd + 1)
    elif name == "person":
        glow_dot(d, cx, cy - r * 0.45, r * 0.32, color, steps=4)
        d.arc([cx - r * 0.75, cy - r * 0.2, cx + r * 0.75, cy + r * 1.3], 180, 360, fill=col, width=wd)
    elif name == "people":
        for s in (-0.45, 0.45):
            glow_dot(d, cx + s * r, cy - r * 0.4, r * 0.26, color, steps=4)
            d.arc([cx + s * r - r * 0.5, cy - r * 0.1, cx + s * r + r * 0.5, cy + r * 0.9], 180, 360, fill=col, width=wd)
    elif name == "globe":
        circle(d, [cx - r * 0.8, cy - r * 0.8, cx + r * 0.8, cy + r * 0.8], col, wd)
        d.ellipse([cx - r * 0.35, cy - r * 0.8, cx + r * 0.35, cy + r * 0.8], outline=col, width=wd)
        stroke(d, [(cx - r * 0.8, cy), (cx + r * 0.8, cy)], col, wd)
    elif name == "flag":
        stroke(d, [(cx - r * 0.5, cy - r), (cx - r * 0.5, cy + r)], col, wd)
        d.polygon([(cx - r * 0.5, cy - r), (cx + r * 0.8, cy - r * 0.55), (cx - r * 0.5, cy - r * 0.1)], fill=color + (220,))
    elif name == "speaker":
        d.polygon([(cx - r * 0.7, cy - r * 0.3), (cx - r * 0.2, cy - r * 0.3), (cx + r * 0.3, cy - r * 0.8), (cx + r * 0.3, cy + r * 0.8), (cx - r * 0.2, cy + r * 0.3), (cx - r * 0.7, cy + r * 0.3)], fill=color + (220,))
        d.arc([cx, cy - r * 0.7, cx + r * 1.2, cy + r * 0.7], 300, 60, fill=col, width=wd)
    elif name == "check":
        stroke(d, [(cx - r * 0.7, cy), (cx - r * 0.15, cy + r * 0.6), (cx + r * 0.8, cy - r * 0.6)], col, wd + 1)
    elif name == "cross":
        stroke(d, [(cx - r * 0.6, cy - r * 0.6), (cx + r * 0.6, cy + r * 0.6)], col, wd + 1)
        stroke(d, [(cx - r * 0.6, cy + r * 0.6), (cx + r * 0.6, cy - r * 0.6)], col, wd + 1)
    elif name == "arrow":
        stroke(d, [(cx - r * 0.7, cy), (cx + r * 0.5, cy)], col, wd + 1)
        stroke(d, [(cx + r * 0.1, cy - r * 0.5), (cx + r * 0.6, cy), (cx + r * 0.1, cy + r * 0.5)], col, wd + 1)
    elif name == "heart":
        symbol(d, (cx - r, cy - r, cx + r, cy + r), "heart", color)
    elif name == "star":
        symbol(d, (cx - r, cy - r, cx + r, cy + r), "star", color)
    elif name == "shield":
        d.polygon([(cx, cy - r), (cx + r * 0.75, cy - r * 0.55), (cx + r * 0.6, cy + r * 0.5), (cx, cy + r), (cx - r * 0.6, cy + r * 0.5), (cx - r * 0.75, cy - r * 0.55)], outline=col, width=wd)
    elif name == "key":
        circle(d, [cx - r * 0.9, cy - r * 0.9, cx - r * 0.1, cy - r * 0.1], col, wd)
        stroke(d, [(cx - r * 0.4, cy - r * 0.4), (cx + r * 0.8, cy + r * 0.8)], col, wd)
        stroke(d, [(cx + r * 0.45, cy + r * 0.45), (cx + r * 0.75, cy + r * 0.15)], col, wd)
    elif name == "lock":
        d.rounded_rectangle([cx - r * 0.65, cy - r * 0.2, cx + r * 0.65, cy + r * 0.85], radius=r * 0.2, outline=col, width=wd)
        d.arc([cx - r * 0.4, cy - r * 0.95, cx + r * 0.4, cy - r * 0.1], 180, 360, fill=col, width=wd)
    elif name == "chat":
        d.rounded_rectangle([cx - r * 0.85, cy - r * 0.7, cx + r * 0.85, cy + r * 0.4], radius=r * 0.25, outline=col, width=wd)
        d.polygon([(cx - r * 0.3, cy + r * 0.4), (cx - r * 0.05, cy + r * 0.9), (cx + r * 0.1, cy + r * 0.4)], fill=color + (220,))
    elif name == "eye":
        d.arc([cx - r * 0.9, cy - r * 0.9, cx + r * 0.9, cy + r * 0.9], 200, 340, fill=col, width=wd)
        d.arc([cx - r * 0.9, cy - r * 0.9, cx + r * 0.9, cy + r * 0.9], 20, 160, fill=col, width=wd)
        d.ellipse([cx - r * 0.22, cy - r * 0.22, cx + r * 0.22, cy + r * 0.22], fill=color + (235,))
    elif name == "monitor":
        d.rounded_rectangle([cx - r * 0.85, cy - r * 0.7, cx + r * 0.85, cy + r * 0.35], radius=r * 0.15, outline=col, width=wd)
        stroke(d, [(cx, cy + r * 0.35), (cx, cy + r * 0.75)], col, wd)
        stroke(d, [(cx - r * 0.4, cy + r * 0.8), (cx + r * 0.4, cy + r * 0.8)], col, wd)
    elif name == "coin":
        circle(d, [cx - r * 0.75, cy - r * 0.75, cx + r * 0.75, cy + r * 0.75], col, wd)
        stroke(d, [(cx, cy - r * 0.45), (cx, cy + r * 0.45)], col, wd)
        stroke(d, [(cx - r * 0.3, cy - r * 0.2), (cx + r * 0.3, cy - r * 0.2)], col, wd)
    elif name == "trophy":
        d.arc([cx - r * 0.6, cy - r * 0.9, cx + r * 0.6, cy + r * 0.3], 0, 180, fill=col, width=wd)
        stroke(d, [(cx - r * 0.6, cy - r * 0.85), (cx - r * 0.6, cy - r * 0.3)], col, wd)
        stroke(d, [(cx + r * 0.6, cy - r * 0.85), (cx + r * 0.6, cy - r * 0.3)], col, wd)
        stroke(d, [(cx, cy + r * 0.3), (cx, cy + r * 0.6)], col, wd)
        stroke(d, [(cx - r * 0.45, cy + r * 0.7), (cx + r * 0.45, cy + r * 0.7)], col, wd + 1)
    elif name == "info":
        circle(d, [cx - r * 0.8, cy - r * 0.8, cx + r * 0.8, cy + r * 0.8], col, wd)
        d.ellipse([cx - r * 0.14, cy - r * 0.52, cx + r * 0.14, cy - r * 0.24], fill=color + (235,))
        stroke(d, [(cx, cy - r * 0.1), (cx, cy + r * 0.45)], col, wd + 1)
    elif name == "grid":
        for sx in (-1, 1):
            for sy in (-1, 1):
                d.rounded_rectangle([cx + sx * r * 0.45 - r * 0.32, cy + sy * r * 0.45 - r * 0.32, cx + sx * r * 0.45 + r * 0.32, cy + sy * r * 0.45 + r * 0.32], radius=r * 0.1, outline=col, width=wd)
    elif name == "wrench":
        stroke(d, [(cx - r * 0.6, cy + r * 0.6), (cx + r * 0.3, cy - r * 0.3)], col, wd + 1)
        d.arc([cx, cy - r * 0.9, cx + r * 1.1, cy + r * 0.2], 90, 320, fill=col, width=wd)
    elif name == "palette":
        circle(d, [cx - r * 0.8, cy - r * 0.8, cx + r * 0.8, cy + r * 0.8], col, wd)
        for i, cc in enumerate((CYAN, MAGENTA, VIOLET, WHITE)):
            a = -math.pi / 2 + i * math.pi / 3
            glow_dot(d, cx + math.cos(a) * r * 0.42, cy + math.sin(a) * r * 0.42, r * 0.14, cc, steps=3)
    elif name == "music":
        symbol(d, (cx - r, cy - r, cx + r, cy + r), "note", color)
    elif name in ("dot_filled", "dot_empty"):
        # Tinted at draw time by CChat / CSpectator, so these stay monochrome white: a cyan glyph
        # multiplied by red would read as neither. Same reason "heart" lives on the white row.
        box = [cx - r * 0.62, cy - r * 0.62, cx + r * 0.62, cy + r * 0.62]
        if name == "dot_filled":
            d.ellipse(box, fill=WHITE + (245,))
        else:
            circle(d, box, WHITE + (245,), max(2, int(r * 0.26)))
    elif name == "bolt":
        symbol(d, (cx - r, cy - r, cx + r, cy + r), "bolt", color)


# Sheet layout. Three of these cells are referenced by name from datasrc/content.py
# (SPRITE_GUIICON_MUTE / _EMOTICON_MUTE / _FRIEND); GUI_ICON_CELLS is what
# scripts/test_ui_sheet_grids.py cross-checks, so renaming or reordering here without
# updating content.py fails the test instead of shipping a collage.
GUI_ICON_NAMES = ["gear", "friend", "people", "globe", "flag", "mute", "check", "cross", "arrow", "heart", "star", "shield",
                  "key", "lock", "emoticon_mute", "eye", "monitor", "coin", "trophy", "info", "grid", "wrench", "palette", "music",
                  # Row 2: glyphs tinted per draw call (chat friend marker, spectator multi-view marks).
                  "dot_filled", "dot_empty"]
GUI_ICON_COLS, GUI_ICON_ROWS, GUI_ICON_CELL = 12, 3, 32
GUI_ICON_CELLS = {name: (i % GUI_ICON_COLS, i // GUI_ICON_COLS) for i, name in enumerate(GUI_ICON_NAMES)}


def build_gui_icons():
    w, h = GUI_ICON_COLS * GUI_ICON_CELL, GUI_ICON_ROWS * GUI_ICON_CELL
    img = canvas(w, h)
    d = ImageDraw.Draw(img)
    for i, name in enumerate(GUI_ICON_NAMES):
        col, row = i % GUI_ICON_COLS, i // GUI_ICON_COLS
        # Row 0 and the explicitly monochrome marks are white so callers can tint them; row 1 is
        # already pre-tinted cyan and is only ever drawn as-is.
        color = WHITE if (row == 0 or name in ("heart", "star", "dot_filled", "dot_empty")) else CYAN
        pad = GUI_ICON_CELL * 0.155
        b = (col * GUI_ICON_CELL * SS + pad * SS, row * GUI_ICON_CELL * SS + pad * SS,
             (col + 1) * GUI_ICON_CELL * SS - pad * SS, (row + 1) * GUI_ICON_CELL * SS - pad * SS)
        icon_glyph(d, b, name, color)
    return finish(img, w, h)


# ---------------------------------------------------------------- hud
HUD_GLYPHS = ["heart", "shield", "bolt", "star", "coin", "trophy", "flag", "check"]


def build_hud():
    w = h = 512
    img = canvas(w, h)
    d = ImageDraw.Draw(img)
    for row in range(8):
        cols = 14 if row < 2 else (16 if row < 4 else 10)
        for col in range(cols):
            name = HUD_GLYPHS[(row * 3 + col) % len(HUD_GLYPHS)]
            color = (CYAN, MAGENTA, VIOLET, WHITE)[(row + col) % 4]
            b = (col * 32 * SS + 4 * SS, row * 32 * SS + 4 * SS, col * 32 * SS + 28 * SS, row * 32 * SS + 28 * SS)
            icon_glyph(d, b, name, color)
    return finish(img, w, h)


# ---------------------------------------------------------------- singles
def build_blob():
	"""Menu glow blob: the hybrid accent — an outrun striped sun (concept A)
	blooming over the night sky (concept B); see docs/DESIGN_SYNTHWAVE.md."""
	w = h = 512
	img = canvas(w, h)
	d = ImageDraw.Draw(img)
	cx = cy = w * SS / 2
	r = w * SS * 0.30
	top = cy - r
	bot = cy + r
	# striped sun disc: gradient bands with widening cut gaps downwards
	ys = top
	i = 0
	while ys < bot:
		t = (ys - top) / (bot - top)
		col = tuple(int(SUN_TOP[k] + (SUN_BOTTOM[k] - SUN_TOP[k]) * t) for k in range(3))
		band_h = (bot - top) / 14 * (1.0 + 0.35 * i)
		gap_h = (bot - top) / 14 * (0.35 + 0.55 * t)
		d.rectangle([cx - r, ys, cx + r, ys + band_h], fill=col + (235,))
		ys += band_h + gap_h
		i += 1
	# clip the disc to a circle
	mask = Image.new("L", (w * SS, h * SS), 0)
	md = ImageDraw.Draw(mask)
	md.ellipse([cx - r, top, cx + r, bot], fill=255)
	disc = Image.new("RGBA", (w * SS, h * SS), (0, 0, 0, 0))
	disc.paste(img, (0, 0), mask)
	# night-sky bloom behind the sun
	glow = canvas(w, h)
	gd = ImageDraw.Draw(glow)
	glow_dot(gd, cx, cy, w * SS * 0.46, MAGENTA, steps=12)
	glow_dot(gd, cx - r * 0.5, cy - r * 0.3, r * 0.7, VIOLET, steps=8)
	out = Image.alpha_composite(glow, disc)
	return finish(out, w, h)


def build_arrow():
    w, h = 48, 50
    img = canvas(w, h)
    d = ImageDraw.Draw(img)
    stroke(d, [(10 * SS, 10 * SS), (34 * SS, 25 * SS), (10 * SS, 40 * SS)], CYAN + (235,), 5 * SS)
    return finish(img, w, h)


def build_race_flag():
    w = h = 64
    img = canvas(w, h)
    d = ImageDraw.Draw(img)
    stroke(d, [(14 * SS, 8 * SS), (14 * SS, 56 * SS)], WHITE + (235,), 3 * SS)
    for ry in range(3):
        for rx in range(4):
            color = MAGENTA if (rx + ry) % 2 == 0 else (20, 22, 30)
            d.rectangle([14 * SS + rx * 9 * SS, 8 * SS + ry * 7 * SS, 14 * SS + (rx + 1) * 9 * SS, 8 * SS + (ry + 1) * 7 * SS], fill=color + (235,))
    return finish(img, w, h)


def build_strong_weak():
    w, h = 192, 64
    img = canvas(w, h)
    d = ImageDraw.Draw(img)
    for row in range(2):
        for col in range(6):
            cx = col * 32 * SS + 16 * SS
            cy = row * 32 * SS + 16 * SS
            up = col < 3
            color = MAGENTA if up else CYAN
            size = 6 + (col % 3) * 3
            pts = [(cx, cy - size * SS), (cx + size * SS, cy + size * SS * 0.6), (cx - size * SS, cy + size * SS * 0.6)] if up else \
                  [(cx, cy + size * SS), (cx + size * SS, cy - size * SS * 0.6), (cx - size * SS, cy - size * SS * 0.6)]
            d.polygon(pts, fill=color + (235,))
    return finish(img, w, h)


def build_deadtee():
    w = h = 64
    img = canvas(w, h)
    d = ImageDraw.Draw(img)
    b = (8 * SS, 8 * SS, 56 * SS, 56 * SS)
    face(d, b, "flat", "shut", DIM)
    cx, cy = 32 * SS, 26 * SS
    for s in (-1, 1):
        stroke(d, [(cx + s * 8 * SS - 3 * SS, cy - 3 * SS), (cx + s * 8 * SS + 3 * SS, cy + 3 * SS)], WHITE + (235,), 2 * SS)
        stroke(d, [(cx + s * 8 * SS - 3 * SS, cy + 3 * SS), (cx + s * 8 * SS + 3 * SS, cy - 3 * SS)], WHITE + (235,), 2 * SS)
    return finish(img, w, h)


def build_gui_cursor():
    w = h = 64
    img = canvas(w, h)
    d = ImageDraw.Draw(img)
    for half, color in ((0, WHITE), (1, CYAN)):
        ox = half * 32 * SS
        d.polygon([(ox + 8 * SS, 8 * SS), (ox + 24 * SS, 24 * SS), (ox + 15 * SS, 24 * SS), (ox + 15 * SS, 30 * SS), (ox + 11 * SS, 30 * SS), (ox + 11 * SS, 24 * SS), (ox + 8 * SS, 24 * SS)], fill=color + (240,))
    return finish(img, w, h)


def build_background_noise():
    w = h = 128
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    rng = random.Random(20260917)
    px = img.load()
    # seamless value noise: lattice with wraparound + bilinear blend
    g = 16
    lattice = [[rng.random() for _ in range(g)] for _ in range(g)]
    def lat(x, y):
        return lattice[y % g][x % g]
    for y in range(h):
        for x in range(w):
            fx, fy = x / h * g, y / h * g
            x0, y0 = int(fx), int(fy)
            tx, ty = fx - x0, fy - y0
            tx = tx * tx * (3 - 2 * tx)
            ty = ty * ty * (3 - 2 * ty)
            v = (lat(x0, y0) * (1 - tx) + lat(x0 + 1, y0) * tx) * (1 - ty) + \
                (lat(x0, y0 + 1) * (1 - tx) + lat(x0 + 1, y0 + 1) * tx) * ty
            c = int(40 + v * 60)
            px[x, y] = (c, c, c + 6, 255)
    return img


BUILDERS = {
    "data/emoticons.png": build_emoticons,
    "data/particles.png": build_particles,
    "data/gui_icons.png": build_gui_icons,
    "data/hud.png": build_hud,
    "data/blob.png": build_blob,
    "data/arrow.png": build_arrow,
    "data/race_flag.png": build_race_flag,
    "data/strong_weak.png": misc.build_strong_weak,
    "data/deadtee.png": misc.build_deadtee,
    "data/gui_cursor.png": build_gui_cursor,
    "data/background_noise.png": build_background_noise,
}


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--check", action="store_true", help="verify files match the generator")
    ap.add_argument("--out", default=None, help="output dir for --check (default: temp)")
    args = ap.parse_args()
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    outdir = args.out or root
    if args.check and not args.out:
        outdir = tempfile.mkdtemp(prefix="neon-ui-art-")
    ok = True
    for rel, builder in BUILDERS.items():
        img = builder()
        dest = os.path.join(outdir, rel)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        img.save(dest)
        if args.check:
            repo = os.path.join(root, rel)
            with Image.open(repo) as expected:
                same = (expected.mode == img.mode and expected.size == img.size
                        and expected.tobytes() == img.tobytes())
            ok = ok and same
            print(("  ok   " if same else "  DIFF ") + rel)
        else:
            with open(dest, "rb") as f:
                digest = hashlib.sha256(f.read()).hexdigest()[:16]
            print(f"  wrote {rel}  ({img.size[0]}x{img.size[1]}, sha256 {digest}…)")
    if args.check:
        print("ui art check: " + ("PASS" if ok else "FAIL"))
        sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
