#!/usr/bin/env python3
"""Rebuild every Neon Relay brand raster asset from the master artwork.

The master artwork lives in ``assets-src/brand/``:

* ``neonrelay-app-icon-master.png``    – client app icon (original artwork)
* ``neonrelay-server-icon-master.png`` – server app icon (original artwork)
* ``neonrelay-banner-master.png``      – logo mark used for ``data/gui_logo.png``

This script is the single source of truth for the shipped derivatives:

* ``other/icons/NeonRelay_{16,32,48,256}x…x32.png``
* ``other/icons/NeonRelay-Server_{16,32,48,256}x…x32.png``
* ``other/icons/NeonRelay.ico`` / ``NeonRelay-Server.ico``
* ``other/icons/NeonRelay.icns`` / ``NeonRelay-Server.icns``
* ``data/gui_logo.png`` (banner: mark + wordmark, transparent background)

It prints the sha256 of every produced file so that
``docs/ASSET_MANIFEST.csv`` can be refreshed deterministically.

Requirements: Python 3.10+, Pillow. The wordmark is set in DejaVu Sans Bold
(bundled with the OS; OFL licensed) with a cyan→magenta gradient.
"""

from __future__ import annotations

import hashlib
import pathlib
import struct
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "assets-src" / "brand"
ICONS = ROOT / "other" / "icons"
DATA = ROOT / "data"

SIZES = (16, 32, 48, 256)
# icns OSTypes that carry PNG payloads (modern icns containers)
ICNS_TYPES = {16: b"icp4", 32: b"icp5", 64: b"icp6", 128: b"ic07",
              256: b"ic08", 512: b"ic09", 1024: b"ic10"}

BRAND_CYAN = (64, 232, 255)
BRAND_MAGENTA = (255, 64, 214)
BRAND_NAVY = (10, 16, 38)
BRAND_ICE = (232, 241, 251)


def unpremultiply_on_white(img: Image.Image, white_thresh: int = 238) -> Image.Image:
    """Turn the near-white canvas around a rounded tile into transparency."""
    rgba = img.convert("RGBA")
    px = rgba.load()
    w, h = rgba.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            # distance from pure white, 0..1
            d = ((255 - r) ** 2 + (255 - g) ** 2 + (255 - b) ** 2) ** 0.5 / (255 * 3 ** 0.5)
            alpha = int(min(1.0, d * 3.2) * 255)
            if alpha == 0:
                px[x, y] = (0, 0, 0, 0)
                continue
            f = alpha / 255.0
            nr = min(255, max(0, int((r - (1 - f) * 255) / f)))
            ng = min(255, max(0, int((g - (1 - f) * 255) / f)))
            nb = min(255, max(0, int((b - (1 - f) * 255) / f)))
            px[x, y] = (nr, ng, nb, alpha)
    return rgba


def crop_alpha(img: Image.Image, margin: int = 0) -> Image.Image:
    bbox = img.getchannel("A").getbbox()
    if bbox is None:
        raise SystemExit("master artwork has no opaque pixels")
    left, top, right, bottom = bbox
    left = max(0, left - margin)
    top = max(0, top - margin)
    right = min(img.width, right + margin)
    bottom = min(img.height, bottom + margin)
    return img.crop((left, top, right, bottom))


def gradient_text(text: str, size: int, path: str, c0=(64, 232, 255), c1=(255, 64, 214)) -> Image.Image:
    font = ImageFont.truetype(path, size)
    # measure
    tmp = Image.new("L", (10, 10))
    d = ImageDraw.Draw(tmp)
    left, top, right, bottom = d.textbbox((0, 0), text, font=font)
    w, h = right - left, bottom - top
    mask = Image.new("L", (w + 4, h + 4), 0)
    ImageDraw.Draw(mask).text((2 - left, 2 - top), text, font=font, fill=255)
    grad = Image.new("RGB", mask.size)
    gp = grad.load()
    for y in range(grad.height):
        t = y / max(1, grad.height - 1)
        r = int(c0[0] + (c1[0] - c0[0]) * t)
        g = int(c0[1] + (c1[1] - c0[1]) * t)
        b = int(c0[2] + (c1[2] - c0[2]) * t)
        for x in range(grad.width):
            gp[x, y] = (r, g, b)
    out = Image.new("RGBA", mask.size, (0, 0, 0, 0))
    out.paste(grad, (0, 0), mask)
    return out


def write_icns(path: pathlib.Path, master: Image.Image) -> None:
    entries: list[tuple[bytes, bytes]] = []
    for size, ostype in sorted(ICNS_TYPES.items()):
        img = master.resize((size, size), Image.LANCZOS)
        buf = _png_bytes(img)
        entries.append((ostype, buf))
    body = b""
    for ostype, buf in entries:
        pad = (-len(buf)) % 4
        body += ostype + struct.pack(">I", 8 + len(buf) + pad) + buf + b"\0" * pad
    path.write_bytes(b"icns" + struct.pack(">I", 8 + len(body)) + body)


def _png_bytes(img: Image.Image) -> bytes:
    import io
    bio = io.BytesIO()
    img.save(bio, format="PNG", optimize=True)
    return bio.getvalue()


def sha256(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build_icon(master_path: pathlib.Path, prefix: str) -> list[pathlib.Path]:
    master = unpremultiply_on_white(Image.open(master_path))
    master = crop_alpha(master)
    # square the canvas so resize keeps the aspect of the tile
    side = max(master.size)
    square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    square.paste(master, ((side - master.width) // 2, (side - master.height) // 2), master)
    produced: list[pathlib.Path] = []
    for size in SIZES:
        out = ICONS / f"{prefix}_{size}x{size}x32.png"
        square.resize((size, size), Image.LANCZOS).save(out, format="PNG", optimize=True)
        produced.append(out)
    ico = ICONS / f"{prefix}.ico"
    square.save(ico, format="ICO", sizes=[(s, s) for s in SIZES])
    produced.append(ico)
    icns = ICONS / f"{prefix}.icns"
    write_icns(icns, square)
    produced.append(icns)
    return produced


def checkerboard_to_alpha(img: Image.Image) -> Image.Image:
    """The generated banner master has a *baked-in* checkerboard background
    (neutral grays up to ~#242424 plus near black). Derive a real alpha channel
    from it: neutral dark pixels become transparent, coloured/bright neon
    pixels stay opaque."""
    rgb = img.convert("RGB")
    mask = Image.new("L", rgb.size, 0)
    rp = rgb.load()
    mp = mask.load()
    for y in range(rgb.height):
        for x in range(rgb.width):
            r, g, b = rp[x, y]
            hi, lo = max(r, g, b), min(r, g, b)
            # keep pixels that are clearly part of the neon artwork: bright, or
            # saturated. The baked checkerboard (neutral, <= #303030) and the
            # dark fringe where the glow blended into it are dropped.
            if hi >= 128 or (hi >= 64 and hi - lo >= 24):
                mp[x, y] = 255
    # feather the binary mask by half a pixel and erode one pixel so no dark
    # checkerboard rim survives around the glow
    mask = mask.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(0.7))
    out = rgb.convert("RGBA")
    out.putalpha(mask)
    return out


def build_banner() -> list[pathlib.Path]:
    target_w, target_h = 1024, 293
    logo = compose_logo(target_h)
    if logo.width > target_w - 24:
        f = (target_w - 24) / logo.width
        logo = logo.resize((int(logo.width * f), int(logo.height * f)), Image.LANCZOS)
    out = Image.new("RGBA", (target_w, target_h), (0, 0, 0, 0))
    out.paste(logo, ((target_w - logo.width) // 2, (target_h - logo.height) // 2), logo)
    path = DATA / "gui_logo.png"
    out.save(path, format="PNG", optimize=True)
    return [path]


def h_gradient(w: int, h: int, c0, c1) -> Image.Image:
    t = np.linspace(0.0, 1.0, w, dtype=np.float32)[None, :, None]
    a = np.array(c0, np.float32) + (np.array(c1, np.float32) - np.array(c0, np.float32)) * t
    arr = np.repeat(a, h, axis=0).astype(np.uint8)
    out = np.dstack([arr, np.full((h, w, 1), 255, np.uint8)])
    return Image.fromarray(out, "RGBA")


def radial(w: int, h: int, c_center, c_edge) -> Image.Image:
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    dx = (xs - w / 2) / (w / 2)
    dy = (ys - h / 2) / (h / 2)
    d = np.clip(np.sqrt(dx * dx + dy * dy), 0, 1)[:, :, None]
    a = np.array(c_center, np.float32) + (np.array(c_edge, np.float32) - np.array(c_center, np.float32)) * d
    out = np.dstack([a, np.full((h, w, 1), 255, np.float32)]).astype(np.uint8)
    return Image.fromarray(out, "RGBA")


def gradient_mask(mask: Image.Image, c0=BRAND_CYAN, c1=BRAND_MAGENTA) -> Image.Image:
    """Fill a 1-bit/8-bit mask with the vertical brand gradient."""
    grad = h_gradient(mask.width, mask.height, c0, c1).transpose(Image.ROTATE_90)
    out = Image.new("RGBA", mask.size, (0, 0, 0, 0))
    out.paste(grad, (0, 0), mask)
    return out


def logo_mark() -> Image.Image:
    master = checkerboard_to_alpha(Image.open(SRC / "neonrelay-banner-master.png"))
    w, h = master.size
    left = Image.new("L", (w, h), 0)
    left.paste(master.getchannel("A").crop((0, 0, int(w * 0.62), h)), (0, 0))
    return master.crop(left.getbbox())


def compose_logo(target_h: int) -> Image.Image:
    mark = logo_mark()
    mark_h = int(target_h * 0.92)
    mark = mark.resize((int(mark.width * mark_h / mark.height), mark_h), Image.LANCZOS)
    word = gradient_text("NEON RELAY", int(target_h * 0.52),
                         "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf")
    gap = int(target_h * 0.10)
    total = mark.width + gap + word.width
    canvas = Image.new("RGBA", (total, target_h), (0, 0, 0, 0))
    canvas.paste(mark, (0, (target_h - mark.height) // 2), mark)
    canvas.paste(word, (mark.width + gap, (target_h - word.height) // 2), word)
    return canvas


def _arrow(draw: ImageDraw.ImageDraw, box, color) -> None:
    x0, y0, x1, y1 = box
    my = (y0 + y1) / 2
    draw.polygon([(x0, my - (y1 - y0) * 0.22), (x0 + (x1 - x0) * 0.55, my - (y1 - y0) * 0.22),
                  (x0 + (x1 - x0) * 0.55, my - (y1 - y0) * 0.5), (x1, my),
                  (x0 + (x1 - x0) * 0.55, my + (y1 - y0) * 0.5),
                  (x0 + (x1 - x0) * 0.55, my + (y1 - y0) * 0.22),
                  (x0, my + (y1 - y0) * 0.22)], fill=color)


def build_dmg_backgrounds() -> list[pathlib.Path]:
    logo = compose_logo(190)
    produced = []
    for name, single in (("dmgbackground.png", False), ("dmgbackground_single.png", True)):
        w, h = 1280, 832
        img = Image.new("RGBA", (w, h), BRAND_ICE + (255,))
        img.paste(logo, ((w - logo.width) // 2, 56), logo)
        d = ImageDraw.Draw(img)
        rect_y0, rect_y1 = 470, 726
        if single:
            d.rounded_rectangle([(w // 2 - 128, rect_y0), (w // 2 + 128, rect_y1)],
                                radius=24, fill=(250, 252, 255, 255))
        else:
            d.rounded_rectangle([(128, rect_y0), (384, rect_y1)], radius=24, fill=(250, 252, 255, 255))
            d.rounded_rectangle([(416, rect_y0), (672, rect_y1)], radius=24, fill=(250, 252, 255, 255))
            _arrow(d, (712, 512, 856, 684), (74, 163, 232, 255))
            d.rounded_rectangle([(896, rect_y0), (1152, rect_y1)], radius=24, fill=(250, 252, 255, 255))
        out = ICONS.parent / name
        if name == "dmgbackground.png":
            img.convert("RGB").save(out, format="PNG", optimize=True)
        else:
            img.save(out, format="PNG", optimize=True)
        produced.append(out)
    return produced


def build_emscripten_background() -> list[pathlib.Path]:
    w, h = 1920, 1080
    img = radial(w, h, (56, 128, 196), (16, 42, 86))
    overlay = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)
    # faint hexagon lattice as texture
    r = 90
    for row in range(-1, h // (r * 2) + 2):
        for col in range(-1, w // (r * 2) + 2):
            cx = col * r * 3 + (r * 1.5 if row % 2 else 0)
            cy = row * r * 2
            pts = [(cx + r * np.cos(a), cy + r * np.sin(a))
                   for a in np.linspace(np.pi / 6, 2 * np.pi + np.pi / 6, 7)[:-1]]
            d.polygon(pts, outline=(255, 255, 255, 14), width=3)
    img = Image.alpha_composite(img, overlay)
    mark = logo_mark()
    size = 460
    mark = mark.resize((int(mark.width * size / mark.height), size), Image.LANCZOS)
    glow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    glow.paste(mark, ((w - mark.width) // 2, (h - size) // 2), mark)
    img = Image.alpha_composite(img, glow.filter(ImageFilter.GaussianBlur(18)).point(lambda v: v))
    img = Image.alpha_composite(img, glow)
    out = ROOT / "other" / "emscripten" / "background.png"
    img.convert("RGB").save(out, format="PNG", optimize=True)
    return [out]


def _motif_mask(kind: str, w: int, h: int) -> Image.Image:
    mask = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(mask)
    cx, cy = w // 2, h // 2
    if kind == "play_game":
        d.polygon([(cx - 26, cy - 34), (cx - 26, cy + 34), (cx + 34, cy)], fill=255)
    elif kind == "settings":
        d.ellipse([(cx - 26, cy - 26), (cx + 26, cy + 26)], fill=255)
        for a in np.linspace(0, 2 * np.pi, 9)[:-1]:
            x = cx + 34 * np.cos(a)
            y = cy + 34 * np.sin(a)
            d.ellipse([(x - 9, y - 9), (x + 9, y + 9)], fill=255)
        d.ellipse([(cx - 12, cy - 12), (cx + 12, cy + 12)], fill=0)
    elif kind == "editor":
        d.polygon([(cx - 34, cy + 34), (cx - 22, cy + 10), (cx + 18, cy - 30),
                   (cx + 32, cy - 16), (cx - 8, cy + 24)], fill=255)
    elif kind == "demos":
        d.rounded_rectangle([(cx - 38, cy - 26), (cx + 38, cy + 26)], radius=8, fill=255)
        for x in range(cx - 30, cx + 31, 20):
            d.rectangle([(x - 5, cy - 22), (x + 5, cy - 14)], fill=0)
            d.rectangle([(x - 5, cy + 14), (x + 5, cy + 22)], fill=0)
    else:  # local_server
        for i, y in enumerate((-30, -4, 22)):
            d.rounded_rectangle([(cx - 36, cy + y - 10), (cx + 36, cy + y + 10)], radius=6, fill=255)
            d.ellipse([(cx - 28, cy + y - 4), (cx - 20, cy + y + 4)], fill=0)
    return mask


def build_menuimages() -> list[pathlib.Path]:
    produced = []
    for name in ("play_game", "settings", "editor", "demos", "local_server"):
        w, h = 512, 128
        img = h_gradient(w, h, (16, 26, 58), (30, 52, 96))
        streaks = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        d = ImageDraw.Draw(streaks)
        for x in range(-40, w, 96):
            d.polygon([(x, h), (x + 40, 0), (x + 64, 0), (x + 24, h)], fill=(255, 255, 255, 10))
        img = Image.alpha_composite(img, streaks)
        mask = _motif_mask(name, 120, 120)
        motif = gradient_mask(mask)
        glow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        glow.paste(motif, (24, 4), motif)
        img = Image.alpha_composite(img, glow.filter(ImageFilter.GaussianBlur(10)))
        img = Image.alpha_composite(img, glow)
        out = DATA / "menuimages" / f"{name}.png"
        img.save(out, format="PNG", optimize=True)
        produced.append(out)
    return produced


def build_community_none() -> list[pathlib.Path]:
    w, h = 128, 64
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([(2, 2), (w - 3, h - 3)], radius=10, fill=(38, 44, 52, 255))
    cx, cy = w // 2, h // 2
    r = 20
    d.ellipse([(cx - r, cy - r), (cx + r, cy + r)], outline=(168, 176, 184, 255), width=5)
    d.line([(cx - r * 0.7, cy + r * 0.7), (cx + r * 0.7, cy - r * 0.7)], fill=(168, 176, 184, 255), width=5)
    out = DATA / "communityicons" / "none.png"
    img.save(out, format="PNG", optimize=True)
    return [out]


def main() -> int:
    produced: list[pathlib.Path] = []
    produced += build_icon(SRC / "neonrelay-app-icon-master.png", "NeonRelay")
    produced += build_icon(SRC / "neonrelay-server-icon-master.png", "NeonRelay-Server")
    produced += build_banner()
    produced += build_dmg_backgrounds()
    produced += build_emscripten_background()
    produced += build_menuimages()
    produced += build_community_none()
    for p in produced:
        print(f"{sha256(p)}  {p.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
