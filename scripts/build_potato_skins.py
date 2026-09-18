#!/usr/bin/env python3
"""cool_guy_1 uses the articulated prototype in build_potato_animated.py.
All other skins retain this legacy layout pending user playtest approval.

Potato v2 mascots: matte the black-backdrop generations, store 512x512
sources + the 1280x512 collage, and bake DDNet-compatible 256x128 skin sheets.

Skin sheet layout (tee grid 8x4 -> 32px cells, see datasrc/content.py):
    body          (0, 0, 96, 96)      80px potato centered at (8,8)
    body_outline  (96, 0, 96, 96)     2px dilated white silhouette (outline pass)
    hands/hands_outline/feet/feet_outline  transparent (limbless mascots)
    eyes row y=96 transparent (face is painted on the body, no double eyes)
Metrics are measured by the engine from alpha. In-game positioning and the
absence of separately animated limbs still require visual playtesting.
"""

import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_potato_animated import build_sheet
from build_potato_weapon_sheet import contain, prepare_source  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets-src" / "potato" / "v2"
SKINS = ROOT / "data" / "skins"

POTATOES = [
    "cool_guy_1", "cool_girl_1", "guy_2", "girl_2", "guy_3",
    "girl_3", "guy_4", "girl_4", "legend_guy", "legend_girl",
]
BODY_PX = 80  # inside the 96x96 body cell -> 8px margin
def dilate_alpha(mask: np.ndarray, iters: int) -> np.ndarray:
    out = mask.copy()
    for _ in range(iters):
        nxt = out.copy()
        for ax in (0, 1):
            nxt |= np.roll(out, 1, axis=ax)
            nxt |= np.roll(out, -1, axis=ax)
        out = nxt
    return out


def main() -> int:
    SRC.mkdir(parents=True, exist_ok=True)
    SKINS.mkdir(parents=True, exist_ok=True)
    sources = {name: prepare_source(SRC / f"{name}.png", 512, 480) for name in POTATOES}

    coll = Image.new("RGBA", (1280, 512), (0, 0, 0, 0))
    for i, name in enumerate(POTATOES):
        cell = sources[name].resize((256, 256), Image.LANCZOS)
        coll.paste(cell, ((i % 5) * 256, (i // 5) * 256))
    coll.save(SRC / "potato_v2_all_10.png")
    print(f"[collage] {SRC / 'potato_v2_all_10.png'} 1280x512")

    for name in POTATOES:
        if name == "cool_guy_1":
            build_sheet().save(SKINS / "potato_cool_guy_1.png")
            print("[skin] potato_cool_guy_1.png: articulated prototype, separate limbs/eyes")
            continue
        art = sources[name].crop(sources[name].getchannel("A").getbbox())
        body = contain(art, (BODY_PX, BODY_PX))
        sheet = Image.new("RGBA", (256, 128), (0, 0, 0, 0))
        bx, by = 8 + (BODY_PX - body.width) // 2, 8 + (BODY_PX - body.height) // 2
        sheet.paste(body, (bx, by))
        # Outline pass: dilated silhouette in the outline cell
        cell_alpha = np.asarray(sheet.getchannel("A"), dtype=np.uint8)[0:96, 0:96] > 0
        outline = dilate_alpha(cell_alpha, 2)
        ol = np.zeros((96, 96, 4), dtype=np.uint8)
        ol[..., 0:3] = 255
        ol[..., 3] = outline * 255
        sheet.paste(Image.fromarray(ol, "RGBA"), (96, 0), Image.fromarray(ol, "RGBA"))
        sheet.save(SKINS / f"potato_{name}.png")
        a = np.asarray(sheet.getchannel("A"))
        ys, xs = np.nonzero(a[0:96, 0:96])
        print(f"[skin] potato_{name}.png body bbox {xs.max()-xs.min()+1}x{ys.max()-ys.min()+1} "
              f"at ({xs.min()},{ys.min()}) <= 96x96 cell")
    return 0


if __name__ == "__main__":
    sys.exit(main())
