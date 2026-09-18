#!/usr/bin/env python3
"""Matte the generated potato weapon art (baked checker/white/black backdrops)
into true RGBA sprites, build the 768x512 collage and bake the six weapons into
data/game.png at the upstream-compatible sprite rects.

Pipeline per source image:
  1. detect backdrop model B(x,y): two-grey checkerboard (tile parity), flat
     white or flat black, from the border ring;
  2. d = per-pixel max channel distance to B;
  3. flood the border-connected region of d < 10  -> definite backdrop;
  4. feather alpha in a 4px band around that region: a = (d-8)/(90-8);
     everything else (sprite interior, enclosed glints) stays a = 1;
  5. un-premultiply colour against B so neon glow keeps its true hue;
  6. crop to content, contain into 256x256, save, collage, bake into game.png.
"""

import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets-src" / "weapons"
GAME = ROOT / "data" / "game.png"

WEAPONS = ["hammer", "pistol", "shotgun", "grenade", "laser", "ninja"]
# pixel rects on the 1024x512 sheet (grid 32x16 -> 32px tiles), upstream layout
RECTS = {
    "hammer": (64, 32, 128, 96),
    "pistol": (64, 128, 128, 64),
    "shotgun": (64, 192, 256, 64),
    "grenade": (64, 256, 224, 64),
    "ninja": (64, 320, 256, 64),
    "laser": (64, 384, 224, 96),
}
COLLAGE = (768, 512)  # 3 x 2 cells of 256

D_BG, D_F0, D_F1, FEATHER = 10.0, 8.0, 90.0, 4


def backdrop_model(rgb: np.ndarray):
    """Return B (H,W,3 float) plus a tag describing the backdrop kind."""
    h, w, _ = rgb.shape
    ring = np.concatenate([rgb[0:6].reshape(-1, 3), rgb[-6:].reshape(-1, 3),
                           rgb[:, 0:6].reshape(-1, 3), rgb[:, -6:].reshape(-1, 3)])
    spread = ring.max(1) - ring.min(1)
    neutral = ring[spread < 14]
    lum = neutral.mean(1) if len(neutral) else ring.mean(1)
    lo, hi = np.percentile(lum, [15, 85])
    if len(neutral) > 0.5 * len(ring) and hi - lo > 18:  # checkerboard
        # tile size from run lengths on the top row
        row = rgb[2].mean(1)
        dark = row < (lo + hi) / 2
        runs, cur = [], 1
        for i in range(1, len(dark)):
            if dark[i] == dark[i - 1]:
                cur += 1
            else:
                runs.append(cur)
                cur = 1
        runs.append(cur)
        tile = max(4, int(np.median(runs)))
        b1 = neutral[lum <= (lo + hi) / 2].mean(0)
        b2 = neutral[lum > (lo + hi) / 2].mean(0)
        yy, xx = np.mgrid[0:h, 0:w]
        parity = ((xx // tile) + (yy // tile)) % 2
        B = np.where(parity[..., None] == 0, b1, b2)
        return B, f"checker(tile={tile},b1={b1.astype(int)},b2={b2.astype(int)})"
    med = np.median(ring, axis=0)
    tag = "white" if med.mean() > 170 else ("black" if med.mean() < 60 else "flat")
    return np.ones_like(rgb, dtype=np.float64) * med, tag


def flood_border(mask: np.ndarray, seed_all: bool = False) -> np.ndarray:
    """border-connected component of mask, 4-neighbour, step-4 geodesic dilate"""
    rec = mask.copy() if seed_all else np.zeros_like(mask)
    if not seed_all:
        rec[0, :] = mask[0, :]
        rec[-1, :] = mask[-1, :]
        rec[:, 0] = mask[:, 0]
        rec[:, -1] = mask[:, -1]
    while True:
        nxt = rec.copy()
        for ax, sh in ((0, 4), (0, -4), (1, 4), (1, -4), (0, 1), (1, 1)):
            nxt |= np.roll(rec, sh, axis=ax)
        nxt &= mask
        if seed_all:
            pass
        else:
            # keep border seeds
            nxt[0, :] |= mask[0, :]
            nxt[-1, :] |= mask[-1, :]
            nxt[:, 0] |= mask[:, 0]
            nxt[:, -1] |= mask[:, -1]
        if (nxt == rec).all():
            return rec
        rec = nxt


def dilate(mask: np.ndarray, iters: int) -> np.ndarray:
    out = mask.copy()
    for _ in range(iters):
        nxt = out.copy()
        for ax in (0, 1):
            nxt |= np.roll(out, 1, axis=ax)
            nxt |= np.roll(out, -1, axis=ax)
        out = nxt
    return out


def flood_seeded(mask: np.ndarray, seeds: np.ndarray) -> np.ndarray:
    rec = seeds & mask
    while True:
        nxt = rec.copy()
        for ax, sh in ((0, 4), (0, -4), (1, 4), (1, -4), (0, 1), (1, 1)):
            nxt |= np.roll(rec, sh, axis=ax)
        nxt &= mask
        if (nxt == rec).all():
            return rec
        rec = nxt


def alpha_from(rgb: np.ndarray, B: np.ndarray, seeds: np.ndarray, seed_all: bool):
    d = np.abs(rgb - B).max(2)
    if seed_all:
        bg = d < D_BG
    else:
        bg = flood_seeded(d < D_BG, seeds)
    near = dilate(bg, FEATHER)
    a = np.where(near, np.clip((d - D_F0) / (D_F1 - D_F0), 0.0, 1.0), 1.0)
    a = np.where(near & (d < 4), 0.0, a)
    return a, d


def interior_flat_retry(rgb: np.ndarray, src_alpha: np.ndarray):
    """Fallback for sources whose flat backdrop sits inside a transparent
    margin: model B from the dominant neutral population and seed the flood
    along the perimeter of the opaque region instead of the image border."""
    spread = rgb.max(2) - rgb.min(2)
    lum = rgb.mean(2)
    pop = (spread < 14) & (lum > 50)
    if pop.sum() < 1000:
        return None
    B = np.ones_like(rgb) * np.median(rgb[pop], axis=0)
    opaque = src_alpha > 0.5
    if not opaque.any():
        return None
    ys, xs = np.nonzero(opaque)
    y0, y1, x0, x1 = ys.min(), ys.max(), xs.min(), xs.max()
    seeds = np.zeros(rgb.shape[0:2], dtype=bool)
    seeds[y0, x0:x1 + 1] = True
    seeds[y1, x0:x1 + 1] = True
    seeds[y0:y1 + 1, x0] = True
    seeds[y0:y1 + 1, x1] = True
    a, d = alpha_from(rgb, B, seeds, seed_all=False)
    return a, B, f"interior-flat(B={B[0, 0].astype(int)})"


def matte(path: Path, force_flat: bool = False, loose: bool = False):
    global D_BG, D_F0, D_F1
    if loose:
        D_BG, D_F0, D_F1 = 28.0, 24.0, 80.0
    raw = Image.open(path)
    src_alpha = np.asarray(raw.getchannel("A"), dtype=np.float64) / 255.0 \
        if raw.mode == "RGBA" else None
    rgb = np.asarray(raw.convert("RGB"), dtype=np.float64)
    seed_all = False
    if loose:
        spread = rgb.max(2) - rgb.min(2)
        lum = rgb.mean(2)
        pop = (spread < 14) & (lum > 50) & (lum < 160)
        B = np.ones_like(rgb) * np.median(rgb[pop], axis=0)
        tag = f"loose-grey(n={int(pop.sum())})"
        seed_all = True
    elif force_flat:
        ring = np.concatenate([rgb[0:6].reshape(-1, 3), rgb[-6:].reshape(-1, 3),
                               rgb[:, 0:6].reshape(-1, 3), rgb[:, -6:].reshape(-1, 3)])
        B = np.ones_like(rgb) * np.median(ring, axis=0)
        tag = "forced-flat"
    else:
        B, tag = backdrop_model(rgb)
    border = np.zeros(rgb.shape[0:2], dtype=bool)
    border[0, :] = border[-1, :] = True
    border[:, 0] = border[:, -1] = True
    a, d = alpha_from(rgb, B, border, seed_all)
    if src_alpha is not None:
        opaque = src_alpha > 0.5
        fill = 0.0
        if opaque.any():
            ys, xs = np.nonzero(opaque)
            bbox_area = (ys.max() - ys.min() + 1) * (xs.max() - xs.min() + 1)
            fill = opaque.sum() / bbox_area
        if (a > 0.5).mean() > 0.9 or fill > 0.85:
            retry = interior_flat_retry(rgb, src_alpha)
            if retry:
                a, B, tag2 = retry
                tag = f"{tag}+{tag2}"
    if src_alpha is not None:
        a = a * src_alpha
    safe = np.maximum(a, 1e-3)
    f = (rgb - B * (1.0 - a[..., None])) / safe[..., None]
    f = np.clip(f, 0, 255)
    out = np.dstack([f, a * 255.0]).astype(np.uint8)
    cov = (a > 0.5).mean()
    return out, f"{tag} coverage={cov:.3f}"


def contain(sprite: Image.Image, box):
    bw, bh = box
    w, h = sprite.size
    s = min(bw / w, bh / h)
    nw, nh = max(1, round(w * s)), max(1, round(h * s))
    return sprite.resize((nw, nh), Image.LANCZOS)


def prepare_source(path: Path, size: int, fit: int) -> Image.Image:
    """Normalize once; preserve raw input and never rematte normalized RGBA."""
    raw = Image.open(path)
    if raw.mode == "RGBA" and raw.size == (size, size):
        return raw.copy()
    import shutil
    backup = path.parent / "raw" / path.name
    backup.parent.mkdir(parents=True, exist_ok=True)
    if not backup.exists():
        shutil.copy2(path, backup)
    rgba, info = matte(path)
    img = Image.fromarray(rgba, "RGBA")
    bbox = img.getchannel("A").getbbox()
    if bbox is None:
        raise ValueError(f"Empty source: {path}")
    spr = contain(img.crop(bbox), (fit, fit))
    canvas = Image.new("RGBA", (size, size))
    canvas.paste(spr, ((size - spr.width) // 2, (size - spr.height) // 2))
    canvas.save(path)
    print(f"[normalize] {path.name}: {info}")
    return canvas


def main() -> int:
    SRC.mkdir(parents=True, exist_ok=True)
    matted = {name: prepare_source(SRC / f"{name}.png", 256, 250) for name in WEAPONS}

    coll = Image.new("RGBA", COLLAGE, (0, 0, 0, 0))
    for i, name in enumerate(WEAPONS):
        x, y = (i % 3) * 256, (i // 3) * 256
        coll.paste(matted[name], (x, y))
    coll.save(SRC / "weapons_all_6.png")
    print(f"[collage] {SRC / 'weapons_all_6.png'} {COLLAGE}")

    game = Image.open(GAME).convert("RGBA")
    assert game.size == (1024, 512), game.size
    for name in WEAPONS:
        x, y, w, h = RECTS[name]
        game.paste(Image.new("RGBA", (w, h), (0, 0, 0, 0)), (x, y))
        spr = contain(matted[name].crop(matted[name].getchannel("A").getbbox()), (w, h))
        game.paste(spr, (x + (w - spr.width) // 2, y + (h - spr.height) // 2))
        print(f"[bake] {name} -> rect {RECTS[name]} sprite {spr.size}")
    game.save(GAME)
    print(f"[bake] wrote {GAME}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
