#!/usr/bin/env python3
"""Neon Relay — «Potato Arena» asset bake.

Takes the approved Arena masters and produces the shipped, style-unified UI art:

  assets-src/arena/*.png        -> data/ui/backgrounds/*.png   (1280x720, quiet-zone enforced)
  assets-src/{arena,landing}    -> design/landing/*.jpg        (web derivatives, same recipe)
  data/game.png (weapon rects)  -> data/ui/weapons/weapons_6_128.png  (6x128 menu strip)
                                   assets-src/weapons/weapons_ui_all.png (2x3 master collage)
  (procedural, Neon Drive tokens) -> data/ui/icons/gamification_24.png (8x3 @64px)

Design rules implemented here (see docs/UI_POTATO_ARENA_REDESIGN_RU.md §2):
  * P4 no text in raster: nothing here writes glyphs; captions stay in the client.
  * P6 quiet zone: left 45% and bottom 14% are multiplied toward the night-0 base so that
    labels keep contrast; the report prints the measured luminance before/after.
  * P1/P8 one palette, one stroke weight: icon glyphs reuse the exact primitives and tokens of
    scripts/build_neon_ui_art.py, so menu icons and the in-game sheets cannot drift apart.
  * Weight gate: every shipped background must stay under --max-kb (default 400), the script
    falls back to an adaptive palette only when the quantization error is imperceptible.

`--check` regenerates into a temp dir and byte-compares with the repository (CI determinism gate).
"""
from __future__ import annotations

import argparse
import math
import os
import sys
import tempfile
import zlib
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import build_neon_ui_art as ui  # noqa: E402  tokens + drawing primitives = single style source

SRC_ARENA = ROOT / "assets-src" / "arena"
SRC_ARSENAL = ROOT / "assets-src" / "arsenal"
SRC_LANDING = ROOT / "assets-src" / "landing"
OUT_BG = ROOT / "data" / "ui" / "backgrounds"
OUT_ICONS = ROOT / "data" / "ui" / "icons"
OUT_WEAPONS = ROOT / "data" / "ui" / "weapons"
OUT_ARSENAL = ROOT / "data" / "ui" / "arsenal"

# Armoury cards: one cell per weapon, 3 columns x 2 rows, cell 384x256. The client selects a cell
# with the same QuadsSetSubset math as the icon atlas (see CMenus::RenderWeaponCard).
CARD_W, CARD_H, CARD_COLS = 384, 256, 3

BG_W, BG_H = 1280, 720
QUIET_X, QUIET_Y = 0.45, 0.86  # left fraction / first row of the bottom band
NIGHT_0 = (5, 6, 14)
MAX_MAE = 8.0  # mean abs error per channel that stays invisible under the veil
CYAN, MAGENTA, VIOLET, WHITE, DIM = ui.CYAN, ui.MAGENTA, ui.VIOLET, ui.WHITE, ui.DIM

# Master (assets-src/arena) -> shipped name. Keys are the approved Arena masters.
BACKGROUNDS = [
    ("bg_arena_night.png", "arena_night.png"),        # start page
    ("bg_arena_burn.png", "arena_burn.png"),          # Races / burn-out lobby
    ("bg_arena_roster.png", "arena_roster.png"),       # Characters storefront
    ("bg_arena_vault.png", "arena_vault.png"),         # Wallet / prize vault
    ("bg_arena_podium.png", "arena_podium.png"),       # Leaders
    ("bg_arena_control.png", "arena_control.png"),     # Settings
    ("bg_ingame_combat.png", "arena_combat.png"),      # connected / in-game menu
    ("bg_arena_popup.png", "arena_popup.png"),         # fullscreen popups
    ("bg_arena_armory.png", "arena_armory.png"),        # Arsenal (six empty display niches)
]

# Same rects as scripts/build_potato_weapon_sheet.py (data/game.png is 1024x512, 32px grid).
WEAPON_RECTS = {
    "hammer": (64, 32, 128, 96),
    "pistol": (64, 128, 128, 64),
    "shotgun": (64, 192, 256, 64),
    "grenade": (64, 256, 224, 64),
    "ninja": (64, 320, 256, 64),
    "laser": (64, 384, 224, 96),
}
WEAPON_ORDER = ["hammer", "pistol", "shotgun", "grenade", "laser", "ninja"]
# Master (assets-src/arsenal) per weapon, in WEAPON_ORDER. Same six weapons as the sprite strip.
ARSENAL_MASTERS = {name: f"weapon_{name}.png" for name in WEAPON_ORDER}

ICON_NAMES = [
    "level_ring", "xp_bolt", "streak_flame", "quest_target", "daily_sun", "chest_prize", "trophy", "medal",
    "ticket", "coin_skr", "potato", "shield", "heart", "star", "crown", "lock", "check", "bell",
    "rank_up", "skull", "timer", "hook", "chat", "gear",
]


def stat(img: Image.Image) -> tuple[float, float]:
    a = np.asarray(img.convert("L"), dtype=np.float64)
    return float(a.mean()), float(a.std())


def quiet_zone(img: Image.Image) -> Image.Image:
    """Blend the left band and the bottom band toward night-0 (rule P6)."""
    w, h = img.size
    a = np.asarray(img.convert("RGB"), dtype=np.float64)
    xs = np.arange(w) / max(1.0, w * QUIET_X)
    fade_x = np.clip(xs, 0.0, 1.0) ** 0.7  # 0 at the left edge -> 1 outside the band
    y0 = int(h * QUIET_Y)
    fade_y = np.clip((np.arange(h) - y0) / max(1.0, h - y0), 0.0, 1.0) ** 0.8
    weight = np.minimum(fade_x[None, :], 1.0 - fade_y[:, None] * 0.55)
    weight = np.repeat(weight[..., None], 3, axis=2)
    base = np.asarray(NIGHT_0, dtype=np.float64)
    out = a * weight + base * (1.0 - weight)
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), "RGB")


def _mae(a: np.ndarray, b: np.ndarray) -> float:
    """Mean absolute error over integer differences.

    The fidelity decision below compares this number with MAX_MAE, so it must not depend on how the
    CPU sums floats: numpy reduces float32/float64 with SIMD, and two machines can disagree in the
    last bits — enough to pick a different quantisation candidate and turn a determinism gate red on
    CI only. Integer sums are exact everywhere.
    """
    return float(np.abs(a.astype(np.int64) - b.astype(np.int64)).sum()) / a.size


def save_small(img: Image.Image, dest: Path, max_kb: int) -> tuple[int, float]:
    """Smallest PNG that keeps the quantization error invisible under the menu veil.

    The client draws these at 38% alpha behind an 85% night-0 veil, so a 1280x720 adaptive
    palette is plenty; we still refuse a candidate whose mean absolute error exceeds MAX_MAE
    and fall back to higher fidelity instead of shipping banding.
    """
    dest.parent.mkdir(parents=True, exist_ok=True)
    rgb = img.convert("RGB")
    rgb.save(dest, optimize=True, compress_level=9)
    best = (dest.stat().st_size, 0.0)
    if best[0] <= max_kb * 1024:
        return best
    ref = np.asarray(rgb, dtype=np.int16)
    for colors in (160, 128, 96, 64):
        q = rgb.quantize(colors=colors, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.FLOYDSTEINBERG)
        q.save(dest, optimize=True, compress_level=9)
        err = _mae(np.asarray(q.convert("RGB"), dtype=np.int16), ref)
        size = dest.stat().st_size
        if size <= max_kb * 1024 and err <= MAX_MAE:
            return size, err
        if size <= max_kb * 1024:
            best = (size, err)  # remember, keep trying for an acceptable error
    if best[0] > max_kb * 1024:
        best = (size, err)
    return best


def bake_backgrounds(max_kb: int, report: list[str], out_bg: Path = OUT_BG) -> None:
    out_bg.mkdir(parents=True, exist_ok=True)
    for src_name, dst_name in BACKGROUNDS:
        src = SRC_ARENA / src_name
        if not src.exists():
            report.append(f"MISSING master: {src.relative_to(ROOT)}")
            continue
        img = Image.open(src).convert("RGB")
        img = img.resize((BG_W, BG_H), Image.LANCZOS)
        before_mean, before_sd = stat(img)
        img = quiet_zone(img)
        img = img.filter(ImageFilter.UnsharpMask(radius=1.4, percent=42, threshold=3))
        after_mean, after_sd = stat(img)
        size, err = save_small(img, out_bg / dst_name, max_kb)
        a = np.asarray(img.convert("L"), dtype=np.float64)
        quiet = float(a[:, : int(BG_W * QUIET_X)].mean())
        band = float(a[int(BG_H * QUIET_Y):, :].mean())
        flag = "OK " if quiet <= 40.0 and band <= 40.0 else "WARN"
        report.append(
            f"{flag} {dst_name:22} {BG_W}x{BG_H} L{before_mean:5.1f}->{after_mean:4.1f} sd{after_sd:4.1f} "
            f"quiet L{quiet:4.1f} band L{band:4.1f}  {size / 1024:6.0f} KiB  quant-MAE {err:.2f}"
        )


def cover(sprite: Image.Image, box: tuple[int, int]) -> Image.Image:
    """Scale so the master fills the box, then center-crop. Uniform framing across the six cards."""
    bw, bh = box
    w, h = sprite.size
    s = max(bw / w, bh / h)
    scaled = sprite.resize((round(w * s), round(h * s)), Image.LANCZOS)
    x = (scaled.width - bw) // 2
    y = (scaled.height - bh) // 2
    return scaled.crop((x, y, x + bw, y + bh))


def contain(sprite: Image.Image, box: tuple[int, int]) -> Image.Image:
    bw, bh = box
    w, h = sprite.size
    s = min(bw / w, bh / h)
    return sprite.resize((max(1, round(w * s)), max(1, round(h * s))), Image.LANCZOS)


def bake_weapons(report: list[str], out_weapons: Path = OUT_WEAPONS, write_master: bool = True) -> None:
    game = ROOT / "data" / "game.png"
    sheet = Image.open(game).convert("RGBA")
    cells: list[Image.Image] = []
    for name in WEAPON_ORDER:
        x, y, w, h = WEAPON_RECTS[name]
        crop = sheet.crop((x, y, x + w, y + h))
        bbox = crop.getchannel("A").getbbox()
        if bbox is None:
            report.append(f"WARN empty weapon rect for {name} in {game.name}")
            cells.append(Image.new("RGBA", (256, 256), (0, 0, 0, 0)))
            continue
        sprite = contain(crop.crop(bbox), (240, 240))
        cell = Image.new("RGBA", (256, 256), (0, 0, 0, 0))
        cell.paste(sprite, ((256 - sprite.width) // 2, (256 - sprite.height) // 2), sprite)
        cells.append(cell)
    master = Image.new("RGBA", (768, 512), (0, 0, 0, 0))
    for i, cell in enumerate(cells):
        master.paste(cell, ((i % 3) * 256, (i // 3) * 256), cell)
    out_weapons.mkdir(parents=True, exist_ok=True)
    if write_master:
        master.save(ROOT / "assets-src" / "weapons" / "weapons_ui_all.png", optimize=True)
    strip = Image.new("RGBA", (128 * 6, 128), (0, 0, 0, 0))
    for i, cell in enumerate(cells):
        strip.paste(contain(cell.crop(cell.getchannel("A").getbbox()), (116, 116)),
                    (i * 128 + 6, 6), None)
    strip.save(out_weapons / "weapons_6_128.png", optimize=True)
    report.append(f"OK  weapons_6_128.png   {strip.size[0]}x{strip.size[1]}  "
                  f"{(out_weapons / 'weapons_6_128.png').stat().st_size / 1024:.0f} KiB (cells from data/game.png)")


# ------------------------------------------------------------------ icons
def icon_glyph(d: ImageDraw.ImageDraw, b: tuple[float, float, float, float], name: str, color, accent) -> None:
    x0, y0, x1, y1 = b
    cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
    r = (x1 - x0) * 0.5
    lw = max(3, int(r * 0.19))

    def ring(rad: float, col, width: int, a0: float = 0.0, a1: float = 360.0) -> None:
        d.arc([cx - rad, cy - rad, cx + rad, cy + rad], a0, a1, fill=col, width=width)

    def poly(pts, col, width: int | None = None) -> None:
        if width is None:
            d.polygon(pts, fill=col)
        else:
            d.line(list(pts) + [pts[0]], fill=col, width=width, joint="curve")

    if name == "level_ring":
        ring(r * 0.78, color, lw, -60, 240)
        ring(r * 0.78, accent, lw, 250, 290)
        poly([(cx, cy - r * 0.34), (cx + r * 0.3, cy + r * 0.1), (cx - r * 0.3, cy + r * 0.1)], color)
    elif name == "xp_bolt":
        ui.symbol(d, (cx - r, cy - r, cx + r, cy + r), "bolt", accent)
    elif name == "streak_flame":
        ui.symbol(d, (cx - r, cy - r, cx + r, cy + r), "flame", accent)
    elif name == "quest_target":
        ring(r * 0.8, color, lw)
        ring(r * 0.42, color, lw)
        d.ellipse([cx - lw, cy - lw, cx + lw, cy + lw], fill=accent)
    elif name == "daily_sun":
        d.ellipse([cx - r * 0.4, cy - r * 0.4, cx + r * 0.4, cy + r * 0.4], fill=accent)
        for i in range(8):
            ang = i * math.pi / 4
            d.line([(cx + math.cos(ang) * r * 0.58, cy + math.sin(ang) * r * 0.58),
                    (cx + math.cos(ang) * r * 0.88, cy + math.sin(ang) * r * 0.88)], fill=color, width=lw)
    elif name == "chest_prize":
        # A crate, not a padlock: straight body, hinged lid band, vertical strap in the middle.
        poly([(cx - r * 0.78, cy - r * 0.18), (cx - r * 0.78, cy + r * 0.7), (cx + r * 0.78, cy + r * 0.7),
              (cx + r * 0.78, cy - r * 0.18)], color)
        d.polygon([(cx - r * 0.78, cy - r * 0.18), (cx - r * 0.52, cy - r * 0.62), (cx + r * 0.52, cy - r * 0.62),
                   (cx + r * 0.78, cy - r * 0.18)], fill=color)
        d.line([(cx - r * 0.78, cy - r * 0.18), (cx + r * 0.78, cy - r * 0.18)], fill=(0, 0, 0, 150), width=max(2, lw // 2))
        d.rectangle([cx - r * 0.1, cy - r * 0.5, cx + r * 0.1, cy + r * 0.7], fill=accent)
        for sx in (-0.58, 0.58):
            d.line([(cx + sx * r, cy - r * 0.1), (cx + sx * r, cy + r * 0.62)], fill=(0, 0, 0, 120), width=2)
    elif name == "trophy":
        poly([(cx - r * 0.55, cy - r * 0.7), (cx + r * 0.55, cy - r * 0.7), (cx + r * 0.35, cy + r * 0.1),
              (cx - r * 0.35, cy + r * 0.1)], accent)
        d.line([(cx - r * 0.2, cy + r * 0.1), (cx - r * 0.2, cy + r * 0.5), (cx + r * 0.2, cy + r * 0.5),
                (cx + r * 0.2, cy + r * 0.1)], fill=color, width=lw)
        d.line([(cx - r * 0.55, cy + r * 0.68), (cx + r * 0.55, cy + r * 0.68)], fill=color, width=lw)
    elif name == "medal":
        poly([(cx - r * 0.5, cy - r * 0.9), (cx - r * 0.1, cy - r * 0.9), (cx + r * 0.1, cy - r * 0.1),
              (cx - r * 0.3, cy - r * 0.1)], accent)
        poly([(cx + r * 0.1, cy - r * 0.9), (cx + r * 0.5, cy - r * 0.9), (cx + r * 0.3, cy - r * 0.1),
              (cx - r * 0.1, cy - r * 0.1)], color)
        d.ellipse([cx - r * 0.42, cy - r * 0.18, cx + r * 0.42, cy + r * 0.78], fill=color, outline=accent, width=3)
    elif name == "ticket":
        d.rounded_rectangle([cx - r * 0.85, cy - r * 0.45, cx + r * 0.85, cy + r * 0.45], radius=int(r * 0.18),
                            outline=color, width=lw)
        for yy in (-r * 0.2, 0.0, r * 0.2):
            d.line([(cx + r * 0.3, cy + yy), (cx + r * 0.62, cy + yy)], fill=accent, width=2)
        d.ellipse([cx - r * 0.72, cy - r * 0.14, cx - r * 0.44, cy + r * 0.14], fill=(0, 0, 0, 0))
    elif name == "coin_skr":
        poly([(cx, cy - r * 0.8), (cx + r * 0.7, cy - r * 0.4), (cx + r * 0.7, cy + r * 0.4),
              (cx, cy + r * 0.8), (cx - r * 0.7, cy + r * 0.4), (cx - r * 0.7, cy - r * 0.4)], color, lw)
        d.line([(cx - r * 0.24, cy + r * 0.3), (cx + r * 0.24, cy - r * 0.3)], fill=accent, width=lw)
    elif name == "potato":
        d.ellipse([cx - r * 0.85, cy - r * 0.6, cx + r * 0.85, cy + r * 0.7], outline=color, width=lw)
        for ox, oy, rr in ((-0.34, -0.16, 0.11), (0.2, 0.12, 0.09), (0.42, -0.3, 0.07)):
            d.ellipse([cx + ox * r - rr * r, cy + oy * r - rr * r, cx + ox * r + rr * r, cy + oy * r + rr * r],
                      fill=accent)
    elif name == "shield":
        poly([(cx, cy - r * 0.85), (cx + r * 0.72, cy - r * 0.45), (cx + r * 0.55, cy + r * 0.4),
              (cx, cy + r * 0.85), (cx - r * 0.55, cy + r * 0.4), (cx - r * 0.72, cy - r * 0.45)], color, lw)
        ui.symbol(d, (cx - r * 0.4, cy - r * 0.4, cx + r * 0.4, cy + r * 0.4), "heart", accent)
    elif name == "heart":
        ui.symbol(d, (cx - r * 0.85, cy - r * 0.85, cx + r * 0.85, cy + r * 0.85), "heart", accent)
    elif name == "star":
        ui.symbol(d, (cx - r * 0.9, cy - r * 0.9, cx + r * 0.9, cy + r * 0.9), "star", color)
    elif name == "crown":
        poly([(cx - r * 0.8, cy + r * 0.45), (cx - r * 0.8, cy - r * 0.35), (cx - r * 0.4, cy + r * 0.02),
              (cx, cy - r * 0.6), (cx + r * 0.4, cy + r * 0.02), (cx + r * 0.8, cy - r * 0.35),
              (cx + r * 0.8, cy + r * 0.45)], accent)
        d.line([(cx - r * 0.8, cy + r * 0.68), (cx + r * 0.8, cy + r * 0.68)], fill=color, width=lw)
    elif name == "lock":
        d.rounded_rectangle([cx - r * 0.62, cy - r * 0.12, cx + r * 0.62, cy + r * 0.75], radius=int(r * 0.16),
                            outline=color, width=lw)
        d.arc([cx - r * 0.42, cy - r * 0.8, cx + r * 0.42, cy + r * 0.14], 180, 360, fill=color, width=lw)
        d.ellipse([cx - r * 0.12, cy + r * 0.12, cx + r * 0.12, cy + r * 0.36], fill=accent)
    elif name == "check":
        ui.stroke(d, [(cx - r * 0.66, cy + r * 0.02), (cx - r * 0.16, cy + r * 0.5), (cx + r * 0.7, cy - r * 0.52)],
                  color, lw)
    elif name == "bell":
        d.chord([cx - r * 0.7, cy - r * 0.72, cx + r * 0.7, cy + r * 0.6], 180, 360, fill=color)
        d.rectangle([cx - r * 0.7, cy - r * 0.06, cx + r * 0.7, cy + r * 0.4], fill=color)
        d.line([(cx - r * 0.86, cy + r * 0.42), (cx + r * 0.86, cy + r * 0.42)], fill=color, width=lw)
        d.ellipse([cx - r * 0.18, cy + r * 0.5, cx + r * 0.18, cy + r * 0.86], fill=accent)
    elif name == "rank_up":
        ui.stroke(d, [(cx, cy + r * 0.7), (cx, cy - r * 0.55)], color, lw)
        ui.stroke(d, [(cx - r * 0.5, cy - r * 0.05), (cx, cy - r * 0.65), (cx + r * 0.5, cy - r * 0.05)], accent, lw)
        d.line([(cx - r * 0.7, cy + r * 0.8), (cx + r * 0.7, cy + r * 0.8)], fill=color, width=2)
    elif name == "skull":
        d.ellipse([cx - r * 0.66, cy - r * 0.72, cx + r * 0.66, cy + r * 0.34], outline=color, width=lw)
        d.rectangle([cx - r * 0.3, cy + r * 0.2, cx + r * 0.3, cy + r * 0.7], outline=color, width=2)
        for s in (-1, 1):
            d.ellipse([cx + s * r * 0.36 - r * 0.16, cy - r * 0.3, cx + s * r * 0.36 + r * 0.16, cy + r * 0.02],
                      fill=accent)
    elif name == "timer":
        ring(r * 0.72, color, lw)
        d.line([(cx, cy), (cx, cy - r * 0.46)], fill=accent, width=lw)
        d.line([(cx, cy), (cx + r * 0.36, cy + r * 0.12)], fill=color, width=lw)
        d.line([(cx - r * 0.3, cy - r * 0.92), (cx + r * 0.3, cy - r * 0.92)], fill=color, width=lw)
    elif name == "hook":
        # Rope from the top-right into a clear J-hook, so it reads as a hook and not as an arc.
        ui.stroke(d, [(cx + r * 0.72, cy - r * 0.84), (cx + r * 0.06, cy - r * 0.2)], color, max(2, lw // 2))
        d.arc([cx - r * 0.72, cy - r * 0.44, cx + r * 0.4, cy + r * 0.72], 130, 400, fill=accent, width=lw)
        d.line([(cx - r * 0.66, cy + r * 0.1), (cx - r * 0.86, cy - r * 0.16)], fill=accent, width=lw)
    elif name == "chat":
        d.rounded_rectangle([cx - r * 0.78, cy - r * 0.66, cx + r * 0.78, cy + r * 0.34], radius=int(r * 0.24),
                            outline=color, width=lw)
        poly([(cx - r * 0.3, cy + r * 0.3), (cx - r * 0.05, cy + r * 0.3), (cx - r * 0.3, cy + r * 0.72)], color)
        for i in (-1, 0, 1):
            d.ellipse([cx + i * r * 0.34 - 2, cy - r * 0.2 - 2, cx + i * r * 0.34 + 2, cy - r * 0.2 + 2], fill=accent)
    elif name == "gear":
        ring(r * 0.52, color, lw)
        for i in range(8):
            ang = i * math.pi / 4
            d.line([(cx + math.cos(ang) * r * 0.6, cy + math.sin(ang) * r * 0.6),
                    (cx + math.cos(ang) * r * 0.92, cy + math.sin(ang) * r * 0.92)], fill=color, width=lw)
        d.ellipse([cx - r * 0.18, cy - r * 0.18, cx + r * 0.18, cy + r * 0.18], fill=accent)
    else:
        raise ValueError(f"unknown icon {name}")


def bake_arsenal(report: list[str], out_arsenal: Path = OUT_ARSENAL, write_preview: bool = True,
                 max_kb: int = 420) -> None:
    """Six weapon cards into one atlas, plus a contact sheet for review."""
    out_arsenal.mkdir(parents=True, exist_ok=True)
    sheet = Image.new("RGBA", (CARD_COLS * CARD_W, 2 * CARD_H), NIGHT_0 + (255,))
    for i, name in enumerate(WEAPON_ORDER):
        src = SRC_ARSENAL / ARSENAL_MASTERS[name]
        if not src.exists():
            report.append(f"MISSING master: {rel(src)}")
            continue
        card = cover(Image.open(src).convert("RGB"), (CARD_W, CARD_H))
        # The alcove glow is the brightest thing in most masters and would fight the card label;
        # press the outer 8% and the bottom 22% toward night-0 so text stays >=4.5:1.
        a = np.asarray(card, dtype=np.float64)
        fy = np.clip((np.arange(CARD_H) - int(CARD_H * 0.78)) / max(1.0, CARD_H * 0.22), 0.0, 1.0) ** 1.2
        fx = np.clip((np.arange(CARD_W) - int(CARD_W * 0.92)) / max(1.0, CARD_W * 0.08), 0.0, 1.0)
        weight = 1.0 - np.maximum(fy[:, None], fx[None, :]) * 0.72
        a = a * weight[..., None] + np.asarray(NIGHT_0, dtype=np.float64)[None, None, :] * (1.0 - weight[..., None])
        card = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), "RGB")
        col, row = i % CARD_COLS, i // CARD_COLS
        sheet.paste(card, (col * CARD_W, row * CARD_H))
    # Opaque night-0 backing, so the same weight gate as the backgrounds applies: quantized RGB PNG
    # under max_kb, never at the cost of visible banding (save_small refuses a bad candidate).
    dest = out_arsenal / "cards_6.png"
    rgb = sheet.convert("RGB")
    size, err = save_small(rgb, dest, max_kb)
    mean, sd = stat(rgb)
    flag = "OK " if err <= MAX_MAE else "WARN"
    report.append(f"{flag} {rel(dest)}  {rgb.size[0]}x{rgb.size[1]}  {size / 1024:.0f} KiB  "
                  f"6 cards {CARD_W}x{CARD_H}  L{mean:5.1f} sd{sd:4.1f}  quant-MAE {err:.2f}")
    if not write_preview:
        return
    out = ROOT / "design" / "potato-arena" / "arsenal_preview.jpg"
    out.parent.mkdir(parents=True, exist_ok=True)
    sheet.convert("RGB").save(out, quality=90)
    report.append(f"OK  {rel(out)}  review sheet")


# Landing images are web derivatives of the same masters, so the page cannot drift from the client's
# art. Sizes are fixed by the layout (hero = 7:3 band, armory = the page's card section, vault = the
# honest-money block); everything is deterministic, so `--check` byte-compares these too.
LANDING_OUT = ROOT / "design" / "landing"
LANDING_IMAGES = [
    # source master, shipped file, target size (w, h), dark side that the text sits on
    (SRC_ARENA / "bg_arena_armory.png", "hero.jpg", (1680, 713), "right"),
    (SRC_ARENA / "bg_arena_armory.png", "armory.jpg", (1280, 720), "bottom"),
    (SRC_LANDING / "vault_prizes.png", "vault.jpg", (1100, 600), "bottom"),
]


def bake_landing(report: list[str], out_dir: Path = LANDING_OUT, max_kb: int = 220) -> None:
    """Resize + sharpen + press one edge toward night-0 so white text keeps its contrast."""
    out_dir.mkdir(parents=True, exist_ok=True)
    for src, dst, size, side in LANDING_IMAGES:
        dest = out_dir / dst
        if not src.exists():
            report.append(f"MISSING master: {rel(src)}")
            continue
        img = cover(Image.open(src).convert("RGB"), size)
        img = img.filter(ImageFilter.UnsharpMask(radius=2, percent=110, threshold=2))
        w, h = img.size
        a = np.asarray(img, dtype=np.float64)
        night = np.asarray(NIGHT_0, dtype=np.float64)
        if side == "right":
            # text column sits on the left, so only the far 26% is pressed (the hero copy is on the left)
            f = np.clip((np.arange(w) - int(w * 0.74)) / max(1.0, w * 0.26), 0.0, 1.0) ** 1.3
            weight = 1.0 - f[None, :, None] * 0.66
        else:
            f = np.clip((np.arange(h) - int(h * 0.72)) / max(1.0, h * 0.28), 0.0, 1.0) ** 1.2
            weight = 1.0 - f[:, None, None] * 0.62
        a = a * weight + night * (1.0 - weight)
        img = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), "RGB")
        img.save(dest, format="JPEG", quality=82, optimize=True, progressive=False, subsampling=1)
        size_kb = dest.stat().st_size / 1024
        mean, sd = stat(img)
        flag = "OK " if size_kb <= max_kb else "WARN"
        report.append(f"{flag} {rel(dest)}  {w}x{h}  {size_kb:5.0f} KiB  L{mean:5.1f} sd{sd:4.1f}")


def build_icon_atlas() -> Image.Image:
    cols, rows, cell = 8, 3, 64
    ss = ui.SS
    img = Image.new("RGBA", (cols * cell * ss, rows * cell * ss), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    for i, name in enumerate(ICON_NAMES):
        col, row = i % cols, i // cols
        pad = 9 * ss
        b = (col * cell * ss + pad, row * cell * ss + pad, (col + 1) * cell * ss - pad, (row + 1) * cell * ss - pad)
        hot = name in ("streak_flame", "xp_bolt", "skull", "timer", "chest_prize", "medal", "trophy", "crown")
        icon_glyph(d, b, name, WHITE if hot else CYAN, MAGENTA if hot else WHITE)
    return img.resize((cols * cell, rows * cell), Image.LANCZOS)


def same_art(generated: Path, shipped: Path) -> bool:
    """Compare a fresh bake with the shipped file by *pixels*, not by container bytes.

    Byte equality is the fast path and the strictest possible answer, but it is also a test of the
    encoder: zlib and libjpeg builds differ between the sandbox and the runner, and a PNG re-saved
    by another Pillow build can legitimately come out with different bytes for identical pixels.
    The gate is about the art, so:

      * PNG  - decoded pixels must be identical (RGBA compare, no tolerance);
      * JPEG - libjpeg is lossy per build, so tolerate an invisible mean error (<= 2.5).

    A mismatch prints what actually differs, because a determinism gate that can only say "DIFF"
    cannot be debugged from a CI log.
    """
    if generated.read_bytes() == shipped.read_bytes():
        return True
    a = np.asarray(Image.open(generated).convert("RGBA"), dtype=np.int16)
    b = np.asarray(Image.open(shipped).convert("RGBA"), dtype=np.int16)
    _ = (a, b)  # same dtype trick as save_small: all decisions are made on integer differences
    if a.shape != b.shape:
        print(f"  DIFF {rel(shipped)}: size {b.shape[1]}x{b.shape[0]} vs freshly baked "
              f"{a.shape[1]}x{a.shape[0]}")
        return False
    diff = np.abs(a - b)
    worst = int(diff.max())
    changed = int((diff.any(axis=2)).sum())
    if shipped.suffix.lower() in (".jpg", ".jpeg"):
        err = float(diff.astype(np.int64).sum()) / diff.size
        if err <= 2.5:
            print(f"  ~ re-encoded {shipped.name}: pixels match within MAE {err:.2f} "
                  f"(encoder differs, art does not)")
            return True
    else:
        err = float(diff[..., :3].astype(np.int64).sum()) / (diff.shape[0] * diff.shape[1] * 3)
    print(f"  DIFF {rel(shipped)}: {changed} of {a.shape[0] * a.shape[1]} pixels differ, "
          f"MAE {err:.3f}, max {worst} "
          f"(pillow {Image.__version__}, python {sys.version.split()[0]}, zlib {zlib.ZLIB_VERSION})")
    return False


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def bake_icons(report: list[str], out_icons: Path = OUT_ICONS, write_preview: bool = True) -> None:
    out_icons.mkdir(parents=True, exist_ok=True)
    img = build_icon_atlas()
    dest = out_icons / "gamification_24.png"
    img.save(dest, optimize=True)
    report.append(f"OK  {rel(dest)}  {img.size[0]}x{img.size[1]}  "
                  f"{dest.stat().st_size / 1024:.0f} KiB  {len(ICON_NAMES)} icons")
    if not write_preview:
        return
    # contact sheet for review (never shipped, design dir only)
    sheet = Image.new("RGBA", img.size, NIGHT_0 + (255,))
    sheet.alpha_composite(img)
    out = ROOT / "design" / "potato-arena" / "icons_atlas_preview.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out)


def preview_backgrounds(report: list[str], out_bg: Path = OUT_BG) -> None:
    out = ROOT / "design" / "potato-arena" / "backgrounds_preview.jpg"
    out.parent.mkdir(parents=True, exist_ok=True)
    cell = (800, 450)
    imgs = []
    for _, dst in BACKGROUNDS:
        p = out_bg / dst
        if p.exists():
            imgs.append((dst, Image.open(p).convert("RGB").resize(cell, Image.LANCZOS)))
    if not imgs:
        return
    sheet = Image.new("RGB", (cell[0] * 2 + 30, (cell[1] + 22) * ((len(imgs) + 1) // 2) + 10), (10, 10, 16))
    d = ImageDraw.Draw(sheet)
    for i, (name, im) in enumerate(imgs):
        x = 10 + (i % 2) * (cell[0] + 10)
        y = 10 + (i // 2) * (cell[1] + 22)
        sheet.paste(im, (x, y))
        d.text((x + 2, y + cell[1] + 4), name, fill=(200, 230, 255))
    sheet.save(out, quality=88)
    report.append(f"OK  {out.relative_to(ROOT)}  review sheet")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--check", action="store_true", help="byte-compare shipped files with a fresh bake (CI)")
    ap.add_argument("--max-kb", type=int, default=400, help="weight gate per background")
    args = ap.parse_args()

    if args.check:
        tmp = Path(tempfile.mkdtemp(prefix="potato-arena-"))
        bg, icons, weapons, arsenal = tmp / "bg", tmp / "icons", tmp / "weapons", tmp / "arsenal"
        report: list[str] = []
        bake_backgrounds(args.max_kb, report, bg)
        bake_weapons(report, weapons, write_master=False)
        bake_arsenal(report, arsenal, write_preview=False)
        bake_icons(report, icons, write_preview=False)
        landing = tmp / "landing"
        bake_landing(report, landing)
        shipped = (sorted(OUT_BG.glob("*.png")) + sorted(OUT_ICONS.glob("*.png"))
                   + sorted(OUT_WEAPONS.glob("*.png")) + sorted(OUT_ARSENAL.glob("*.png")))
        ok = bool(report and not any(r.startswith("MISSING") for r in report))
        for p in shipped + sorted(LANDING_OUT.glob("*.jpg")):
            gen = {"backgrounds": bg, "icons": icons, "weapons": weapons, "arsenal": arsenal,
                   "landing": landing}[p.parent.name] / p.name
            same = gen.exists() and same_art(gen, p)
            ok = ok and same
            print(("  ok   " if same else "  DIFF ") + str(p.relative_to(ROOT)))
        print(f"environment: pillow {Image.__version__} numpy {np.__version__} "
              f"python {sys.version.split()[0]} zlib {zlib.ZLIB_VERSION} libjpeg "
              f"{Image.core.jpeglib_version if hasattr(Image.core, 'jpeglib_version') else '?'}")
        print("potato-arena check: " + ("PASS" if ok else "FAIL"))
        return 0 if ok else 1

    report = []
    bake_backgrounds(args.max_kb, report)
    bake_weapons(report)
    bake_arsenal(report)
    bake_icons(report)
    bake_landing(report)
    preview_backgrounds(report)
    for line in report:
        print(line)
    return 0


if __name__ == "__main__":
    sys.exit(main())
