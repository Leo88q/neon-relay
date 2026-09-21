#!/usr/bin/env python3
"""Minimal stdlib-only PNG toolkit for the Neon Relay original-art pass.

Why this exists: the sandbox has no PIL, and the release pipeline must not
depend on it either. Supports the subset we need:

* read:  8-bit non-interlaced RGB/RGBA (color types 2 and 6)
* write: 8-bit RGBA (color type 6), Sub filter, zlib level 9
* Canvas: small 2D raster helper (rects, circles, lines, gradients,
  value noise, alpha-aware blending) used by the sheet generators.

All drawing here produces *new* pixels. When a generator needs to stay
tile-compatible with an upstream sheet (autotile connectivity), it reads only
the per-cell alpha mask — a functional interface, like an API — and every
visible pixel (color, texture, light) is rendered from scratch.
"""

from __future__ import annotations

import math
import random
import struct
import zlib

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def _chunks(data: bytes):
    assert data[:8] == PNG_MAGIC, "not a PNG"
    pos = 8
    out = []
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos:pos + 4])
        ctype = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + length]
        out.append((ctype, body))
        pos += 8 + length + 4
    return out


def _paeth(a: int, b: int, c: int) -> int:
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    if pb <= pc:
        return b
    return c


def read_png(path) -> tuple[int, int, bytearray]:
    """Read an 8-bit RGB/RGBA PNG; return (w, h, RGBA bytearray)."""
    data = bytes(path.read_bytes() if hasattr(path, "read_bytes") else open(path, "rb").read())
    width = height = bitdepth = colortype = None
    raw_idat = bytearray()
    for ctype, body in _chunks(data):
        if ctype == b"IHDR":
            width, height, bitdepth, colortype, comp, filt, inter = struct.unpack(">IIBBBBB", body)
        elif ctype == b"IDAT":
            raw_idat += body
    assert bitdepth == 8, f"only 8-bit supported, got {bitdepth}"
    assert colortype in (2, 6), f"only RGB/RGBA supported, got {colortype}"
    assert inter == 0, "interlaced PNG not supported"
    channels = 3 if colortype == 2 else 4
    stride = width * channels
    pixels = zlib.decompress(bytes(raw_idat))
    assert len(pixels) == height * (stride + 1), "bad IDAT size"
    out = bytearray(width * height * 4)
    prev = bytearray(stride)
    pos = 0
    for y in range(height):
        ftype = pixels[pos]
        pos += 1
        row = bytearray(pixels[pos:pos + stride])
        pos += stride
        if ftype == 1:  # Sub
            for i in range(channels, stride):
                row[i] = (row[i] + row[i - channels]) & 0xFF
        elif ftype == 2:  # Up
            for i in range(stride):
                row[i] = (row[i] + prev[i]) & 0xFF
        elif ftype == 3:  # Average
            for i in range(stride):
                a = row[i - channels] if i >= channels else 0
                row[i] = (row[i] + ((a + prev[i]) >> 1)) & 0xFF
        elif ftype == 4:  # Paeth
            for i in range(stride):
                a = row[i - channels] if i >= channels else 0
                b = prev[i]
                c = prev[i - channels] if i >= channels else 0
                row[i] = (row[i] + _paeth(a, b, c)) & 0xFF
        elif ftype != 0:
            raise AssertionError(f"bad filter {ftype}")
        if channels == 4:
            out[y * width * 4:(y + 1) * width * 4] = row
        else:
            o = y * width * 4
            for x in range(width):
                out[o] = row[x * 3]
                out[o + 1] = row[x * 3 + 1]
                out[o + 2] = row[x * 3 + 2]
                out[o + 3] = 255
                o += 4
        prev = row
    return width, height, out


def write_png(path, width: int, height: int, rgba: bytes | bytearray) -> None:
    """Write an 8-bit RGBA PNG with Sub filtering."""
    assert len(rgba) == width * height * 4
    stride = width * 4
    filt = bytearray()
    for y in range(height):
        filt.append(1)  # Sub
        row = rgba[y * stride:(y + 1) * stride]
        filt += row[:4]
        for i in range(4, stride):
            filt.append((row[i] - row[i - 4]) & 0xFF)
    comp = zlib.compress(bytes(filt), 9)

    def chunk(ctype: bytes, body: bytes) -> bytes:
        return struct.pack(">I", len(body)) + ctype + body + struct.pack(">I", zlib.crc32(ctype + body))

    png = bytearray(PNG_MAGIC)
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", comp)
    png += chunk(b"IEND", b"")
    if hasattr(path, "write_bytes"):
        path.write_bytes(bytes(png))
    else:
        with open(path, "wb") as f:
            f.write(png)


def png_info(path) -> tuple[int, int, int, int]:
    """Return (w, h, bitdepth, colortype) from IHDR without decoding."""
    data = bytes(path.read_bytes() if hasattr(path, "read_bytes") else open(path, "rb").read())
    for ctype, body in _chunks(data):
        if ctype == b"IHDR":
            w, h, bd, ct, _, _, inter = struct.unpack(">IIBBBBB", body)
            return w, h, bd, ct
    raise AssertionError("no IHDR")


def cell_alpha_mask(rgba: bytes | bytearray, width: int, cols: int, rows: int, threshold: int = 100) -> list[list[int]]:
    """Per-cell solid-pixel counts (alpha > threshold) for a tile grid."""
    cw, ch = width // cols, (len(rgba) // 4 // width) // rows
    height = len(rgba) // 4 // width
    counts = [[0] * cols for _ in range(rows)]
    for cy in range(rows):
        for cx in range(cols):
            n = 0
            for y in range(cy * ch, min((cy + 1) * ch, height)):
                base = (y * width + cx * cw) * 4 + 3
                for x in range(cw):
                    if rgba[base + x * 4] > threshold:
                        n += 1
            counts[cy][cx] = n
    return counts


class Canvas:
    """Tiny RGBA raster surface (top-left origin, 0-255 ints)."""

    def __init__(self, width: int, height: int, bg=(0, 0, 0, 0)):
        self.w = width
        self.h = height
        self.px = bytearray(width * height * 4)
        if bg != (0, 0, 0, 0):
            self.fill(bg)

    # -- basics ------------------------------------------------------
    def _idx(self, x: int, y: int) -> int:
        return (y * self.w + x) * 4

    def fill(self, rgba) -> "Canvas":
        r, g, b, a = (int(v) for v in rgba)
        for i in range(0, len(self.px), 4):
            self.px[i] = r
            self.px[i + 1] = g
            self.px[i + 2] = b
            self.px[i + 3] = a
        return self

    def set(self, x: int, y: int, rgba) -> None:
        if 0 <= x < self.w and 0 <= y < self.h:
            i = self._idx(x, y)
            self.px[i:i + 4] = bytes(int(v) & 0xFF for v in rgba)

    def get(self, x: int, y: int) -> tuple[int, int, int, int]:
        i = self._idx(x, y)
        return self.px[i], self.px[i + 1], self.px[i + 2], self.px[i + 3]

    def blend(self, x: int, y: int, rgba) -> None:
        """Alpha-over blend src rgba onto the pixel."""
        if not (0 <= x < self.w and 0 <= y < self.h):
            return
        sr, sg, sb, sa = (int(v) for v in rgba)
        if sa <= 0:
            return
        i = self._idx(x, y)
        if sa >= 255:
            self.px[i:i + 4] = bytes((sr, sg, sb, 255))
            return
        dr, dg, db, da = self.px[i], self.px[i + 1], self.px[i + 2], self.px[i + 3]
        inv = 255 - sa
        self.px[i] = (sr * sa + dr * inv) // 255
        self.px[i + 1] = (sg * sa + dg * inv) // 255
        self.px[i + 2] = (sb * sa + db * inv) // 255
        self.px[i + 3] = min(255, sa + da * inv // 255)

    # -- shapes ------------------------------------------------------
    def rect(self, x0: int, y0: int, x1: int, y1: int, rgba, blend: bool = False) -> "Canvas":
        x0, x1 = max(0, x0), min(self.w, x1)
        y0, y1 = max(0, y0), min(self.h, y1)
        if blend:
            for y in range(y0, y1):
                for x in range(x0, x1):
                    self.blend(x, y, rgba)
        else:
            r, g, b, a = (int(v) & 0xFF for v in rgba)
            row = bytes((r, g, b, a)) * (x1 - x0)
            for y in range(y0, y1):
                i = self._idx(x0, y)
                self.px[i:i + len(row)] = row
        return self

    def hline(self, x0: int, x1: int, y: int, rgba, blend: bool = False) -> "Canvas":
        return self.rect(x0, y, x1, y + 1, rgba, blend)

    def vline(self, x: int, y0: int, y1: int, rgba, blend: bool = False) -> "Canvas":
        return self.rect(x, y0, x + 1, y1, rgba, blend)

    def line(self, x0: int, y0: int, x1: int, y1: int, rgba, width: int = 1) -> "Canvas":
        dx, dy = abs(x1 - x0), abs(y1 - y0)
        sx, sy = (1 if x0 < x1 else -1), (1 if y0 < y1 else -1)
        err = dx - dy
        offs = range(-((width - 1) // 2), width // 2 + 1)
        while True:
            for oy in offs:
                for ox in offs:
                    self.blend(x0 + ox, y0 + oy, rgba)
            if x0 == x1 and y0 == y1:
                break
            e2 = 2 * err
            if e2 > -dy:
                err -= dy
                x0 += sx
            if e2 < dx:
                err += dx
                y0 += sy
        return self

    def circle(self, cx: int, cy: int, rad: int, rgba, fill: bool = True, width: int = 1) -> "Canvas":
        r2 = rad * rad
        inner = (rad - width) * (rad - width) if not fill else -1
        for y in range(cy - rad, cy + rad + 1):
            for x in range(cx - rad, cx + rad + 1):
                d2 = (x - cx) * (x - cx) + (y - cy) * (y - cy)
                if fill:
                    if d2 <= r2:
                        self.blend(x, y, rgba)
                elif inner < d2 <= r2:
                    self.blend(x, y, rgba)
        return self

    def ellipse(self, cx: int, cy: int, rx: int, ry: int, rgba, fill: bool = True, width: int = 2) -> "Canvas":
        for y in range(cy - ry, cy + ry + 1):
            for x in range(cx - rx, cx + rx + 1):
                d = ((x - cx) / max(1, rx)) ** 2 + ((y - cy) / max(1, ry)) ** 2
                if fill:
                    if d <= 1.0:
                        self.blend(x, y, rgba)
                else:
                    inner = ((rx - width) / max(1, rx)) ** 2
                    if inner < d <= 1.0:
                        self.blend(x, y, rgba)
        return self

    def disc_gradient(self, cx: int, cy: int, rad: int, inner_rgba, outer_rgba) -> "Canvas":
        for y in range(cy - rad, cy + rad + 1):
            for x in range(cx - rad, cx + rad + 1):
                d = math.hypot(x - cx, y - cy) / rad
                if d <= 1.0:
                    t = d * d * (3 - 2 * d)
                    self.blend(x, y, _lerp(inner_rgba, outer_rgba, t))
        return self

    def vgradient(self, x0: int, y0: int, x1: int, y1: int, stops) -> "Canvas":
        """Vertical gradient rect; stops = [(pos0..1, rgba), ...]."""
        stops = sorted(stops)
        x0, x1 = max(0, x0), min(self.w, x1)
        y0, y1 = max(0, y0), min(self.h, y1)
        span = max(1, y1 - y0 - 1)
        for y in range(y0, y1):
            t = (y - y0) / span
            rgba = _multi_lerp(stops, t)
            self.rect(x0, y, x1, y + 1, rgba)
        return self

    def noise_fill(self, x0: int, y0: int, x1: int, y1: int, seed: int,
                   dark, light, scale: int = 4, alpha: int = 255) -> "Canvas":
        """Tileable value-noise fill between two colors (deterministic)."""
        rng = random.Random(seed)
        gw = max(2, (x1 - x0 + scale - 1) // scale + 1)
        gh = max(2, (y1 - y0 + scale - 1) // scale + 1)
        grid = [[rng.random() for _ in range(gw)] for _ in range(gh)]
        # wrap edges so the noise tiles seamlessly
        for y in range(gh):
            grid[y][-1] = grid[y][0]
        grid[-1] = list(grid[0])
        for y in range(y0, y1):
            fy = (y - y0) / scale
            gy = int(fy)
            ty = _smooth(fy - gy)
            for x in range(x0, x1):
                fx = (x - x0) / scale
                gx = int(fx)
                tx = _smooth(fx - gx)
                v = _bilerp(grid[gy][gx], grid[gy][gx + 1], grid[gy + 1][gx], grid[gy + 1][gx + 1], tx, ty)
                self.set(x, y, _lerp(dark, light, v)[:3] + (alpha,))
        return self

    def speckle(self, x0: int, y0: int, x1: int, y1: int, seed: int,
                rgba, density: float = 0.02) -> "Canvas":
        # Note: isolated dots never need wrap-matching; only continuous
        # features (ridges, bands, masses) must be periodic at the seam.
        rng = random.Random(seed)
        for y in range(y0, y1):
            for x in range(x0, x1):
                if rng.random() < density:
                    self.blend(x, y, rgba)
        return self

    # -- masking ------------------------------------------------------
    def apply_alpha_mask(self, mask: bytes | bytearray) -> "Canvas":
        """Multiply our alpha by mask alpha (mask = RGBA bytes, same size)."""
        assert len(mask) == len(self.px)
        for i in range(3, len(self.px), 4):
            self.px[i] = self.px[i] * mask[i] // 255
        return self

    def save(self, path) -> "Canvas":
        write_png(path, self.w, self.h, self.px)
        return self


def _lerp(a, b, t: float):
    t = min(1.0, max(0.0, t))
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(4 if len(a) == 4 else 3))


def _multi_lerp(stops, t: float):
    if t <= stops[0][0]:
        return stops[0][1]
    for (t0, c0), (t1, c1) in zip(stops, stops[1:]):
        if t <= t1:
            return _lerp(c0, c1, (t - t0) / (t1 - t0) if t1 > t0 else 0.0)
    return stops[-1][1]


def _smooth(t: float) -> float:
    return t * t * (3 - 2 * t)


def _bilerp(a, b, c, d, tx, ty) -> float:
    return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty


# Brand palette (docs/DESIGN_SYNTHWAVE.md accent intent).
NIGHT0 = (8, 10, 22, 255)
NIGHT1 = (12, 18, 36, 255)
NIGHT2 = (18, 30, 56, 255)
CYAN = (77, 227, 247, 255)
PINK = (255, 46, 136, 255)
INDIGO = (108, 96, 255, 255)
ICE = (216, 246, 255, 255)
DIM = (96, 116, 148, 255)
