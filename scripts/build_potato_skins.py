#!/usr/bin/env python3
"""Build ten articulated classic skin sheets via build_potato_animated.py.
Keep v2 portrait sources and their collage unchanged as historical references.
Live sheets contain separate body, dark outline, hand, feet and six eye states.
"""

import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_potato_animated import build_sheet
from build_potato_weapon_sheet import prepare_source  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets-src" / "potato" / "v2"
SKINS = ROOT / "data" / "skins"

POTATOES = [
    "cool_guy_1", "cool_girl_1", "guy_2", "girl_2", "guy_3",
    "girl_3", "guy_4", "girl_4", "legend_guy", "legend_girl",
]
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

    authoring = ROOT / "assets-src/potato/articulated"
    authoring.mkdir(parents=True, exist_ok=True)
    for name in POTATOES:
        build_sheet(name, high_resolution=True).save(authoring / f"{name}.png")
        build_sheet(name).save(SKINS / f"potato_{name}.png")
        print(f"[skin] potato_{name}.png: separate body/limbs/eyes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
