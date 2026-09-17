#!/usr/bin/env python3
"""Neon Relay Night Drive pass over vendored map tilesets (stage 19).

Recolors the mapres tilesets/backgrounds referenced by the shipped maps so the
in-game terrain matches docs/DESIGN_SYNTHWAVE.md (concept B): dark night slabs,
cyan top edges, pink hazards, indigo glass. Shapes and autotile borders are
preserved pixel-exactly; only the palette is transformed, so gameplay reading
of tiles never changes.

NOTE (compliance): these files remain `block-release` in docs/ASSET_MANIFEST.csv
— the remap keeps upstream line work, so a commercial release still waits for
original maps (BL-14). This pass is the dev/preview look plus the color language
that the original tilesets will reuse.

Categories by name:
  tile   : terrain sheets — hue remap + 128px slab seams + cyan top edges
  bg     : clouds/skies/doodads — dark silhouettes with cyan rims
  freeze : ice tiles — neon cyan/indigo
  sun    : sun discs — outrun striped-sun gradient (accent A)
"""
import pathlib
import sys

from PIL import Image, ImageFilter

ROOT = pathlib.Path(__file__).resolve().parent.parent
MAPRES = ROOT / "data" / "mapres"

NIGHT0 = (5, 6, 14)
NIGHT1 = (10, 14, 30)
NIGHT2 = (16, 26, 48)
CYAN = (77, 227, 247)
PINK = (255, 46, 136)
INDIGO = (108, 96, 255)
ICE = (216, 246, 255)
DIM = (96, 116, 148)
SUN_TOP = (255, 95, 109)
SUN_BOTTOM = (255, 176, 32)

TILE_FILES = [
	"desert_main.png", "ddnet_tiles.png", "round_tiles.png", "snow.png",
	"jungle_unhookables.png", "generic_unhookable.png",
]
BG_FILES = [
	"bg_cloud1.png", "bg_cloud2.png", "bg_cloud3.png", "desert_doodads.png",
	"jungle_midground.png", "grass_doodads.png", "stars.png",
]
FREEZE_FILES = ["basic_freeze.png"]
EXTRA_BG_FILES = [
	"desert_background.png", "desert_mountains.png", "desert_mountains2.png",
	"desert_mountains_new_background.png", "desert_mountains_new_foreground.png",
	"mountains.png", "jungle_background.png", "snow_mountain.png",
	"winter_mountains.png", "winter_mountains2.png", "winter_mountains3.png",
	"water.png",
]
SUN_FILES = ["sun.png", "desert_sun.png"]
MOON_FILES = ["moon.png"]
SUN_FILES = []  # no shipped mapres sun discs; embedded ones wait for BL-14


def rgb_to_hsv(r, g, b):
	mx = max(r, g, b) / 255.0
	mn = min(r, g, b) / 255.0
	d = mx - mn
	v = mx
	s = 0.0 if mx == 0 else d / mx
	if d == 0:
		h = 0.0
	elif mx == r / 255.0:
		h = (60 * ((g - b) / 255.0 / d) + 360) % 360
	elif mx == g / 255.0:
		h = (60 * ((b - r) / 255.0 / d) + 120) % 360
	else:
		h = (60 * ((r - g) / 255.0 / d) + 240) % 360
	return h, s, v


def lerp3(a, b, t):
	t = min(1.0, max(0.0, t))
	return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def remap_tile_pixel(r, g, b):
	h, s, v = rgb_to_hsv(r, g, b)
	if s < 0.16:  # greys/whites: slab shades + ice highlights
		if v > 0.82:
			return lerp3(CYAN, ICE, 0.6)
		return lerp3(NIGHT1, DIM, v * 0.8)
	if 60 <= h <= 190:  # greens & cyans: safe neon cyan
		return lerp3((20, 90, 110), CYAN, v)
	if 15 <= h < 60:  # browns/tans: night slabs
		return lerp3(NIGHT0, NIGHT2, v)
	if h < 15 or h > 300:  # reds/magentas: danger pink
		return lerp3((90, 10, 40), PINK, v)
	return lerp3(NIGHT1, INDIGO, v)  # blues: indigo glass


def remap_bg_pixel(r, g, b):
	_, _, v = rgb_to_hsv(r, g, b)
	return lerp3(NIGHT2, DIM, v * 0.9)


def remap_sun_pixel(r, g, b, y, h):
	t = y / max(1, h - 1)
	base = lerp3(SUN_TOP, SUN_BOTTOM, t)
	# horizontal cut stripes widening downwards (accent A)
	stripe = int(t * 14)
	if stripe % 2 == 1 and (y % max(2, int(2 + t * 10))) < max(1, int(1 + t * 6)):
		return (0, 0, 0)
	return base


def remap_moon_pixel(r, g, b):
	_, _, v = rgb_to_hsv(r, g, b)
	return lerp3((140, 200, 220), ICE, v)


def remap_freeze_pixel(r, g, b):
	h, s, v = rgb_to_hsv(r, g, b)
	if s < 0.16 and v > 0.8:
		return ICE
	if s < 0.16:
		return lerp3(NIGHT1, DIM, v)
	if 150 <= h <= 260:
		return lerp3((16, 40, 90), CYAN, v)
	return lerp3(NIGHT1, INDIGO, v)


def process(name, kind):
	path = MAPRES / name
	img = Image.open(path).convert("RGBA")
	w, h = img.size
	px = img.load()
	fn = {"tile": remap_tile_pixel, "bg": remap_bg_pixel,
		"freeze": remap_freeze_pixel, "moon": remap_moon_pixel}[kind]
	for y in range(h):
		for x in range(w):
			r, g, b, a = px[x, y]
			if a == 0:
				continue
			if kind == "sun":
				r2, g2, b2 = remap_sun_pixel(r, g, b, y, h)
			else:
				r2, g2, b2 = fn(r, g, b)
			px[x, y] = (r2, g2, b2, a)
	if kind == "tile":
		# slab seams on the 128px grid + cyan light on exposed top edges
		if w % 128 == 0 and h % 128 == 0:
			for cy in range(0, h, 128):
				for cx in range(0, w, 128):
					for x in range(cx, min(cx + 128, w)):
						top = None
						for y in range(cy, min(cy + 128, h)):
							if px[x, y][3] > 100:
								top = y
								break
						if top is None:
							continue
						px[x, top] = CYAN + (235,)
						if top + 1 < h and px[x, top + 1][3] > 100:
							px[x, top + 1] = lerp3(CYAN, NIGHT2, 0.45) + (235,)
					for y in range(cy, min(cy + 128, h)):
						for x in (cx, cx + 127):
							if x < w and px[x, y][3] > 100:
								r, g, b, a = px[x, y]
								px[x, y] = (r * 45 // 100, g * 45 // 100, b * 45 // 100, a)
			for cy in range(0, h, 128):
				for y in (cy,):
					for x in range(w):
						if px[x, y][3] > 100:
							r, g, b, a = px[x, y]
							px[x, y] = (r * 45 // 100, g * 45 // 100, b * 45 // 100, a)
	if kind == "bg":
		# cyan rim light around silhouettes
		from PIL import ImageChops
		alpha = img.getchannel("A")
		binm = alpha.point(lambda v: 255 if v > 0 else 0)
		eroded = alpha.filter(ImageFilter.MinFilter(5)).point(lambda v: 255 if v > 0 else 0)
		rim = ImageChops.subtract(binm, eroded)
		rpx = rim.load()
		for y in range(h):
			for x in range(w):
				if rpx[x, y] > 0 and px[x, y][3] > 0:
					px[x, y] = CYAN + (200,)
	img.save(path)
	print(f"  remapped {name} ({kind}, {w}x{h})")


def main():
	for n in TILE_FILES:
		process(n, "tile")
	for n in BG_FILES:
		process(n, "bg")
	for n in FREEZE_FILES:
		process(n, "freeze")
	for n in EXTRA_BG_FILES:
		process(n, "bg")
	for n in SUN_FILES:
		process(n, "sun")
	for n in MOON_FILES:
		process(n, "moon")
	print("stage 19 mapres pass done")
	return 0


if __name__ == "__main__":
	sys.exit(main())
