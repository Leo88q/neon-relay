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

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "assets-src" / "brand"
ICONS = ROOT / "other" / "icons"
DATA = ROOT / "data"

SIZES = (16, 32, 48, 256)
# icns OSTypes that carry PNG payloads (modern icns containers)
ICNS_TYPES = {16: b"icp4", 32: b"icp5", 64: b"icp6", 128: b"ic07",
              256: b"ic08", 512: b"ic09", 1024: b"ic10"}


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
    master = checkerboard_to_alpha(Image.open(SRC / "neonrelay-banner-master.png"))
    # keep only the left-hand mark: the master reserves the right side for
    # typography and may contain faint generation artefacts there
    w, h = master.size
    left = Image.new("L", (w, h), 0)
    left.paste(master.getchannel("A").crop((0, 0, int(w * 0.62), h)), (0, 0))
    bbox = left.getbbox()
    mark = master.crop(bbox)

    # target: 1024x293 like the upstream banner slot
    target_w, target_h = 1024, 293
    mark_h = int(target_h * 0.92)
    scale = mark_h / mark.height
    mark_w = int(mark.width * scale)
    mark = mark.resize((mark_w, mark_h), Image.LANCZOS)

    word = gradient_text("NEON RELAY", int(target_h * 0.52),
                         "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf")
    gap = int(target_h * 0.10)
    total_w = mark_w + gap + word.width
    # scale everything down if it does not fit
    if total_w > target_w - 24:
        f = (target_w - 24) / total_w
        mark = mark.resize((int(mark.width * f), int(mark.height * f)), Image.LANCZOS)
        word = word.resize((int(word.width * f), int(word.height * f)), Image.LANCZOS)
        mark_w, mark_h = mark.size
        gap = int(gap * f)
        total_w = mark_w + gap + word.width

    out = Image.new("RGBA", (target_w, target_h), (0, 0, 0, 0))
    x = (target_w - total_w) // 2
    out.paste(mark, (x, (target_h - mark.height) // 2), mark)
    out.paste(word, (x + mark_w + gap, (target_h - word.height) // 2), word)
    path = DATA / "gui_logo.png"
    out.save(path, format="PNG", optimize=True)
    return [path]


def main() -> int:
    produced: list[pathlib.Path] = []
    produced += build_icon(SRC / "neonrelay-app-icon-master.png", "NeonRelay")
    produced += build_icon(SRC / "neonrelay-server-icon-master.png", "NeonRelay-Server")
    produced += build_banner()
    for p in produced:
        print(f"{sha256(p)}  {p.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
