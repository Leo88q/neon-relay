#!/usr/bin/env python3
"""Neon Relay original skin sweep (BL-15 3/3).

Replaces every remaining upstream skin file with procedural original art,
in place over the same filenames:

* data/skins/*.png (0.6 sheets, 256x128): deterministic SkinSpec per name
  (hue wheel + accent style from a name hash) via build_neon_skins.build_skin.
* data/skins7/** (0.7 component masks): bodies as original silhouette
  variants (ears/horns/antennae/wings per name), eye sets, hand/foot mitts,
  50 marking masks (stripes/triangles/circuits/spots/...), decoration props,
  plus the loose bot.png and xmas_hat.png.

Colorable components stay white-with-alpha so the runtime hue tint works;
eyes keep their own neon colors. Deterministic: same name -> same art.
"""
import colorsys
import hashlib
import math
import pathlib
import sys

from PIL import Image, ImageDraw, ImageFilter

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from build_neon_skins import SPECS, GHOST, build_skin  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
SKINS = ROOT / "data" / "skins"
SKINS7 = ROOT / "data" / "skins7"

WHITE = (255, 255, 255)
CYAN = (77, 227, 247)
MAGENTA = (255, 46, 136)
ICE = (216, 246, 255)
NIGHT = (10, 12, 24)


def rng_of(name):
	h = hashlib.sha256(name.encode()).digest()
	return int.from_bytes(h[:8], "big")


def hsv(h, s, v):
	r, g, b = colorsys.hsv_to_rgb((h % 360) / 360.0, s, v)
	return int(r * 255), int(g * 255), int(b * 255)


# ---------------------------------------------------------------- 0.6 sheets
def spec_for_name(name):
	r = rng_of(name)
	hue = r % 360
	hue2 = (hue + 120 + (r >> 16) % 120) % 360
	style = ["stripe", "grid", "circuit", "glitch", "band"][(r >> 8) % 5]
	from build_neon_skins import SkinSpec
	return SkinSpec(
		name,
		hsv(hue, 0.7, 0.95), hsv(hue, 0.85, 0.55),
		hsv(hue, 0.9, 0.16) + (235,),
		hsv(hue, 0.7, 0.75), hsv(hue2, 0.2, 0.98),
		accent=hsv(hue2, 0.85, 0.95), accent_style=style)


def gen_six_skins():
	done = {s.name for s in SPECS} | {GHOST.name}
	count = 0
	for path in sorted(SKINS.glob("*.png")):
		if path.stem in done:
			continue
		spec = spec_for_name(path.stem)
		build_skin(spec).save(path, "PNG")
		count += 1
	return count


# ------------------------------------------------------------ 0.7 components
def body_variant(name, size):
	img = Image.new("RGBA", size, (0, 0, 0, 0))
	d = ImageDraw.Draw(img)
	w, h = size
	cx, cy = w / 2, h * 0.58
	r = w * 0.27
	d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=WHITE + (255,))
	rr = rng_of("body:" + name)
	kind = rr % 6
	if kind == 0:  # pointy ears
		for s in (-1, 1):
			d.polygon([(cx + s * r * 0.55, cy - r * 0.75), (cx + s * r * 0.95, cy - r * 1.5),
				(cx + s * r * 0.15, cy - r * 0.95)], fill=WHITE + (255,))
	elif kind == 1:  # round ears
		for s in (-1, 1):
			d.ellipse([cx + s * r * 0.7 - r * 0.32, cy - r * 1.15,
				cx + s * r * 0.7 + r * 0.32, cy - r * 0.5], fill=WHITE + (255,))
	elif kind == 2:  # antenna
		d.line([(cx, cy - r), (cx, cy - r * 1.6)], fill=WHITE + (255,), width=max(2, w // 64))
		d.ellipse([cx - r * 0.18, cy - r * 1.8, cx + r * 0.18, cy - r * 1.44], fill=WHITE + (255,))
	elif kind == 3:  # horns
		for s in (-1, 1):
			d.polygon([(cx + s * r * 0.8, cy - r * 0.4), (cx + s * r * 1.35, cy - r * 1.1),
				(cx + s * r * 0.5, cy - r * 0.85)], fill=WHITE + (255,))
	elif kind == 4:  # spikes crest
		for i in range(-2, 3):
			x = cx + i * r * 0.35
			d.polygon([(x - r * 0.14, cy - r * 0.8), (x, cy - r * (1.35 - abs(i) * 0.12)),
				(x + r * 0.14, cy - r * 0.8)], fill=WHITE + (255,))
	else:  # wings
		for s in (-1, 1):
			d.polygon([(cx + s * r * 0.9, cy - r * 0.2), (cx + s * r * 1.6, cy - r * 0.7),
				(cx + s * r * 1.35, cy + r * 0.3), (cx + s * r * 0.85, cy + r * 0.4)],
				fill=WHITE + (255,))
	if name == "x_ninja":
		img = Image.new("RGBA", size, (0, 0, 0, 0))
		d = ImageDraw.Draw(img)
		d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=WHITE + (255,))
		d.polygon([(cx - r, cy - r * 0.2), (cx - r * 1.7, cy), (cx - r, cy + r * 0.25)],
			fill=WHITE + (255,))
		d.polygon([(cx + r, cy - r * 0.2), (cx + r * 1.7, cy), (cx + r, cy + r * 0.25)],
			fill=WHITE + (255,))
	return img


def eyes_variant(name, size):
	img = Image.new("RGBA", size, (0, 0, 0, 0))
	d = ImageDraw.Draw(img)
	w, h = size
	for s in (-1, 1):
		cx = w / 2 + s * w * 0.16
		cy = h / 2
		if name == "negative":
			d.ellipse([cx - w * 0.11, cy - h * 0.2, cx + w * 0.11, cy + h * 0.2],
				fill=NIGHT + (255,))
			d.ellipse([cx - w * 0.04, cy - h * 0.09, cx + w * 0.04, cy + h * 0.09],
				fill=ICE + (255,))
		elif name == "x_ninja":
			d.line([(cx - w * 0.1, cy), (cx + w * 0.1, cy)], fill=MAGENTA + (255,),
				width=max(2, h // 32))
		elif name == "colorable":
			d.ellipse([cx - w * 0.11, cy - h * 0.2, cx + w * 0.11, cy + h * 0.2],
				fill=WHITE + (255,))
		else:
			d.ellipse([cx - w * 0.11, cy - h * 0.2, cx + w * 0.11, cy + h * 0.2],
				fill=WHITE + (255,))
			d.ellipse([cx - w * 0.045, cy - h * 0.1, cx + w * 0.045, cy + h * 0.1],
				fill=NIGHT + (255,))
			if name == "standardreal":
				d.ellipse([cx - w * 0.02, cy - h * 0.08, cx + w * 0.01, cy - h * 0.03],
					fill=ICE + (255,))
	return img


def mitt(size, foot):
	img = Image.new("RGBA", size, (0, 0, 0, 0))
	d = ImageDraw.Draw(img)
	w, h = size
	if foot:
		d.ellipse([w * 0.15, h * 0.35, w * 0.85, h * 0.8], fill=WHITE + (255,))
	else:
		d.ellipse([w * 0.25, h * 0.25, w * 0.75, h * 0.75], fill=WHITE + (255,))
	return img


def marking(idx, name, size):
	img = Image.new("RGBA", size, (0, 0, 0, 0))
	d = ImageDraw.Draw(img)
	w, h = size
	r = rng_of("mark:" + name)
	kind = (r % 10) if not name.startswith(("stripe", "tri", "belly", "cammo", "warpaint",
		"whisker", "yinyang", "thunder", "blush")) else r % 10
	kind = (kind + idx) % 10
	a = 235
	if kind == 0:  # vertical stripes
		for x in range(int(w * 0.2), int(w * 0.8), int(w * 0.12)):
			d.rectangle([x, h * 0.2, x + w * 0.05, h * 0.8], fill=WHITE + (a,))
	elif kind == 1:  # diagonal stripes
		for i in range(6):
			x = w * 0.15 + i * w * 0.12
			d.line([(x, h * 0.8), (x + w * 0.2, h * 0.2)], fill=WHITE + (a,), width=max(2, w // 32))
	elif kind == 2:  # belly patch
		d.ellipse([w * 0.3, h * 0.35, w * 0.7, h * 0.8], fill=WHITE + (a,))
	elif kind == 3:  # triangle crest
		d.polygon([(w * 0.5, h * 0.15), (w * 0.72, h * 0.5), (w * 0.28, h * 0.5)], fill=WHITE + (a,))
	elif kind == 4:  # circuit
		for i in range(4):
			y = h * (0.25 + 0.15 * i)
			d.line([(w * 0.25, y), (w * (0.5 + 0.06 * (i % 3)), y)], fill=WHITE + (a,), width=max(2, w // 48))
			d.ellipse([w * (0.5 + 0.06 * (i % 3)) - 3, y - 3, w * (0.5 + 0.06 * (i % 3)) + 3, y + 3],
				fill=WHITE + (a,))
	elif kind == 5:  # spots
		for i in range(7):
			x = w * (0.2 + 0.1 * ((r >> (i * 3)) % 6))
			y = h * (0.2 + 0.1 * ((r >> (i * 2)) % 6))
			d.ellipse([x, y, x + w * 0.08, y + w * 0.08], fill=WHITE + (a,))
	elif kind == 6:  # cross
		d.rectangle([w * 0.45, h * 0.2, w * 0.55, h * 0.8], fill=WHITE + (a,))
		d.rectangle([w * 0.25, h * 0.45, w * 0.75, h * 0.55], fill=WHITE + (a,))
	elif kind == 7:  # whiskers
		for s in (-1, 1):
			for i in range(3):
				d.line([(w / 2, h / 2), (w / 2 + s * w * 0.4, h * (0.35 + 0.15 * i))],
					fill=WHITE + (a,), width=max(2, w // 48))
	elif kind == 8:  # bolt
		d.polygon([(w * 0.55, h * 0.15), (w * 0.4, h * 0.5), (w * 0.52, h * 0.5),
			(w * 0.42, h * 0.85), (w * 0.62, h * 0.45), (w * 0.5, h * 0.45)], fill=WHITE + (a,))
	else:  # ring
		d.ellipse([w * 0.3, h * 0.3, w * 0.7, h * 0.7], outline=WHITE + (a,), width=max(3, w // 24))
	return img


def decoration(name, size):
	img = Image.new("RGBA", size, (0, 0, 0, 0))
	d = ImageDraw.Draw(img)
	w, h = size
	if "bop" in name:
		for s in (-1, 1):
			x = w / 2 + s * w * 0.18
			d.line([(x, h * 0.8), (x, h * 0.3)], fill=WHITE + (255,), width=max(2, w // 64))
			d.ellipse([x - w * 0.07, h * 0.16, x + w * 0.07, h * 0.34], fill=WHITE + (255,))
	elif "melo" in name:
		for s in (-1, 1):
			d.ellipse([w / 2 + s * w * 0.2 - w * 0.09, h * 0.2,
				w / 2 + s * w * 0.2 + w * 0.09, h * 0.75], fill=WHITE + (255,))
	elif "pen" in name:
		for s in (-1, 1):
			d.polygon([(w / 2 + s * w * 0.15, h * 0.8), (w / 2 + s * w * 0.28, h * 0.2),
				(w / 2 + s * w * 0.08, h * 0.3)], fill=WHITE + (255,))
	else:  # hair
		for i in range(5):
			x = w * (0.3 + 0.1 * i)
			d.polygon([(x, h * 0.7), (x + w * 0.05, h * 0.25), (x + w * 0.1, h * 0.7)],
				fill=WHITE + (255,))
	return img


def bot_skin(size):
	img = Image.new("RGBA", size, (0, 0, 0, 0))
	d = ImageDraw.Draw(img)
	w, h = size
	cx, cy, r = w / 2, h * 0.58, w * 0.26
	d.rounded_rectangle([cx - r, cy - r, cx + r, cy + r], r * 0.4, fill=(52, 60, 84, 255))
	d.rounded_rectangle([cx - r * 0.55, cy - r * 0.4, cx + r * 0.55, cy + r * 0.1],
		r * 0.15, fill=(16, 20, 34, 255))
	d.ellipse([cx - r * 0.4, cy - r * 0.3, cx - r * 0.15, cy - r * 0.05], fill=CYAN + (255,))
	d.ellipse([cx + r * 0.15, cy - r * 0.3, cx + r * 0.4, cy - r * 0.05], fill=CYAN + (255,))
	d.line([(cx, cy - r), (cx, cy - r * 1.5)], fill=(126, 140, 172, 255), width=max(2, w // 64))
	d.ellipse([cx - r * 0.12, cy - r * 1.7, cx + r * 0.12, cy - r * 1.46], fill=MAGENTA + (255,))
	d.rectangle([cx - r * 0.5, cy + r * 0.35, cx + r * 0.5, cy + r * 0.5], fill=MAGENTA + (200,))
	return img


def xmas_hat(size):
	img = Image.new("RGBA", size, (0, 0, 0, 0))
	d = ImageDraw.Draw(img)
	w, h = size
	d.polygon([(w * 0.2, h * 0.75), (w * 0.5, h * 0.15), (w * 0.78, h * 0.6)],
		fill=MAGENTA + (255,))
	d.rounded_rectangle([w * 0.14, h * 0.68, w * 0.86, h * 0.86], h * 0.08, fill=ICE + (255,))
	d.ellipse([w * 0.44, h * 0.06, w * 0.62, h * 0.24], fill=ICE + (255,))
	return img


def gen_seven_skins():
	count = 0
	for path in sorted((SKINS7 / "body").glob("*.png")):
		body_variant(path.stem, Image.open(path).size).save(path, "PNG")
		count += 1
	for path in sorted((SKINS7 / "eyes").glob("*.png")):
		eyes_variant(path.stem, Image.open(path).size).save(path, "PNG")
		count += 1
	for sub, foot in (("hands", False), ("feet", True)):
		for path in sorted((SKINS7 / sub).glob("*.png")):
			mitt(Image.open(path).size, foot).save(path, "PNG")
			count += 1
	for i, path in enumerate(sorted((SKINS7 / "marking").glob("*.png"))):
		marking(i, path.stem, Image.open(path).size).save(path, "PNG")
		count += 1
	for path in sorted((SKINS7 / "decoration").glob("*.png")):
		decoration(path.stem, Image.open(path).size).save(path, "PNG")
		count += 1
	bot = SKINS7 / "bot.png"
	if bot.exists():
		bot_skin(Image.open(bot).size).save(bot, "PNG")
		count += 1
	hat = SKINS7 / "xmas_hat.png"
	if hat.exists():
		xmas_hat(Image.open(hat).size).save(hat, "PNG")
		count += 1
	return count



def gen_seven_jsons():
	"""Rewrite 0.7 skin descriptors with our own deterministic color params."""
	import json
	count = 0
	for path in sorted(SKINS7.glob("*.json")):
		r = rng_of("json:" + path.stem)
		try:
			data = json.loads(path.read_text())
		except Exception:
			continue
		for part in ("body", "hands", "feet"):
			node = data.get("skin", {}).get(part)
			if isinstance(node, dict) and node.get("custom_colors") == "true":
				node["hue"] = (r >> (4 * count % 24)) % 256
				node["sat"] = 120 + (r >> 8) % 80
				node["lgt"] = 90 + (r >> 16) % 100
		path.write_text(json.dumps(data, indent="\t") + "\n")
		count += 1
	return count


def main():
	n6 = gen_six_skins()
	n7 = gen_seven_skins()
	nj = gen_seven_jsons()
	print(f"regenerated {n6} 0.6 skins, {n7} 0.7 components, {nj} descriptors as originals")
	return 0


if __name__ == "__main__":
	raise SystemExit(main())
