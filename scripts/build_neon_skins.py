#!/usr/bin/env python3
"""Neon Relay — procedural neon skin generator (stage 12).

Creates original 256x128 tee skins in the exact upstream sheet layout
(set_tee grid 8x4 => 32 px cells, datasrc/content.py):

    body          (0, 0, 96, 96)     body_outline  (96, 0, 96, 96)
    hand        (192, 0, 32, 32)     hand_outline (224, 0, 32, 32)
    foot        (192, 32, 64, 32)    foot_outline (192, 64, 64, 32)
    eyes row y=96: normal x=64, angry x=96, pain x=128, happy x=160,
                   dead x=192, surprise x=224  (32x32 each)

Pixel bounding boxes mirror the upstream reference sheets measured from
data/skins/default.png (body ~59x60 centered, outline ~2 px larger, single
eye sprite ~9x16, one foot shape per cell, x_spec = outline-only ghost).

Everything is drawn at 4x and downscaled (LANCZOS) for antialiasing.
Deterministic: same output bytes for same input (no RNG).

Usage:  python3 scripts/build_neon_skins.py [--check]
        --check verifies the generated files on disk match (no writes).
"""
from __future__ import annotations

import argparse
import colorsys
import hashlib
import pathlib
import sys

from PIL import Image, ImageDraw

# Palette → SPECIES lookup shared with build_neon_skins_all.py. Imported
# lazily so this module still works without that file being on PYTHONPATH.
try:
    from build_neon_skins_all import SPECIES, PALETTES, silhouette_06, hsv_shift
    _HAVE_ALL = True
except Exception:  # pragma: no cover - import only fails when called standalone
    _HAVE_ALL = False

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "data" / "skins"
SS = 4  # supersampling factor

# Night Drive tokens (docs/DESIGN_SYNTHWAVE.md)
BRAND_CYAN = (77, 227, 247)       # Night Drive primary
BRAND_MAGENTA = (255, 46, 136)    # Night Drive danger/accent pink
ICE = (216, 246, 255)             # ice text
NIGHT_BG = (5, 6, 14)             # night-0 deepest background
SUN_TOP = (255, 95, 109)          # accent A striped sun start
SUN_BOTTOM = (255, 176, 32)       # accent A striped sun end
INDIGO = (108, 96, 255)           # secondary glow
DIM = (96, 116, 148)              # grid lines / disabled


def lerp(a: int, b: int, t: float) -> int:
    return int(round(a + (b - a) * t))


def gradient(size: tuple[int, int], c_top, c_bottom) -> Image.Image:
    w, h = size
    img = Image.new("RGBA", (w, h))
    px = img.load()
    for y in range(h):
        t = y / max(1, h - 1)
        row = tuple(lerp(c_top[i], c_bottom[i], t) for i in range(3)) + (255,)
        for x in range(w):
            px[x, y] = row
    return img


def circle_mask(size: int, inset: float) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    d.ellipse([inset, inset, size - 1 - inset, size - 1 - inset], fill=255)
    return mask


def hsv(h: float, s: float, v: float) -> tuple[int, int, int]:
    r, g, b = colorsys.hsv_to_rgb(((h % 360) / 360.0), max(0.0, min(1.0, s)),
                                  max(0.0, min(1.0, v)))
    return int(r * 255), int(g * 255), int(b * 255)


class SkinSpec:
    def __init__(self, name, body_top, body_bottom, outline, limbs, eyes,
                 accent=None, accent_style=None, ghost=False,
                 eye_style_extra=None, body_alpha=255, silhouette=None):
        self.name = name
        self.body_top = body_top
        self.body_bottom = body_bottom
        self.outline = outline            # rgba of the silhouette border
        self.limbs = limbs                # rgb of hands/feet
        self.eyes = eyes                  # rgb
        self.accent = accent              # rgb or None (chest marking)
        self.accent_style = accent_style  # "stripe" | "grid" | "circuit" | "glitch" | "band" | "none"
        self.ghost = ghost                # outline-only (x_spec)
        self.body_alpha = body_alpha
        # Optional precomputed silhouette mask (RGBA, same size as body cell).
        # When set, replaces the default circle silhouette with a species-
        # specific shape (cat ears, fox ears, dragon horns, ...).
        self.silhouette = silhouette      # Image | None


SPECS = [
    # core skins, replaced in place (referenced by name in code:
    # CSkins::LoadSkinDirect("default"), ninja/spec states)
    SkinSpec("default", (110, 240, 255), (28, 120, 214), (10, 16, 34, 235),
             (46, 170, 235), (238, 248, 255),
             accent=BRAND_MAGENTA, accent_style="stripe"),
    SkinSpec("x_ninja", (44, 48, 62), (16, 18, 26), (255, 46, 136, 235),
             (30, 32, 42), (255, 90, 220),
             accent=BRAND_MAGENTA, accent_style="band"),
    # extra original neon skins
    SkinSpec("neon_cyan", (140, 250, 255), (20, 140, 200), (6, 24, 38, 235),
             (60, 200, 240), (240, 255, 255),
             accent=(255, 255, 255), accent_style="grid"),
    SkinSpec("neon_magenta", (255, 130, 200), (160, 20, 96), (34, 6, 28, 235),
             (235, 90, 200), (255, 240, 250),
             accent=BRAND_CYAN, accent_style="stripe"),
    SkinSpec("synthwave", (255, 120, 90), (120, 40, 160), (24, 8, 40, 235),
             (200, 90, 140), (255, 230, 200),
             accent=(255, 220, 120), accent_style="grid"),
    SkinSpec("vaporgrid", (190, 130, 255), (90, 60, 180), (18, 10, 40, 235),
             (150, 110, 230), (240, 225, 255),
             accent=(120, 255, 220), accent_style="grid"),
    SkinSpec("midnight", (40, 60, 110), (10, 16, 38),
             (BRAND_CYAN[0], BRAND_CYAN[1], BRAND_CYAN[2], 235),
             (30, 44, 84), (200, 240, 255),
             accent=BRAND_CYAN, accent_style="circuit"),
    SkinSpec("circuit", (30, 40, 44), (12, 18, 20), (64, 232, 255, 235),
             (26, 34, 38), (120, 255, 210),
             accent=BRAND_CYAN, accent_style="circuit"),
    SkinSpec("aurora", (120, 255, 190), (80, 120, 255), (10, 26, 30, 235),
             (100, 210, 190), (235, 255, 245),
             accent=(200, 140, 255), accent_style="stripe"),
    SkinSpec("glitch", (70, 74, 88), (24, 26, 34), (255, 46, 136, 235),
             (50, 54, 66), (255, 80, 90),
             accent=BRAND_CYAN, accent_style="glitch"),
    # Night Drive pass (docs/DESIGN_SYNTHWAVE.md): base style + outrun accent
    SkinSpec("nightdrive", (26, 30, 52), (8, 10, 22), (77, 227, 247, 235),
             (77, 227, 247), (216, 246, 255),
             accent=(255, 46, 136), accent_style="stripe"),
    SkinSpec("outrun", (255, 95, 109), (150, 40, 120), (24, 8, 40, 235),
             (255, 176, 32), (216, 246, 255),
             accent=(77, 227, 247), accent_style="band"),
]

# x_spec: outline-only ghost (matches upstream sheet: only the outline cell)
GHOST = SkinSpec("x_spec", (0, 0, 0), (0, 0, 0),
                 (BRAND_CYAN[0], BRAND_CYAN[1], BRAND_CYAN[2], 170),
                 (0, 0, 0), (0, 0, 0), ghost=True)


def _apply_species(spec: SkinSpec) -> SkinSpec:
    """Apply per-name hue shift + silhouette from build_neon_skins_all.

    Used so the SPECS table produces the same bytes as the upstream sweep
    in build_neon_skins_all.py. The hue shift is deterministic per name.
    Ghost specs (x_spec) pass through unchanged.
    """
    if not _HAVE_ALL:
        return spec
    if spec.ghost:
        return spec
    entry = SPECIES.get(spec.name)
    if entry is None:
        return spec
    species, accent_style, pal_name, _hue_off, _lgt = entry
    top, bottom, outline_rgb = PALETTES[pal_name]
    import hashlib as _h
    r = int.from_bytes(_h.sha256(("palette:" + spec.name).encode()).digest()[:8],
                       "big")
    shift = (r % 60) - 30
    sat_shift = ((r >> 8) % 80) - 40
    top = hsv_shift(top, shift, sat_shift)
    bottom = hsv_shift(bottom, shift, sat_shift // 2)
    accent_color = {
        "cyan": ICE, "magenta": BRAND_CYAN, "ice": BRAND_CYAN,
        "indigo": BRAND_CYAN, "aurora": BRAND_MAGENTA, "sun": BRAND_CYAN,
    }[pal_name]
    eyes = ICE if pal_name != "ice" else BRAND_CYAN
    if pal_name == "ice":
        eyes = BRAND_MAGENTA
    new = SkinSpec(
        spec.name, top, bottom,
        outline_rgb + (235,),
        top, eyes,
        accent=accent_color, accent_style=accent_style,
        ghost=spec.ghost,
    )
    new.silhouette = silhouette_06(spec.name, (96, 96))
    return new


def silhouette_mask(spec: SkinSpec, outline: bool) -> Image.Image:
    """Return a 96*SS alpha mask for the body silhouette."""
    size = 96 * SS
    if spec.silhouette is not None:
        # Use the supplied silhouette at supersampled scale.
        sil = spec.silhouette.resize((size, size), Image.LANCZOS).convert("L")
        if outline:
            # pad out by ~3px to form the outline cell silhouette.
            from PIL import ImageFilter
            sil = sil.filter(ImageFilter.MaxFilter(7))
        return sil
    diameter = (63 if outline else 59) * SS
    inset = (size - diameter) / 2
    return circle_mask(size, inset)


def draw_body_cell(spec: SkinSpec, outline: bool) -> Image.Image:
    """96x96 cell; silhouette ~59 px (outline ~63 px) centered like upstream."""
    size = 96 * SS
    if outline or spec.ghost:
        img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        mask = silhouette_mask(spec, outline=True)
        layer = Image.new("RGBA", (size, size), tuple(spec.outline))
        img.paste(layer, (0, 0), mask)
    else:
        mask = silhouette_mask(spec, outline=False)
        img = gradient((size, size), spec.body_top, spec.body_bottom)
        img.putalpha(mask)
        if spec.body_alpha < 255:
            alpha = img.getchannel("A").point(lambda v: v * spec.body_alpha // 255)
            img.putalpha(alpha)
        if spec.accent and spec.accent_style and spec.accent_style != "none":
            draw_accent(img, mask, spec)
    return img.resize((96, 96), Image.LANCZOS)


def draw_accent(img: Image.Image, mask: Image.Image, spec: SkinSpec):
    size = img.size[0]
    accent = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(accent)
    color = tuple(spec.accent) + (210,)
    style = spec.accent_style
    if style == "stripe":
        h = size // 10
        d.rectangle([0, size // 2 + h // 2, size, size // 2 + h // 2 + h],
                    fill=color)
    elif style == "band":  # head band across the top third
        d.rectangle([0, size // 4, size, size // 4 + size // 12], fill=color)
    elif style == "grid":
        step = size // 8
        w = max(2, size // 48)
        for x in range(step, size, step):
            d.line([x, 0, x, size], fill=color, width=w)
        for y in range(step, size, step):
            d.line([0, y, size, y], fill=color, width=w)
    elif style == "circuit":
        w = max(2, size // 40)
        d.line([size * 0.2, size * 0.65, size * 0.45, size * 0.65,
                size * 0.45, size * 0.4, size * 0.75, size * 0.4],
               fill=color, width=w, joint="curve")
        r = size // 24
        for cx, cy in [(0.2, 0.65), (0.75, 0.4)]:
            d.ellipse([size * cx - r, size * cy - r,
                       size * cx + r, size * cy + r], fill=color)
    elif style == "glitch":
        h = size // 14
        d.rectangle([0, size * 0.35, size * 0.7, size * 0.35 + h],
                    fill=tuple(spec.accent) + (190,))
        d.rectangle([size * 0.3, size * 0.55, size, size * 0.55 + h],
                    fill=(255, 80, 90, 190))
    # clip to silhouette
    accent.putalpha(Image.composite(accent.getchannel("A"),
                                    Image.new("L", (size, size), 0), mask))
    img.alpha_composite(accent)


def draw_limb_cell(spec: SkinSpec, outline: bool, w: int, h: int,
                   bbox: tuple[float, float, float, float]) -> Image.Image:
    """Generic rounded limb in a w x h cell at the measured upstream bbox."""
    size = (w * SS, h * SS)
    img = Image.new("RGBA", size, (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    x0, y0, x1, y1 = (v * SS for v in bbox)
    pad = -2 * SS if outline else 0
    color = tuple(spec.outline) if (outline or spec.ghost) else tuple(spec.limbs) + (255,)
    d.rounded_rectangle([x0 + pad, y0 + pad, x1 - pad, y1 - pad],
                        radius=(min(x1 - x0, y1 - y0)) / 2.4, fill=color)
    return img.resize((w, h), Image.LANCZOS)


def draw_eye_cell(spec: SkinSpec, expression: str) -> Image.Image:
    """32x32 cell holding ONE eye (~9x16 upstream); expressions vary the shape."""
    size = 32 * SS
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    if spec.ghost:
        return img.resize((32, 32), Image.LANCZOS)
    d = ImageDraw.Draw(img)
    color = tuple(spec.eyes) + (255,)
    cx, cy = size * 0.515, size * 0.53
    if expression == "normal":
        d.ellipse([cx - 3.4 * SS, cy - 7.5 * SS, cx + 3.4 * SS, cy + 7.5 * SS],
                  fill=color)
    elif expression == "angry":
        d.ellipse([cx - 3.4 * SS, cy - 6.5 * SS, cx + 3.4 * SS, cy + 7.5 * SS],
                  fill=color)
        d.polygon([(cx - 5 * SS, cy - 9 * SS), (cx + 5 * SS, cy - 5.5 * SS),
                   (cx + 5 * SS, cy - 8.5 * SS), (cx - 5 * SS, cy - 11.5 * SS)],
                  fill=color)
    elif expression == "pain":
        w = 1.8 * SS
        d.line([cx - 3.5 * SS, cy - 5 * SS, cx + 1 * SS, cy,
                cx - 3.5 * SS, cy + 5 * SS], fill=color, width=int(w),
               joint="curve")
    elif expression == "happy":
        d.arc([cx - 4.5 * SS, cy - 6 * SS, cx + 4.5 * SS, cy + 6 * SS],
               start=200, end=340, fill=color, width=int(2.2 * SS))
    elif expression == "dead":
        w = int(1.8 * SS)
        d.line([cx - 4 * SS, cy - 5 * SS, cx + 4 * SS, cy + 5 * SS],
               fill=color, width=w)
        d.line([cx - 4 * SS, cy + 5 * SS, cx + 4 * SS, cy - 5 * SS],
               fill=color, width=w)
    elif expression == "surprise":
        d.ellipse([cx - 2.6 * SS, cy - 8.5 * SS, cx + 2.6 * SS, cy + 8.5 * SS],
                  fill=color)
    else:
        raise ValueError(expression)
    return img.resize((32, 32), Image.LANCZOS)


def build_skin(spec: SkinSpec) -> Image.Image:
    sheet = Image.new("RGBA", (256, 128), (0, 0, 0, 0))

    def put(img: Image.Image, x: int, y: int):
        sheet.alpha_composite(img, (x, y))

    if not spec.ghost:
        put(draw_body_cell(spec, outline=False), 0, 0)
    put(draw_body_cell(spec, outline=True), 96, 0)
    if spec.ghost:
        return sheet

    # hand (6,8,26,27) and hand_outline (4,7,28,28)
    put(draw_limb_cell(spec, False, 32, 32, (6, 8, 26, 27)), 192, 0)
    put(draw_limb_cell(spec, True, 32, 32, (6, 8, 26, 27)), 224, 0)
    # foot (20,10,46,24), foot_outline (19,8,48,25)
    put(draw_limb_cell(spec, False, 64, 32, (20, 10, 46, 24)), 192, 32)
    put(draw_limb_cell(spec, True, 64, 32, (20, 10, 46, 24)), 192, 64)
    for i, expression in enumerate(["normal", "angry", "pain", "happy",
                                    "dead", "surprise"]):
        put(draw_eye_cell(spec, expression), 64 + 32 * i, 96)
    return sheet


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true",
                        help="verify files on disk match the generator output "
                             "instead of writing")
    args = parser.parse_args()

    all_specs = [_apply_species(s) for s in SPECS] + [GHOST]
    mismatches = []
    for spec in all_specs:
        img = build_skin(spec)
        path = OUT_DIR / f"{spec.name}.png"
        data = img.tobytes()
        if args.check:
            if not path.exists():
                mismatches.append(f"{path.name}: missing")
                continue
            on_disk = Image.open(path).convert("RGBA")
            if on_disk.size != img.size or on_disk.tobytes() != data:
                mismatches.append(f"{path.name}: differs from generator output")
        else:
            img.save(path, "PNG")
            digest = hashlib.sha256(path.read_bytes()).hexdigest()[:16]
            print(f"  wrote {path.relative_to(ROOT)}  "
                  f"({img.size[0]}x{img.size[1]}, sha256 {digest}…)")
    if mismatches:
        print("skin check FAILED:", file=sys.stderr)
        for m in mismatches:
            print(f"  {m}", file=sys.stderr)
        return 1
    if args.check:
        print(f"skin check: PASS ({len(all_specs)} generated skins match)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
