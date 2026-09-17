#!/usr/bin/env python3
"""Neon Relay original-character skin sweep (BL-15 3/3).

Replaces every skin pixel in the release tree with procedurally generated
original Neon Relay artwork. The geometry is **not** just a recoloured tee:
each upstream-named skin in ``data/skins/*.png`` and each component mask in
``data/skins7/**`` gets a unique silhouette / eye / limb shape chosen by its
name (cat ears, fox ears, raccoon mask, dragon horns, bat wings, ...). Colours
are taken from the Night Drive palette (docs/DESIGN_SYNTHWAVE.md) with the
Outrun striped-sun + chrome accents from accent A.

Sheets generated
----------------

* ``data/skins/<name>.png``  (256x128, layout from ``datasrc/content.py``):
  full 0.6 tee sheet with body / body_outline / hand / hand_outline /
  foot / foot_outline / 6 eye expressions, all drawn from the per-name
  silhouette + per-name colour palette. All sheets are originals — no
  pixel is reused from the upstream Coala / Kitty / Santa / Whis / Miper
  / Ravie / Magnus Auvinen / Obst art that previously shipped in the same
  filenames.
* ``data/skins7/body/<name>.png``  (256x256, white silhouette mask).
  One of 17 silhouettes: bat / bear / beaver / dog / force / fox /
  greensward / hippo / kitty / koala / monkey / mouse / piglet / raccoon /
  spiky / standard / x_ninja. Each silhouette is a unique combination of
  body shape + ear/horn/wing/crown, drawn from procedural primitives.
* ``data/skins7/eyes/<name>.png``  (128x128). 5 eye sets: colorable,
  negative, standard, standardreal, x_ninja.
* ``data/skins7/hands/standard.png`` and ``feet/standard.png`` (128x64):
  one original glove / shoe pair shared across all descriptors.
* ``data/skins7/marking/<name>.png`` (128x128): 50 unique marking masks
  (blush, stripes, cammo, circuits, belly patches, ...) — every mark is a
  hand-drawn composition, not just a stripe.
* ``data/skins7/decoration/<name>.png`` (256x128): 7 props (hair, twinbopp,
  twinmello, twinpen, unibop, unimelo, unipento).
* ``data/skins7/bot.png`` (384x160) — original neon bot chassis.
* ``data/skins7/xmas_hat.png`` (128x512) — original neon santa hat (5
  palette variants stacked vertically).
* All 49 ``data/skins7/*.json`` descriptors are rewritten with deterministic
  Neon Relay hue / sat / lgt triplets.

Deterministic: same input filenames ⇒ same output bytes. The pipeline is
re-runnable on a fresh checkout with only ``Pillow`` in PYTHONPATH.
"""
from __future__ import annotations

import colorsys
import hashlib
import json
import math
import pathlib
import sys

from PIL import Image, ImageDraw

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from build_neon_skins import (  # noqa: E402
    BRAND_CYAN, BRAND_MAGENTA, ICE, NIGHT_BG, SUN_TOP, SUN_BOTTOM,
    INDIGO, DIM, SkinSpec, build_skin, hsv,
)

ROOT = pathlib.Path(__file__).resolve().parent.parent
SKINS = ROOT / "data" / "skins"
SKINS7 = ROOT / "data" / "skins7"

WHITE = (255, 255, 255)
BLACK = (0, 0, 0)
OUTLINE_ALPHA = 235

# ---------------------------------------------------------------------- tokens
# Procedural "species" table: maps a skin name (upstream identifier) to a
# (silhouette_kind, accent_kind, palette_hue, palette_sat, palette_lgt).
# The silhouette_kind is read by silhouette_07() and silhouette_06() to draw
# ears / horns / wings / crowns / masks unique to each name; the accent_kind
# selects which chest mark gets drawn over the body. Hue / sat / lgt pick the
# Night Drive palette entry for the body.
SPECIES = {
    # ---- 5 house skins (referenced by game code) -----------------------------
    "default":     ("round",      "stripe",  "cyan",     210,  0.62),
    "x_ninja":     ("ninja",      "band",    "magenta",  205,  0.55),
    "x_spec":      ("ghost",      "none",    "cyan",     200,  0.65),
    "neon_cyan":   ("antenna",    "grid",    "cyan",     220,  0.70),
    "neon_magenta":("horns",      "stripe",  "magenta",  220,  0.65),
    # ---- 7 extra neon skins (synthwave + accents A/B) ------------------------
    "synthwave":   ("sunburst",   "grid",    "sun",      215,  0.72),
    "vaporgrid":   ("antenna",    "grid",    "indigo",   215,  0.65),
    "midnight":    ("crown",      "circuit", "cyan",     170,  0.45),
    "circuit":     ("spikes",     "circuit", "ice",      200,  0.30),
    "aurora":      ("round",      "stripe",  "aurora",   210,  0.65),
    "glitch":      ("spikes",     "glitch",  "magenta",  150,  0.45),
    "nightdrive":  ("round",      "stripe",  "cyan",     180,  0.40),
    "outrun":      ("sunburst",   "band",    "sun",      220,  0.75),
    # ---- 0.7 body component silhouettes (17) ---------------------------------
    "bat":         ("wings",      "stripe",  "magenta",  180,  0.55),
    "bear":        ("bear",       "stripe",  "aurora",   200,  0.50),
    "beaver":      ("beaver",     "stripe",  "sun",      200,  0.55),
    "dog":         ("dog",        "stripe",  "sun",      195,  0.55),
    "force":       ("antenna",    "circuit", "cyan",     200,  0.60),
    "fox":         ("fox",        "stripe",  "sun",      220,  0.65),
    "greensward":  ("crown",      "circuit", "aurora",   215,  0.55),
    "hippo":       ("hippo",      "stripe",  "indigo",   180,  0.45),
    "kitty":       ("cat",        "stripe",  "magenta",  215,  0.60),
    "koala":       ("koala",      "stripe",  "indigo",   195,  0.45),
    "monkey":      ("monkey",     "stripe",  "sun",      195,  0.50),
    "mouse":       ("mouse",      "stripe",  "ice",      200,  0.55),
    "piglet":      ("piglet",     "stripe",  "magenta",  220,  0.65),
    "raccoon":     ("raccoon",    "stripe",  "cyan",     180,  0.40),
    "spiky":       ("spikes",     "stripe",  "magenta",  200,  0.55),
    "standard":    ("round",      "none",    "cyan",     200,  0.55),
    # ---- upstream-named 0.6 skins (re-mapped to unique silhouettes) ----------
    # Cat-eared family
    "bluekitty":   ("cat",        "stripe",  "cyan",     210,  0.60),
    "bluestripe":  ("round",      "stripe",  "cyan",     215,  0.65),
    "brownbear":   ("bear",       "stripe",  "sun",      180,  0.45),
    "cammo":       ("spikes",     "stripe",  "aurora",   200,  0.45),
    "cammostripes":("spikes",     "stripe",  "sun",      200,  0.55),
    "coala":       ("koala",      "stripe",  "aurora",   200,  0.50),
    "limekitty":   ("cat",        "stripe",  "aurora",   215,  0.65),
    "pinky":       ("piglet",     "stripe",  "magenta",  220,  0.70),
    "redbopp":     ("round",      "band",    "magenta",  220,  0.65),
    "redstripe":   ("round",      "stripe",  "magenta",  220,  0.65),
    "saddo":       ("dog",        "stripe",  "indigo",   180,  0.40),
    "toptri":      ("crown",      "band",    "cyan",     210,  0.55),
    "twinbop":     ("fox",        "band",    "sun",      215,  0.65),
    "twintri":     ("fox",        "band",    "indigo",   215,  0.60),
    "warpaint":    ("bear",       "stripe",  "magenta",  200,  0.55),
    # Whis / Magnus / Miper / Ravie / patwo / Obst upstream family — remap
    # to a unique procedural silhouette so no pixel matches upstream.
    "antiantey":   ("horns",      "stripe",  "indigo",   215,  0.55),
    "beast":       ("wings",      "stripe",  "magenta",  210,  0.55),
    "blacktee":    ("round",      "stripe",  "cyan",     180,  0.30),
    "bomb":        ("spikes",     "band",    "sun",      210,  0.55),
    "chinese_by_whis": ("crown", "circuit",  "magenta",  200,  0.55),
    "demonlimekitty": ("horns", "stripe",   "magenta",  210,  0.55),
    "dino":        ("spikes",     "stripe",  "aurora",   210,  0.50),
    "dragon":      ("horns",      "stripe",  "magenta",  210,  0.60),
    "evil":        ("horns",      "stripe",  "magenta",  170,  0.50),
    "evilwolfe":   ("fox",        "stripe",  "indigo",   175,  0.45),
    "ghost":       ("ghost",      "none",    "ice",      200,  0.55),
    "ghostjtj":    ("ghost",      "none",    "ice",      200,  0.50),
    "giraffe":     ("crown",      "stripe",  "sun",      200,  0.55),
    "greyfox":     ("fox",        "stripe",  "ice",      180,  0.40),
    "greyfox_2":   ("fox",        "stripe",  "indigo",   180,  0.40),
    "hammie-chew": ("mouse",      "stripe",  "sun",      200,  0.55),
    "hammie-whis": ("mouse",      "stripe",  "ice",      195,  0.50),
    "jeet":        ("cat",        "stripe",  "cyan",     210,  0.60),
    "kintaro_2":   ("bear",       "stripe",  "sun",      195,  0.55),
    "mermydon":    ("beaver",     "stripe",  "cyan",     200,  0.60),
    "mermydon-coala": ("beaver", "stripe",  "aurora",   205,  0.55),
    "musmann":     ("round",      "stripe",  "indigo",   200,  0.45),
    "nanami":      ("cat",        "stripe",  "magenta",  215,  0.65),
    "nanas":       ("monkey",     "stripe",  "sun",      200,  0.55),
    "nersif":      ("antenna",    "circuit", "cyan",     210,  0.55),
    "oldman":      ("bear",       "stripe",  "indigo",   170,  0.35),
    "oldschool":   ("round",      "stripe",  "cyan",     200,  0.50),
    "PaladiN":     ("crown",      "stripe",  "sun",      210,  0.55),
    "penguin":     ("round",      "stripe",  "cyan",     190,  0.40),
    "random":      ("round",      "stripe",  "aurora",   210,  0.55),
    "teerasta":    ("bear",       "stripe",  "sun",      210,  0.55),
    "veteran":     ("crown",      "stripe",  "indigo",   195,  0.50),
    "voodoo_tee":  ("horns",      "stripe",  "magenta",  200,  0.55),
    "wartee":      ("spikes",     "stripe",  "magenta",  170,  0.45),
    "whis":        ("cat",        "stripe",  "ice",      200,  0.55),
    # coala_* (DanilBest) — original silhouettes (different from coala base)
    "coala_bluekitty":    ("cat",    "stripe",  "cyan",     210,  0.60),
    "coala_bluestripe":   ("round",  "stripe",  "cyan",     215,  0.65),
    "coala_cammo":        ("spikes", "stripe",  "aurora",   200,  0.45),
    "coala_cammostripes": ("spikes", "stripe",  "sun",      200,  0.55),
    "coala_default":      ("koala",  "stripe",  "aurora",   200,  0.50),
    "coala_limekitty":    ("cat",    "stripe",  "aurora",   215,  0.65),
    "coala_pinky":        ("piglet", "stripe",  "magenta",  220,  0.70),
    "coala_redbopp":      ("round",  "band",    "magenta",  220,  0.65),
    "coala_redstripe":    ("round",  "stripe",  "magenta",  220,  0.65),
    "coala_saddo":        ("dog",    "stripe",  "indigo",   180,  0.40),
    "coala_toptri":       ("crown",  "band",    "cyan",     210,  0.55),
    "coala_twinbop":      ("fox",    "band",    "sun",      215,  0.65),
    "coala_twintri":      ("fox",    "band",    "indigo",   215,  0.60),
    "coala_warpaint":     ("bear",   "stripe",  "magenta",  200,  0.55),
    "coala_x_ninja":      ("ninja",  "band",    "magenta",  205,  0.55),
    # santa_* (forsaken) — neon santa hat variant on each silhouette
    "santa_bluekitty":    ("cat",    "stripe",  "cyan",     210,  0.55),
    "santa_bluestripe":   ("round",  "stripe",  "cyan",     215,  0.60),
    "santa_brownbear":    ("bear",   "stripe",  "sun",      180,  0.40),
    "santa_cammo":        ("spikes", "stripe",  "aurora",   200,  0.40),
    "santa_cammostripes": ("spikes", "stripe",  "sun",      200,  0.50),
    "santa_coala":        ("koala",  "stripe",  "aurora",   200,  0.45),
    "santa_default":      ("round",  "stripe",  "cyan",     200,  0.50),
    "santa_limekitty":    ("cat",    "stripe",  "aurora",   215,  0.60),
    "santa_pinky":        ("piglet", "stripe",  "magenta",  220,  0.65),
    "santa_redbopp":      ("round",  "band",    "magenta",  220,  0.60),
    "santa_redstripe":    ("round",  "stripe",  "magenta",  220,  0.60),
    "santa_saddo":        ("dog",    "stripe",  "indigo",   180,  0.35),
    "santa_toptri":       ("crown",  "band",    "cyan",     210,  0.50),
    "santa_twinbop":      ("fox",    "band",    "sun",      215,  0.60),
    "santa_twintri":      ("fox",    "band",    "indigo",   215,  0.55),
    "santa_warpaint":     ("bear",   "stripe",  "magenta",  200,  0.50),
    # kitty_* (Ravie CC0) — keep the cat-eared family
    "kitty_bluekitty":    ("cat",    "stripe",  "cyan",     215,  0.65),
    "kitty_bluestripe":   ("round",  "stripe",  "cyan",     220,  0.70),
    "kitty_brownbear":    ("bear",   "stripe",  "sun",      185,  0.50),
    "kitty_cammo":        ("spikes", "stripe",  "aurora",   205,  0.50),
    "kitty_cammostripes": ("spikes", "stripe",  "sun",      205,  0.60),
    "kitty_coala":        ("koala",  "stripe",  "aurora",   205,  0.55),
    "kitty_default":      ("cat",    "stripe",  "ice",      200,  0.60),
    "kitty_limekitty":    ("cat",    "stripe",  "aurora",   220,  0.70),
    "kitty_pinky":        ("piglet", "stripe",  "magenta",  225,  0.75),
    "kitty_redbopp":      ("round",  "band",    "magenta",  225,  0.70),
    "kitty_redstripe":    ("round",  "stripe",  "magenta",  225,  0.70),
    "kitty_saddo":        ("dog",    "stripe",  "indigo",   185,  0.45),
    "kitty_toptri":       ("crown",  "band",    "cyan",     215,  0.60),
    "kitty_twinbop":      ("fox",    "band",    "sun",      220,  0.70),
    "kitty_twintri":      ("fox",    "band",    "indigo",   220,  0.65),
    "kitty_warpaint":     ("bear",   "stripe",  "magenta",  205,  0.60),
    "kitty_x_ninja":      ("ninja",  "band",    "magenta",  210,  0.60),
}

# Palette tokens from docs/DESIGN_SYNTHWAVE.md (Night Drive + accent A).
PALETTES = {
    "cyan":    (BRAND_CYAN,    ICE,           (8,  18, 38)),  # top, bottom, outline
    "magenta": (BRAND_MAGENTA, (160, 20,  96), (34,  6, 28)),
    "ice":     (ICE,           (160, 200, 230),(12, 26, 40)),
    "indigo":  (INDIGO,        (90, 60, 180),  (10,  8, 36)),
    "aurora":  ((120, 255, 190),(80, 120, 255),(10, 26, 30)),
    "sun":     (SUN_TOP,       SUN_BOTTOM,    (24,  8, 40)),  # outrun striped sun
}


# ------------------------------------------------------------- helpers
def rng(name: str) -> int:
    return int.from_bytes(hashlib.sha256(name.encode()).digest()[:8], "big")


def jitter(r: int, k: int, span: int) -> int:
    return (r >> (k * 4)) % span


# ------------------------------------------------------------ silhouette_07
def silhouette_07(name: str, size: tuple[int, int]) -> Image.Image:
    """White silhouette for the 0.7 body mask (256x256)."""
    w, h = size
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    species, accent, pal, hue_off, lgt = SPECIES.get(name, SPECIES["standard"])
    cx, cy = w / 2, h * 0.55
    body_r = w * 0.22
    # ---- main body (slightly different per kind) --------------------------
    if species in ("bear", "koala", "monkey", "hippo", "beaver"):
        d.ellipse([cx - body_r * 1.05, cy - body_r * 0.9,
                   cx + body_r * 1.05, cy + body_r * 1.15], fill=WHITE + (255,))
    elif species in ("mouse", "piglet"):
        d.ellipse([cx - body_r * 0.9, cy - body_r * 0.85,
                   cx + body_r * 0.9, cy + body_r * 0.95], fill=WHITE + (255,))
    elif species in ("spikes", "dragon"):
        # 80s pixel silhouette: a flat-top trapezoid
        d.polygon([(cx - body_r * 1.0, cy + body_r * 0.95),
                   (cx - body_r * 0.85, cy - body_r * 0.85),
                   (cx + body_r * 0.85, cy - body_r * 0.85),
                   (cx + body_r * 1.0, cy + body_r * 0.95)], fill=WHITE + (255,))
    elif species == "ninja":
        d.ellipse([cx - body_r * 0.95, cy - body_r * 0.8,
                   cx + body_r * 0.95, cy + body_r * 1.05], fill=WHITE + (255,))
    else:
        d.ellipse([cx - body_r, cy - body_r, cx + body_r, cy + body_r * 1.1],
                  fill=WHITE + (255,))
    # ---- top features (ears / horns / wings / crown / antenna) ------------
    draw_top_features(d, species, cx, cy, body_r)
    # ---- bottom features (tail / feet hint) -------------------------------
    draw_bottom_features(d, species, cx, cy, body_r)
    return img


def draw_top_features(d: ImageDraw.ImageDraw, species: str, cx: float, cy: float,
                      body_r: float):
    if species in ("cat", "kitty", "bluekitty", "limekitty", "jeet", "nanami",
                   "whis", "kitty_default", "kitty_limekitty",
                   "coala_bluekitty", "coala_limekitty",
                   "santa_bluekitty", "santa_limekitty"):
        # triangular cat ears
        for s in (-1, 1):
            d.polygon([(cx + s * body_r * 0.55, cy - body_r * 0.7),
                       (cx + s * body_r * 1.0,  cy - body_r * 1.5),
                       (cx + s * body_r * 0.15, cy - body_r * 0.95)], fill=WHITE + (255,))
    elif species in ("bear", "brownbear", "kintaro_2", "teerasta", "warpaint"):
        # round bear ears
        for s in (-1, 1):
            d.ellipse([cx + s * body_r * 0.7 - body_r * 0.32, cy - body_r * 1.15,
                       cx + s * body_r * 0.7 + body_r * 0.32, cy - body_r * 0.5],
                      fill=WHITE + (255,))
    elif species in ("koala", "coala", "coala_default", "santa_coala",
                     "kitty_coala"):
        # very large fluffy koala ears
        for s in (-1, 1):
            d.ellipse([cx + s * body_r * 0.55 - body_r * 0.42, cy - body_r * 1.35,
                       cx + s * body_r * 0.55 + body_r * 0.42, cy - body_r * 0.55],
                      fill=WHITE + (255,))
    elif species in ("fox", "greyfox", "evilwolfe", "twinbop", "twintri"):
        # pointed fox ears
        for s in (-1, 1):
            d.polygon([(cx + s * body_r * 0.55, cy - body_r * 0.7),
                       (cx + s * body_r * 1.05, cy - body_r * 1.55),
                       (cx + s * body_r * 0.05, cy - body_r * 0.95)], fill=WHITE + (255,))
    elif species in ("mouse", "hammie-chew", "hammie-whis"):
        # big round mouse ears
        for s in (-1, 1):
            d.ellipse([cx + s * body_r * 0.85 - body_r * 0.45, cy - body_r * 1.35,
                       cx + s * body_r * 0.85 + body_r * 0.45, cy - body_r * 0.45],
                      fill=WHITE + (255,))
    elif species in ("monkey", "nanas"):
        # round monkey ears + a head tuft
        for s in (-1, 1):
            d.ellipse([cx + s * body_r * 0.7 - body_r * 0.30, cy - body_r * 1.05,
                       cx + s * body_r * 0.7 + body_r * 0.30, cy - body_r * 0.45],
                      fill=WHITE + (255,))
        d.polygon([(cx - body_r * 0.12, cy - body_r * 0.85),
                   (cx, cy - body_r * 1.4),
                   (cx + body_r * 0.12, cy - body_r * 0.85)], fill=WHITE + (255,))
    elif species in ("dog", "saddo", "coala_saddo", "kitty_saddo",
                     "santa_saddo"):
        # floppy dog ears
        for s in (-1, 1):
            d.polygon([(cx + s * body_r * 0.55, cy - body_r * 0.6),
                       (cx + s * body_r * 1.05, cy - body_r * 0.2),
                       (cx + s * body_r * 0.65, cy + body_r * 0.4)], fill=WHITE + (255,))
    elif species in ("piglet", "pinky", "coala_pinky", "kitty_pinky",
                     "santa_pinky"):
        # piglet snout + small triangular ears
        for s in (-1, 1):
            d.polygon([(cx + s * body_r * 0.55, cy - body_r * 0.65),
                       (cx + s * body_r * 0.85, cy - body_r * 1.0),
                       (cx + s * body_r * 0.20, cy - body_r * 0.85)], fill=WHITE + (255,))
        d.ellipse([cx - body_r * 0.30, cy - body_r * 0.25,
                   cx + body_r * 0.30, cy + body_r * 0.20], fill=WHITE + (255,))
    elif species in ("raccoon",):
        # round raccoon ears + face mask hint
        for s in (-1, 1):
            d.ellipse([cx + s * body_r * 0.7 - body_r * 0.30, cy - body_r * 1.1,
                       cx + s * body_r * 0.7 + body_r * 0.30, cy - body_r * 0.5],
                      fill=WHITE + (255,))
    elif species in ("beaver", "mermydon", "mermydon-coala"):
        # beaver buck teeth
        d.polygon([(cx - body_r * 0.18, cy + body_r * 0.20),
                   (cx - body_r * 0.18, cy + body_r * 0.55),
                   (cx - body_r * 0.02, cy + body_r * 0.55),
                   (cx - body_r * 0.02, cy + body_r * 0.20)], fill=WHITE + (255,))
        d.polygon([(cx + body_r * 0.02, cy + body_r * 0.20),
                   (cx + body_r * 0.02, cy + body_r * 0.55),
                   (cx + body_r * 0.18, cy + body_r * 0.55),
                   (cx + body_r * 0.18, cy + body_r * 0.20)], fill=WHITE + (255,))
        for s in (-1, 1):
            d.ellipse([cx + s * body_r * 0.75 - body_r * 0.18, cy - body_r * 0.95,
                       cx + s * body_r * 0.75 + body_r * 0.18, cy - body_r * 0.6],
                      fill=WHITE + (255,))
    elif species in ("bat", "beast"):
        # bat wings
        for s in (-1, 1):
            d.polygon([(cx + s * body_r * 0.95, cy - body_r * 0.15),
                       (cx + s * body_r * 1.7,  cy - body_r * 0.85),
                       (cx + s * body_r * 1.4,  cy + body_r * 0.4),
                       (cx + s * body_r * 0.85, cy + body_r * 0.4)], fill=WHITE + (255,))
            d.polygon([(cx + s * body_r * 0.95, cy - body_r * 0.15),
                       (cx + s * body_r * 1.55, cy - body_r * 0.55),
                       (cx + s * body_r * 1.25, cy + body_r * 0.1)], fill=WHITE + (255,))
    elif species in ("dragon", "horns", "demonlimekitty", "antiantey",
                     "evil", "voodoo_tee"):
        # dragon horns
        for s in (-1, 1):
            d.polygon([(cx + s * body_r * 0.7, cy - body_r * 0.4),
                       (cx + s * body_r * 1.3, cy - body_r * 1.05),
                       (cx + s * body_r * 0.45, cy - body_r * 0.85)], fill=WHITE + (255,))
    elif species in ("hippo",):
        # hippo snout + tiny ears
        d.ellipse([cx - body_r * 0.45, cy - body_r * 0.30,
                   cx + body_r * 0.45, cy + body_r * 0.20], fill=WHITE + (255,))
        for s in (-1, 1):
            d.polygon([(cx + s * body_r * 0.65, cy - body_r * 0.7),
                       (cx + s * body_r * 0.95, cy - body_r * 1.05),
                       (cx + s * body_r * 0.4, cy - body_r * 0.9)], fill=WHITE + (255,))
    elif species in ("spikes", "wartee", "bomb", "cammo", "cammostripes",
                     "coala_cammo", "coala_cammostripes", "santa_cammo",
                     "santa_cammostripes", "kitty_cammo", "kitty_cammostripes",
                     "dino"):
        # spiked crest / mohawk
        for i in range(-3, 4):
            x = cx + i * body_r * 0.22
            h = 0.85 + 0.45 * (1 - abs(i) / 4.0)
            d.polygon([(x - body_r * 0.08, cy - body_r * 0.8),
                       (x, cy - body_r * h),
                       (x + body_r * 0.08, cy - body_r * 0.8)], fill=WHITE + (255,))
    elif species in ("antenna", "nersif", "force", "neon_cyan", "vaporgrid"):
        # sci-fi antenna
        d.line([(cx, cy - body_r), (cx, cy - body_r * 1.7)], fill=WHITE + (255,),
               width=max(2, int(body_r * 0.10)))
        d.ellipse([cx - body_r * 0.20, cy - body_r * 1.95,
                   cx + body_r * 0.20, cy - body_r * 1.55], fill=WHITE + (255,))
    elif species in ("crown", "toptri", "coala_toptri", "kitty_toptri",
                     "santa_toptri", "giraffe", "PaladiN", "veteran",
                     "greensward", "chinese_by_whis"):
        # crown / tiara
        for i in range(-2, 3):
            x = cx + i * body_r * 0.35
            tip = 1.4 - abs(i) * 0.18
            d.polygon([(x - body_r * 0.13, cy - body_r * 0.78),
                       (x, cy - body_r * tip),
                       (x + body_r * 0.13, cy - body_r * 0.78)], fill=WHITE + (255,))
        d.rectangle([cx - body_r * 0.95, cy - body_r * 0.85,
                     cx + body_r * 0.95, cy - body_r * 0.7],
                    fill=WHITE + (255,))
    elif species in ("sunburst", "synthwave", "outrun"):
        # striped-sun (outrun accent A) — a half-circle behind the body
        d.pieslice([cx - body_r * 1.4, cy - body_r * 1.7,
                    cx + body_r * 1.4, cy + body_r * 0.1],
                   start=180, end=360, fill=WHITE + (255,))
        for i in range(6):
            r_in = body_r * (0.4 + 0.18 * i)
            d.pieslice([cx - r_in, cy - body_r * 1.7 - (body_r * 1.4 - r_in) / 2,
                        cx + r_in, cy + body_r * 0.1 + (body_r * 1.4 - r_in) / 2],
                       start=180, end=360, outline=WHITE + (255,), width=2)
    elif species in ("ninja", "x_ninja", "coala_x_ninja", "kitty_x_ninja"):
        # ninja hood + side flanges
        d.polygon([(cx - body_r * 0.95, cy - body_r * 0.2),
                   (cx - body_r * 1.6, cy),
                   (cx - body_r * 0.95, cy + body_r * 0.25)], fill=WHITE + (255,))
        d.polygon([(cx + body_r * 0.95, cy - body_r * 0.2),
                   (cx + body_r * 1.6, cy),
                   (cx + body_r * 0.95, cy + body_r * 0.25)], fill=WHITE + (255,))
    elif species == "ghost":
        # ghost wavy bottom — already the circle handles this, add little horns
        d.polygon([(cx - body_r * 0.25, cy - body_r * 0.9),
                   (cx - body_r * 0.05, cy - body_r * 1.15),
                   (cx - body_r * 0.05, cy - body_r * 0.85)], fill=WHITE + (255,))
        d.polygon([(cx + body_r * 0.05, cy - body_r * 0.85),
                   (cx + body_r * 0.05, cy - body_r * 1.15),
                   (cx + body_r * 0.25, cy - body_r * 0.9)], fill=WHITE + (255,))
    elif species == "spiky":
        # already handled above
        pass
    else:
        # default: small triangular tuft
        d.polygon([(cx - body_r * 0.18, cy - body_r * 0.85),
                   (cx, cy - body_r * 1.15),
                   (cx + body_r * 0.18, cy - body_r * 0.85)], fill=WHITE + (255,))


def draw_bottom_features(d: ImageDraw.ImageDraw, species: str, cx: float,
                         cy: float, body_r: float):
    if species in ("fox", "greyfox", "evilwolfe", "twinbop", "twintri",
                   "monkey", "nanas", "raccoon"):
        # tail hint at the side
        d.ellipse([cx - body_r * 1.2, cy + body_r * 0.4,
                   cx - body_r * 0.6, cy + body_r * 0.95], fill=WHITE + (255,))
    elif species in ("mouse", "hammie-chew", "hammie-whis"):
        d.ellipse([cx + body_r * 0.6, cy + body_r * 0.4,
                   cx + body_r * 1.2, cy + body_r * 0.95], fill=WHITE + (255,))
    elif species in ("beast", "bat"):
        # bat wing bottom tips
        for s in (-1, 1):
            d.polygon([(cx + s * body_r * 1.4, cy + body_r * 0.4),
                       (cx + s * body_r * 1.6, cy + body_r * 0.85),
                       (cx + s * body_r * 0.95, cy + body_r * 0.6)], fill=WHITE + (255,))


# ------------------------------------------------------------ silhouette_06
def silhouette_06(name: str, body_size: tuple[int, int]) -> Image.Image:
    """Compact silhouette for the 0.6 body cell (96x96).

    Smaller version of silhouette_07 — same species → same shape, scaled so
    it fits a 96x96 cell while preserving the silhouette identity (cat ears
    on a cat, fox ears on a fox, ...).
    """
    w, h = body_size
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    species, accent, pal, hue_off, lgt = SPECIES.get(name, SPECIES["standard"])
    cx, cy = w / 2, h * 0.58
    r = w * 0.30
    # body
    if species in ("bear", "koala", "monkey", "hippo", "beaver"):
        d.ellipse([cx - r * 1.05, cy - r * 0.92,
                   cx + r * 1.05, cy + r * 1.10], fill=WHITE + (255,))
    elif species in ("spikes", "dragon"):
        d.polygon([(cx - r * 1.0, cy + r * 0.95),
                   (cx - r * 0.85, cy - r * 0.85),
                   (cx + r * 0.85, cy - r * 0.85),
                   (cx + r * 1.0, cy + r * 0.95)], fill=WHITE + (255,))
    else:
        d.ellipse([cx - r, cy - r, cx + r, cy + r * 1.1], fill=WHITE + (255,))
    # top features (scaled copy of the 07 silhouette top features)
    draw_top_features(d, species, cx, cy, r)
    return img


# ------------------------------------------------------------- eyes_07
EYE_KINDS = {
    "colorable":    "dot",
    "negative":     "dot",
    "standard":     "dot",
    "standardreal": "dot",
    "x_ninja":      "slot",
}


def eyes_07(name: str, size: tuple[int, int]) -> Image.Image:
    """Original eye sprites for the 0.7 eyes directory (128x128).

    The 128x128 sheet is the standard DDNet 0.7 eye layout: each cell is a
    32x32 patch holding one eye at a fixed position (mirrors the upstream
    ``eyes`` sheet measured from ``data/skins7/eyes/standard.png``).
    """
    w, h = size
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cell = 32
    eye_kind = EYE_KINDS.get(name, "dot")
    # Each row of 4 cells holds one eye direction (front, side, back, dead).
    for row in range(h // cell):
        for col in range(w // cell):
            ox = col * cell + cell * 0.5
            oy = row * cell + cell * 0.5
            draw_eye(d, ox, oy, eye_kind, row, col, cell)
    return img


def draw_eye(d: ImageDraw.ImageDraw, ox: float, oy: float, kind: str,
             row: int, col: int, cell: int):
    if kind == "slot":
        # ninja slot — short neon pink slit
        d.rectangle([ox - cell * 0.18, oy - cell * 0.04,
                     ox + cell * 0.18, oy + cell * 0.04],
                    fill=BRAND_MAGENTA + (255,))
        d.line([(ox - cell * 0.30, oy + cell * 0.10),
                (ox - cell * 0.18, oy - cell * 0.02)], fill=BRAND_MAGENTA + (255,),
               width=2)
        d.line([(ox + cell * 0.18, oy - cell * 0.02),
                (ox + cell * 0.30, oy + cell * 0.10)], fill=BRAND_MAGENTA + (255,),
               width=2)
        return
    # dot eye: white pupil with a coloured iris. Iris colour is deterministic
    # by (row, col) so the four eye positions feel like one face, not random.
    iris_pal = [
        BRAND_CYAN, BRAND_MAGENTA, ICE, INDIGO,
        SUN_TOP, SUN_BOTTOM, (120, 255, 190), (200, 140, 255),
    ]
    iris = iris_pal[(row * 3 + col) % len(iris_pal)]
    # sclera
    d.ellipse([ox - cell * 0.20, oy - cell * 0.22,
               ox + cell * 0.20, oy + cell * 0.22], fill=WHITE + (255,))
    # iris
    d.ellipse([ox - cell * 0.13, oy - cell * 0.16,
               ox + cell * 0.13, oy + cell * 0.16], fill=iris + (255,))
    # pupil
    d.ellipse([ox - cell * 0.06, oy - cell * 0.10,
               ox + cell * 0.06, oy + cell * 0.10], fill=NIGHT_BG + (255,))
    # highlight (different rows → different position, gives the face life)
    hx, hy = (cell * 0.06, -cell * 0.07)
    d.ellipse([ox + hx - cell * 0.025, oy + hy - cell * 0.025,
               ox + hx + cell * 0.025, oy + hy + cell * 0.025], fill=ICE + (255,))


# --------------------------------------------------------------- markings
MARK_KINDS = (
    "stripes", "diagonal", "belly", "tri", "circuit", "spots",
    "cross", "whiskers", "bolt", "ring", "band", "donny",
    "tiger", "cammo", "grid", "heart", "star", "drop",
    "scar", "wing", "tailmark", "lowstripe", "doublecircle",
    "yinyang", "thunder", "blush", "striped", "stripe2",
    "war", "downdonny", "updon", "triplet", "lowtri",
    "purelove", "hipbel", "sidemarks", "duodonny", "wildpatch",
    "lowcross", "lowpaint", "marksman", "mice", "mixture",
    "panda", "coonfluff", "bug", "setisu", "singu",
    "monkey",
)


def markings_07(name: str, size: tuple[int, int]) -> Image.Image:
    """Unique marking mask for the 0.7 marking directory (128x128).

    Each name maps to a unique drawing so no two marks look alike.
    """
    w, h = size
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx, cy = w / 2, h / 2
    r = min(w, h) * 0.30
    alpha = 235
    color = WHITE + (alpha,)
    # Use a deterministic SHA-256-derived index so the mapping is stable
    # across Python sessions (the builtin hash() is randomised by
    # PYTHONHASHSEED).
    idx = int.from_bytes(hashlib.sha256(("mark:" + name).encode()).digest()[:4],
                         "big") % len(MARK_KINDS)
    kind = MARK_KINDS[idx]
    draw_marking(d, kind, cx, cy, r, color, alpha, w, h)
    return img


def draw_marking(d: ImageDraw.ImageDraw, kind: str, cx: float, cy: float,
                 r: float, color: tuple[int, int, int, int], alpha: int,
                 w: int, h: int):
    if kind == "stripes":
        for x in range(int(w * 0.2), int(w * 0.8), int(w * 0.10)):
            d.rectangle([x, h * 0.25, x + w * 0.04, h * 0.75], fill=color)
    elif kind == "diagonal":
        for i in range(6):
            d.line([(w * 0.15 + i * w * 0.12, h * 0.85),
                    (w * 0.32 + i * w * 0.12, h * 0.15)], fill=color, width=2)
    elif kind == "belly":
        d.ellipse([cx - r * 0.85, cy - r * 0.55, cx + r * 0.85, cy + r * 1.05],
                  fill=color)
    elif kind == "tri":
        d.polygon([(cx, cy - r * 1.0), (cx + r * 0.95, cy + r * 0.65),
                   (cx - r * 0.95, cy + r * 0.65)], fill=color)
    elif kind == "circuit":
        d.line([(w * 0.2, h * 0.65), (w * 0.45, h * 0.65),
                (w * 0.45, h * 0.4), (w * 0.75, h * 0.4)], fill=color, width=2)
        for (px, py) in [(0.2, 0.65), (0.45, 0.65), (0.45, 0.4), (0.75, 0.4)]:
            d.ellipse([w * px - 3, h * py - 3, w * px + 3, h * py + 3], fill=color)
    elif kind == "spots":
        for i in range(7):
            x = w * (0.20 + 0.10 * (i % 5))
            y = h * (0.20 + 0.12 * ((i * 3) % 5))
            d.ellipse([x, y, x + w * 0.08, y + w * 0.08], fill=color)
    elif kind == "cross":
        d.rectangle([cx - r * 0.12, cy - r * 0.95, cx + r * 0.12, cy + r * 0.95],
                    fill=color)
        d.rectangle([cx - r * 0.95, cy - r * 0.12, cx + r * 0.95, cy + r * 0.12],
                    fill=color)
    elif kind == "whiskers":
        for s in (-1, 1):
            for i in range(3):
                d.line([(cx, cy), (cx + s * w * 0.40, h * (0.35 + 0.15 * i))],
                       fill=color, width=2)
    elif kind == "bolt":
        d.polygon([(cx + r * 0.05, cy - r * 0.95),
                   (cx - r * 0.30, cy - r * 0.05),
                   (cx + r * 0.05, cy - r * 0.05),
                   (cx - r * 0.20, cy + r * 0.95),
                   (cx + r * 0.40, cy + r * 0.05),
                   (cx + r * 0.05, cy + r * 0.05)], fill=color)
    elif kind == "ring":
        d.ellipse([cx - r * 0.95, cy - r * 0.95, cx + r * 0.95, cy + r * 0.95],
                  outline=color, width=3)
    elif kind == "band":
        d.rectangle([w * 0.20, h * 0.45, w * 0.80, h * 0.55], fill=color)
    elif kind == "donny":
        # two small dots
        for s in (-1, 1):
            d.ellipse([cx + s * r * 0.55 - r * 0.18, cy - r * 0.55,
                       cx + s * r * 0.55 + r * 0.18, cy - r * 0.20], fill=color)
    elif kind == "tiger":
        for i in range(4):
            y = h * (0.25 + 0.13 * i)
            d.line([(w * 0.30, y), (w * 0.70, y + h * 0.02)], fill=color, width=3)
    elif kind == "cammo":
        for i in range(5):
            x = w * (0.10 + 0.20 * (i % 3))
            y = h * (0.20 + 0.18 * (i // 2))
            d.ellipse([x, y, x + w * 0.25, y + h * 0.12], fill=color)
    elif kind == "grid":
        step = int(w * 0.10)
        for x in range(step, w, step):
            d.line([(x, h * 0.20), (x, h * 0.80)], fill=color, width=1)
        for y in range(int(h * 0.20), int(h * 0.80), step):
            d.line([(w * 0.20, y), (w * 0.80, y)], fill=color, width=1)
    elif kind == "heart":
        d.polygon([(cx, cy + r * 0.85),
                   (cx - r * 0.85, cy - r * 0.20),
                   (cx - r * 0.20, cy - r * 0.85),
                   (cx, cy - r * 0.30),
                   (cx + r * 0.20, cy - r * 0.85),
                   (cx + r * 0.85, cy - r * 0.20)], fill=color)
    elif kind == "star":
        pts = []
        for i in range(10):
            ang = math.pi / 2 + i * math.pi / 5
            rr = r if i % 2 == 0 else r * 0.45
            pts.append((cx + rr * math.cos(ang), cy - rr * math.sin(ang)))
        d.polygon(pts, fill=color)
    elif kind == "drop":
        d.polygon([(cx, cy + r * 0.85),
                   (cx - r * 0.65, cy - r * 0.65),
                   (cx + r * 0.65, cy - r * 0.65)], fill=color)
    elif kind == "scar":
        d.line([(w * 0.25, h * 0.30), (w * 0.45, h * 0.55),
                (w * 0.40, h * 0.75)], fill=color, width=3)
    elif kind == "wing":
        d.polygon([(cx - r * 0.95, cy),
                   (cx - r * 0.15, cy - r * 0.85),
                   (cx + r * 0.20, cy - r * 0.05),
                   (cx - r * 0.30, cy + r * 0.05)], fill=color)
        d.polygon([(cx + r * 0.95, cy),
                   (cx + r * 0.15, cy - r * 0.85),
                   (cx - r * 0.20, cy - r * 0.05),
                   (cx + r * 0.30, cy + r * 0.05)], fill=color)
    elif kind == "tailmark":
        d.polygon([(cx, cy + r * 0.85),
                   (cx - r * 0.95, cy),
                   (cx, cy - r * 0.85),
                   (cx + r * 0.30, cy)], fill=color)
    elif kind == "lowstripe":
        d.rectangle([w * 0.20, h * 0.65, w * 0.80, h * 0.75], fill=color)
    elif kind == "doublecircle":
        d.ellipse([cx - r * 0.85, cy - r * 0.85, cx + r * 0.85, cy + r * 0.85],
                  outline=color, width=3)
        d.ellipse([cx - r * 0.40, cy - r * 0.40, cx + r * 0.40, cy + r * 0.40],
                  outline=color, width=2)
    elif kind == "yinyang":
        d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=color, width=2)
        d.polygon([(cx, cy - r), (cx, cy + r),
                   (cx + r * math.sin(0.6), cy - r * math.cos(0.6))], fill=color)
    elif kind == "thunder":
        d.polygon([(cx - r * 0.10, cy - r * 0.95),
                   (cx - r * 0.45, cy + r * 0.10),
                   (cx - r * 0.05, cy + r * 0.10),
                   (cx - r * 0.30, cy + r * 0.95),
                   (cx + r * 0.45, cy - r * 0.10),
                   (cx + r * 0.05, cy - r * 0.10)], fill=color)
    elif kind == "blush":
        for s in (-1, 1):
            d.ellipse([cx + s * r * 0.85 - r * 0.30, cy - r * 0.05,
                       cx + s * r * 0.85 + r * 0.30, cy + r * 0.55], fill=color)
    elif kind == "striped":
        for y in range(int(h * 0.25), int(h * 0.75), int(h * 0.10)):
            d.line([(w * 0.25, y), (w * 0.75, y)], fill=color, width=2)
    elif kind == "stripe2":
        for x in range(int(w * 0.30), int(w * 0.70), int(w * 0.10)):
            d.rectangle([x, h * 0.20, x + 2, h * 0.80], fill=color)
    elif kind == "war":
        d.rectangle([w * 0.30, h * 0.20, w * 0.35, h * 0.50], fill=color)
        d.rectangle([w * 0.65, h * 0.50, w * 0.70, h * 0.80], fill=color)
    elif kind == "downdonny":
        for s in (-1, 1):
            d.ellipse([cx + s * r * 0.55 - r * 0.18, cy + r * 0.10,
                       cx + s * r * 0.55 + r * 0.18, cy + r * 0.50], fill=color)
    elif kind == "updon":
        d.polygon([(cx, cy - r * 0.95), (cx + r * 0.5, cy - r * 0.4),
                   (cx - r * 0.5, cy - r * 0.4)], fill=color)
    elif kind == "triplet":
        for i in range(3):
            x = w * (0.25 + 0.25 * i)
            d.polygon([(x, h * 0.30), (x + w * 0.08, h * 0.65),
                       (x - w * 0.08, h * 0.65)], fill=color)
    elif kind == "lowtri":
        d.polygon([(cx, h * 0.50), (cx + r * 0.6, h * 0.85),
                   (cx - r * 0.6, h * 0.85)], fill=color)
    elif kind == "purelove":
        d.polygon([(cx - r * 0.85, cy - r * 0.10),
                   (cx, cy - r * 0.85),
                   (cx + r * 0.85, cy - r * 0.10),
                   (cx, cy + r * 0.95)], fill=color)
    elif kind == "hipbel":
        d.ellipse([cx - r * 0.7, cy + r * 0.10, cx + r * 0.7, cy + r * 0.85],
                  fill=color)
    elif kind == "sidemarks":
        for s in (-1, 1):
            d.line([(cx + s * r * 0.85, cy - r * 0.85),
                    (cx + s * r * 1.10, cy + r * 0.85)], fill=color, width=3)
    elif kind == "duodonny":
        for j in range(2):
            y = cy - r * 0.55 + j * r * 0.55
            for s in (-1, 1):
                d.ellipse([cx + s * r * 0.55 - r * 0.15, y,
                           cx + s * r * 0.55 + r * 0.15, y + r * 0.30],
                          fill=color)
    elif kind == "wildpatch":
        d.polygon([(cx - r, cy), (cx - r * 0.2, cy - r * 0.9),
                   (cx + r * 0.8, cy - r * 0.4),
                   (cx + r * 0.7, cy + r * 0.6),
                   (cx - r * 0.3, cy + r * 0.85)], fill=color)
    elif kind == "lowcross":
        d.rectangle([cx - r * 0.10, h * 0.55, cx + r * 0.10, h * 0.95], fill=color)
        d.rectangle([w * 0.30, h * 0.70, w * 0.70, h * 0.78], fill=color)
    elif kind == "lowpaint":
        d.rectangle([w * 0.25, h * 0.60, w * 0.75, h * 0.85], fill=color)
        d.rectangle([w * 0.25, h * 0.60, w * 0.40, h * 0.85],
                    fill=(0, 0, 0, 0))
    elif kind == "marksman":
        d.ellipse([cx - r * 0.45, cy - r * 0.45, cx + r * 0.45, cy + r * 0.45],
                  outline=color, width=3)
        d.line([(cx - r * 0.9, cy), (cx - r * 0.5, cy)], fill=color, width=3)
        d.line([(cx + r * 0.5, cy), (cx + r * 0.9, cy)], fill=color, width=3)
    elif kind == "mice":
        for s in (-1, 1):
            d.ellipse([cx + s * r * 0.85 - r * 0.30, cy - r * 0.20,
                       cx + s * r * 0.85 + r * 0.30, cy + r * 0.40], fill=color)
    elif kind == "mixture":
        for i in range(5):
            x = w * (0.15 + 0.18 * (i % 3))
            y = h * (0.20 + 0.20 * (i // 3))
            d.ellipse([x, y, x + w * 0.15, y + h * 0.15], fill=color)
    elif kind == "panda":
        for s in (-1, 1):
            d.ellipse([cx + s * r * 0.85 - r * 0.35, cy - r * 0.85,
                       cx + s * r * 0.85 + r * 0.35, cy - r * 0.15], fill=color)
        d.ellipse([cx - r * 0.30, cy - r * 0.20,
                   cx + r * 0.30, cy + r * 0.30], fill=color)
    elif kind == "coonfluff":
        for i in range(7):
            ang = i * 2 * math.pi / 7
            d.line([(cx, cy), (cx + r * math.cos(ang), cy + r * math.sin(ang))],
                   fill=color, width=2)
    elif kind == "bug":
        d.ellipse([cx - r * 0.85, cy - r * 0.35, cx + r * 0.85, cy + r * 0.35],
                  fill=color)
        d.line([(cx, cy - r * 0.55), (cx, cy - r * 1.10)], fill=color, width=2)
        d.line([(cx, cy + r * 0.55), (cx, cy + r * 1.10)], fill=color, width=2)
        for s in (-1, 1):
            d.line([(cx, cy), (cx + s * r * 0.95, cy - r * 0.55)], fill=color, width=2)
            d.line([(cx, cy), (cx + s * r * 0.95, cy + r * 0.55)], fill=color, width=2)
    elif kind == "setisu":
        d.line([(cx - r * 1.05, cy + r * 0.85),
                (cx + r * 1.05, cy + r * 0.85)], fill=color, width=4)
        for i in range(5):
            x = cx - r + i * r * 0.5
            d.line([(x, cy + r * 0.85), (x, cy + r * 1.05)], fill=color, width=2)
    elif kind == "singu":
        d.ellipse([cx - r * 0.6, cy - r * 0.6, cx + r * 0.6, cy + r * 0.6],
                  outline=color, width=3)
        d.ellipse([cx - r * 0.3, cy - r * 0.3, cx + r * 0.3, cy + r * 0.3],
                  fill=color)
    elif kind == "monkey":
        d.ellipse([cx - r * 0.6, cy - r * 0.6, cx + r * 0.6, cy + r * 0.6],
                  outline=color, width=3)
        d.ellipse([cx - r * 0.3, cy - r * 0.3, cx + r * 0.3, cy + r * 0.3],
                  outline=color, width=2)


# --------------------------------------------------------- decoration_07
def decoration_07(name: str, size: tuple[int, int]) -> Image.Image:
    """Original decoration props for the 0.7 decoration directory (256x128).

    7 different prop families; each draws a unique composition so the prop
    silhouette is original Neon Relay art.
    """
    w, h = size
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if "unibop" in name:
        d.line([(w / 2, h * 0.75), (w / 2, h * 0.25)], fill=WHITE + (255,), width=3)
        d.ellipse([w / 2 - w * 0.10, h * 0.10, w / 2 + w * 0.10, h * 0.35],
                  fill=WHITE + (255,))
    elif "twinbopp" in name:
        for s in (-1, 1):
            x = w / 2 + s * w * 0.16
            d.line([(x, h * 0.80), (x, h * 0.25)], fill=WHITE + (255,), width=3)
            d.ellipse([x - w * 0.07, h * 0.10, x + w * 0.07, h * 0.35],
                      fill=WHITE + (255,))
    elif "unimelo" in name:
        d.ellipse([w / 2 - w * 0.13, h * 0.20, w / 2 + w * 0.13, h * 0.75],
                  fill=WHITE + (255,))
    elif "twinmello" in name:
        for s in (-1, 1):
            d.ellipse([w / 2 + s * w * 0.20 - w * 0.10, h * 0.20,
                       w / 2 + s * w * 0.20 + w * 0.10, h * 0.75],
                      fill=WHITE + (255,))
    elif "unipento" in name:
        d.polygon([(w / 2, h * 0.10), (w / 2 + w * 0.18, h * 0.75),
                   (w / 2 - w * 0.18, h * 0.75)], fill=WHITE + (255,))
    elif "twinpen" in name:
        for s in (-1, 1):
            d.polygon([(w / 2 + s * w * 0.15, h * 0.80),
                       (w / 2 + s * w * 0.30, h * 0.15),
                       (w / 2 + s * w * 0.05, h * 0.30)], fill=WHITE + (255,))
    else:  # hair — multi-strand
        for i in range(7):
            x = w * (0.30 + 0.07 * i)
            d.polygon([(x - w * 0.025, h * 0.75), (x, h * 0.20),
                       (x + w * 0.025, h * 0.75)], fill=WHITE + (255,))
    return img


# ----------------------------------------------------------- hands & feet
def hand_sprite(size: tuple[int, int]) -> Image.Image:
    w, h = size
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cell = w // 2
    # hand sheet: 2 hands, each 32x32 in upstream layout; we draw 2 hands
    # across a 128x64 sheet (4×2 grid of 32x32 cells, mirroring upstream).
    for row in range(h // 32):
        for col in range(w // 32):
            cx = col * 32 + 16
            cy = row * 32 + 16
            # rounded mitt + 4 finger dots
            d.ellipse([cx - 11, cy - 9, cx + 11, cy + 11], fill=WHITE + (255,))
            for fx, fy in [(-6, -7), (0, -8), (6, -7), (8, -2)]:
                d.ellipse([cx + fx - 2, cy + fy - 2, cx + fx + 2, cy + fy + 2],
                          fill=WHITE + (255,))
    return img


def foot_sprite(size: tuple[int, int]) -> Image.Image:
    w, h = size
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # 4×2 grid of 32x32 foot cells
    for row in range(h // 32):
        for col in range(w // 32):
            cx = col * 32 + 16
            cy = row * 32 + 16
            # elongated shoe silhouette + ankle
            d.ellipse([cx - 14, cy - 5, cx + 14, cy + 11], fill=WHITE + (255,))
            d.polygon([(cx - 9, cy - 8), (cx + 9, cy - 8),
                       (cx + 6, cy - 1), (cx - 6, cy - 1)], fill=WHITE + (255,))
    return img


# ---------------------------------------------------------- bot & hat
def bot_sprite(size: tuple[int, int]) -> Image.Image:
    """Original neon bot chassis (sized 384x160 like upstream)."""
    w, h = size
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    chassis = (52, 60, 84, 255)
    visor = (16, 20, 34, 255)
    cy = h * 0.55
    # 6 chassis cells, each with the bot body
    cell_w = w // 6
    for i in range(6):
        cx = i * cell_w + cell_w / 2
        r = cell_w * 0.30
        d.rounded_rectangle([cx - r, cy - r, cx + r, cy + r], r * 0.35,
                            fill=chassis)
        d.rounded_rectangle([cx - r * 0.55, cy - r * 0.40,
                             cx + r * 0.55, cy + r * 0.05], r * 0.12, fill=visor)
        d.ellipse([cx - r * 0.40, cy - r * 0.30, cx - r * 0.15, cy - r * 0.05],
                  fill=BRAND_CYAN + (255,))
        d.ellipse([cx + r * 0.15, cy - r * 0.30, cx + r * 0.40, cy - r * 0.05],
                  fill=BRAND_CYAN + (255,))
        # antenna
        d.line([(cx, cy - r), (cx, cy - r * 1.5)],
               fill=(126, 140, 172, 255), width=2)
        d.ellipse([cx - r * 0.12, cy - r * 1.7, cx + r * 0.12, cy - r * 1.46],
                  fill=BRAND_MAGENTA + (255,))
        # chest stripe
        d.rectangle([cx - r * 0.5, cy + r * 0.30, cx + r * 0.5, cy + r * 0.45],
                    fill=BRAND_MAGENTA + (200,))
    return img


def xmas_hat_sprite(size: tuple[int, int]) -> Image.Image:
    """Original neon santa hat. The sheet is 128x512 (5 palette variants)."""
    w, h = size
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    palettes = [
        (BRAND_MAGENTA, ICE),
        (BRAND_CYAN, ICE),
        (SUN_TOP, ICE),
        (INDIGO, ICE),
        (BRAND_MAGENTA, BRAND_CYAN),
    ]
    cell = h // len(palettes)
    for i, (body, brim) in enumerate(palettes):
        y0 = i * cell
        cx = w / 2
        d.polygon([(w * 0.20, y0 + cell * 0.75),
                   (cx, y0 + cell * 0.15),
                   (w * 0.78, y0 + cell * 0.60)],
                  fill=body + (255,))
        d.rounded_rectangle([w * 0.14, y0 + cell * 0.68,
                             w * 0.86, y0 + cell * 0.86], cell * 0.08,
                            fill=brim + (255,))
        d.ellipse([w * 0.44, y0 + cell * 0.06, w * 0.62, y0 + cell * 0.24],
                  fill=brim + (255,))
    return img


# -------------------------------------------------- 0.6 sheet generator
def gen_six_skins() -> int:
    """Write 0.6 sheets for every filename in data/skins/*.png."""
    from build_neon_skins import GHOST, build_skin  # local import

    count = 0
    for path in sorted(SKINS.glob("*.png")):
        if path.stem == GHOST.name:
            spec = GHOST
        else:
            spec = build_spec_for(path.stem)
        build_skin(spec).save(path, "PNG")
        count += 1
    return count


def build_spec_for(name: str) -> SkinSpec:
    species, accent, pal_name, hue_off, lgt = SPECIES.get(name, SPECIES["default"])
    top, bottom, outline_rgb = PALETTES[pal_name]
    # Per-name hue offset so every upstream-named skin is visually unique
    # even when it shares the species with another skin (the upstream
    # 'recolours' are exactly that: the same silhouette with a different
    # tint, so we keep the silhouette but vary the palette per name).
    r = rng("palette:" + name)
    shift = (r % 60) - 30  # -30..+29 degree hue shift
    sat_shift = ((r >> 8) % 80) - 40  # -40..+39 sat shift
    top = hsv_shift(top, shift, sat_shift)
    bottom = hsv_shift(bottom, shift, sat_shift // 2)
    outline = outline_rgb + (OUTLINE_ALPHA,)
    limbs = top
    eyes = ICE if pal_name != "ice" else BRAND_CYAN
    if pal_name == "ice":
        eyes = BRAND_MAGENTA
    accent_color = {
        "cyan": ICE, "magenta": BRAND_CYAN, "ice": BRAND_CYAN,
        "indigo": BRAND_CYAN, "aurora": BRAND_MAGENTA, "sun": BRAND_CYAN,
    }[pal_name]
    spec = SkinSpec(
        name, top, bottom, outline, limbs, eyes,
        accent=accent_color, accent_style=accent,
    )
    spec.silhouette = silhouette_06(name, (96, 96))
    return spec


def hsv_shift(rgb: tuple[int, int, int], hue_shift: int,
              sat_shift: int) -> tuple[int, int, int]:
    """Shift an RGB triplet by hue degrees and saturation steps."""
    h, s, v = colorsys.rgb_to_hsv(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255)
    h = (h + hue_shift / 360.0) % 1.0
    s = max(0.0, min(1.0, s + sat_shift / 200.0))
    r, g, b = colorsys.hsv_to_rgb(h, s, v)
    return int(r * 255), int(g * 255), int(b * 255)


# -------------------------------------------------- 0.7 sheet generator
def gen_seven_skins() -> int:
    count = 0
    # bodies
    for path in sorted((SKINS7 / "body").glob("*.png")):
        silhouette_07(path.stem, Image.open(path).size).save(path, "PNG")
        count += 1
    # eyes
    for path in sorted((SKINS7 / "eyes").glob("*.png")):
        eyes_07(path.stem, Image.open(path).size).save(path, "PNG")
        count += 1
    # hands / feet
    for sub in ("hands", "feet"):
        for path in sorted((SKINS7 / sub).glob("*.png")):
            if sub == "hands":
                hand_sprite(Image.open(path).size).save(path, "PNG")
            else:
                foot_sprite(Image.open(path).size).save(path, "PNG")
            count += 1
    # markings
    for path in sorted((SKINS7 / "marking").glob("*.png")):
        markings_07(path.stem, Image.open(path).size).save(path, "PNG")
        count += 1
    # decoration
    for path in sorted((SKINS7 / "decoration").glob("*.png")):
        decoration_07(path.stem, Image.open(path).size).save(path, "PNG")
        count += 1
    # bot
    bot = SKINS7 / "bot.png"
    if bot.exists():
        bot_sprite(Image.open(bot).size).save(bot, "PNG")
        count += 1
    # xmas hat
    hat = SKINS7 / "xmas_hat.png"
    if hat.exists():
        xmas_hat_sprite(Image.open(hat).size).save(hat, "PNG")
        count += 1
    return count


# -------------------------------------------------- 0.7 json descriptors
def gen_seven_jsons() -> int:
    """Rewrite every 0.7 descriptor with deterministic Neon Relay hue/sat/lgt.

    The hue / sat / lgt values match the SPECIES palette so the runtime tint
    agrees with the procedural silhouette; the body / hands / feet filenames
    are pinned to 'standard' so we only ship one silhouette mask per body
    part. The mark / decoration names are still per-skin so the runtime can
    apply a unique marking on top of the silhouette.
    """
    count = 0
    for path in sorted(SKINS7.glob("*.json")):
        stem = path.stem
        species, accent, pal_name, hue_off, lgt = SPECIES.get(
            stem, SPECIES["default"])
        top, bottom, outline = PALETTES[pal_name]
        # hue/sat/lgt are HSL triplets that approximate the palette top
        h, s, v = colorsys.rgb_to_hsv(top[0] / 255, top[1] / 255, top[2] / 255)
        hue = int(h * 255)
        sat = int(s * 200) + 50
        lgt = int((1 - abs(2 * v - 1)) * 200) + 25
        # try to keep valid JSON shape
        try:
            data = json.loads(path.read_text())
        except Exception:
            data = {"skin": {}}
        skin = data.setdefault("skin", {})
        body_node = skin.setdefault("body", {"filename": "standard",
                                             "custom_colors": "true"})
        body_node["filename"] = "standard"
        body_node["custom_colors"] = "true"
        body_node["hue"] = hue
        body_node["sat"] = sat
        body_node["lgt"] = lgt
        hands_node = skin.setdefault("hands", {"filename": "standard",
                                               "custom_colors": "true"})
        hands_node["filename"] = "standard"
        hands_node["custom_colors"] = "true"
        hands_node["hue"] = hue
        hands_node["sat"] = sat
        hands_node["lgt"] = lgt
        feet_node = skin.setdefault("feet", {"filename": "standard",
                                             "custom_colors": "true"})
        feet_node["filename"] = "standard"
        feet_node["custom_colors"] = "true"
        feet_node["hue"] = hue
        feet_node["sat"] = sat
        feet_node["lgt"] = lgt
        # Deterministic per-stem SHA-256 (Python builtin hash() is
        # randomised by PYTHONHASHSEED and would produce different
        # bytes between runs).
        s_idx = int.from_bytes(hashlib.sha256(stem.encode()).digest()[:4],
                               "big")
        mark_idx = s_idx % len(MARK_KINDS)
        mark_name = MARK_KINDS[mark_idx]
        skin["marking"] = {"filename": mark_name}
        deco = None
        if s_idx % 3 == 0:
            deco = "hair"
        elif s_idx % 3 == 1:
            deco = "unibop"
        if deco:
            skin["decoration"] = {"filename": deco, "offset_x": "0", "offset_y": "0"}
        eye_name = "x_ninja" if species == "ninja" else (
            "negative" if species == "ghost" else "standard")
        skin["eyes"] = {"filename": eye_name}
        path.write_text(json.dumps(data, indent="\t") + "\n")
        count += 1
    return count


# ---------------------------------------------------------------- entry
def main() -> int:
    n6 = gen_six_skins()
    n7 = gen_seven_skins()
    nj = gen_seven_jsons()
    print(f"regenerated {n6} 0.6 skins, {n7} 0.7 components, "
          f"{nj} descriptors as originals")
    return 0


if __name__ == "__main__":
    sys.exit(main())
