#!/usr/bin/env python3
"""Neon Relay original tileset generator (BL-14, style A+B).

Draws from scratch the terrain tileset used by the original Neon Relay maps:
concept A neon density (magenta edge light, glow, inner circuit grid) on the
concept B night base (readability: dark slabs, cyan = hookable/safe extras,
pink = lethal). No upstream pixels, no recolors — every cell is procedural.

Sheet layout (1024x1024, 16x16 grid of 64px final cells — the renderer's
TexSize assumption): cell index == logical tile id from
src/game/mapitems.h (the renderer draws cell == stored index), so the art
sits at enum positions:
  1  TILE_SOLID slab (hookable ground, magenta neon top)
  2  TILE_DEATH spikes
  3  TILE_NOHOOK slab
  9  TILE_FREEZE crystal
  26 TILE_TELEIN pad (magenta portal)
  27 TILE_TELEOUT pad (cyan portal)
  33 TILE_START gate
  34 TILE_FINISH flag
  35 TILE_TIME_CHECKPOINT_FIRST gem
  16..31 spare border-combination variants (mask = idx-16) for editors
  60..62 stop tiles reuse nohook/solid art family
Everything is 2x supersampled and LANCZOS-downscaled.
"""
import math
import pathlib
import random
import sys

from PIL import Image, ImageDraw, ImageFilter

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "mapres" / "neonrelay_tiles.png"

SS = 2
CELL = 128

NIGHT0 = (5, 6, 14)
NIGHT1 = (10, 14, 30)
NIGHT2 = (16, 26, 48)
MAGENTA = (255, 46, 136)
CYAN = (77, 227, 247)
INDIGO = (108, 96, 255)
ICE = (216, 246, 255)
DIM = (96, 116, 148)
SUN_TOP = (255, 95, 109)
SUN_BOTTOM = (255, 176, 32)

rng = random.Random(20260917)


def lerp3(a, b, t):
	t = min(1.0, max(0.0, t))
	return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def cell_canvas():
	return Image.new("RGBA", (CELL * SS, CELL * SS), (0, 0, 0, 0))


def slab_base(img, inset=0):
	"""Night slab fill with faint inner circuit grid + value noise."""
	d = ImageDraw.Draw(img)
	s = CELL * SS
	d.rectangle([inset, inset, s - inset, s - inset], fill=NIGHT1 + (255,))
	# vertical shade gradient (top lighter)
	for y in range(s):
		t = y / s
		c = lerp3(NIGHT2, NIGHT0, t)
		d.line([(0, y), (s, y)], fill=c + (255,))
	# inner circuit grid
	step = 16 * SS
	for x in range(0, s, step):
		d.line([(x, 0), (x, s)], fill=(34, 24, 58, 110), width=SS)
	for y in range(0, s, step):
		d.line([(0, y), (s, y)], fill=(34, 24, 58, 110), width=SS)
	# scanlines + corner vignette for depth
	for y in range(0, s, 7 * SS):
		d.line([(0, y), (s, y)], fill=(0, 0, 0, 10), width=SS)
	vig = Image.new("L", (s, s), 0)
	vd = ImageDraw.Draw(vig)
	vd.ellipse([-s // 2, -s // 2, s + s // 2, s + s // 2], fill=255)
	vig = vig.filter(ImageFilter.GaussianBlur(s // 6))
	dark = Image.new("RGBA", (s, s), NIGHT0 + (120,))
	img.paste(Image.composite(dark, Image.new("RGBA", (s, s), (0, 0, 0, 0)), vig.point(lambda v: 255 - v)), (0, 0),
		Image.composite(dark, Image.new("RGBA", (s, s), (0, 0, 0, 0)), vig.point(lambda v: 255 - v)).getchannel("A"))
	d = ImageDraw.Draw(img)
	# sparse neon solder dots
	for _ in range(6):
		x = rng.randrange(4, s - 4)
		y = rng.randrange(4, s - 4)
		c = MAGENTA if rng.random() < 0.5 else CYAN
		d.ellipse([x - SS, y - SS, x + SS, y + SS], fill=c + (70,))


def neon_edge(img, side, color, width=3, glow=10):
	"""Bright neon line with outer glow along one side of the cell."""
	s = CELL * SS
	w = width * SS
	g = glow * SS
	glow_layer = Image.new("RGBA", (s, s), (0, 0, 0, 0))
	gd = ImageDraw.Draw(glow_layer)
	if side == "top":
		gd.rectangle([0, 0, s, w + g], fill=color + (255,))
	elif side == "bottom":
		gd.rectangle([0, s - w - g, s, s], fill=color + (255,))
	elif side == "left":
		gd.rectangle([0, 0, w + g, s], fill=color + (255,))
	else:
		gd.rectangle([s - w - g, 0, s, s], fill=color + (255,))
	glow_layer = glow_layer.filter(ImageFilter.GaussianBlur(g / 2))
	# keep glow only outside-ish: composite then draw crisp line
	out = Image.alpha_composite(img, glow_layer)
	d = ImageDraw.Draw(out)
	if side == "top":
		d.rectangle([0, 0, s, w], fill=color + (255,))
		d.line([(0, w), (s, w)], fill=ICE + (160,), width=SS)
	elif side == "bottom":
		d.rectangle([0, s - w, s, s], fill=color + (255,))
		d.line([(0, s - w), (s, s - w)], fill=ICE + (160,), width=SS)
	elif side == "left":
		d.rectangle([0, 0, w, s], fill=color + (255,))
		d.line([(w, 0), (w, s)], fill=ICE + (160,), width=SS)
	else:
		d.rectangle([s - w, 0, s, s], fill=color + (255,))
		d.line([(s - w, 0), (s - w, s)], fill=ICE + (160,), width=SS)
	return out


def rounded_mask(size, radius):
	m = Image.new("L", (size, size), 0)
	d = ImageDraw.Draw(m)
	d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
	return m


def build_solid():
	img = cell_canvas()
	slab_base(img)
	img = neon_edge(img, "top", MAGENTA)
	return img


def build_border(mask):
	"""mask bits: 1 top, 2 right, 4 bottom, 8 left exposed."""
	img = cell_canvas()
	s = CELL * SS
	slab_base(img)
	# round the exposed corners (correct pie quadrants per corner)
	r = 26 * SS
	m = Image.new("L", (s, s), 255)
	md = ImageDraw.Draw(m)
	corner = {
		(1, 8): ((0, 0), 180, 270),
		(1, 2): ((s - r, 0), 270, 360),
		(4, 2): ((s - r, s - r), 0, 90),
		(4, 8): ((0, s - r), 90, 180),
	}
	for (a, b), ((cx, cy), a0, a1) in corner.items():
		if mask & a and mask & b:
			md.pieslice([cx, cy, cx + r, cy + r], a0, a1, fill=0)
	img.putalpha(Image.composite(img.getchannel("A"), Image.new("L", (s, s), 0), m))
	d = ImageDraw.Draw(img)
	if mask & 1:
		img = neon_edge(img, "top", MAGENTA)
		d = ImageDraw.Draw(img)
		for cx in (3 * SS, s - 3 * SS):
			d.ellipse([cx - 2 * SS, 1 * SS, cx + 2 * SS, 5 * SS], fill=ICE + (255,))
	if mask & 4:
		img = neon_edge(img, "bottom", MAGENTA, width=2, glow=6)
	if mask & 8:
		img = neon_edge(img, "left", MAGENTA, width=2, glow=6)
	if mask & 2:
		img = neon_edge(img, "right", MAGENTA, width=2, glow=6)
	if mask == 0:
		img = neon_edge(img, "top", MAGENTA, width=1, glow=0)
	return img


def build_death():
	img = cell_canvas()
	d = ImageDraw.Draw(img)
	s = CELL * SS
	# glow bed
	bed = Image.new("RGBA", (s, s), (0, 0, 0, 0))
	bd = ImageDraw.Draw(bed)
	bd.rectangle([0, s - 26 * SS, s, s], fill=MAGENTA + (255,))
	bed = bed.filter(ImageFilter.GaussianBlur(8 * SS))
	img = Image.alpha_composite(img, bed)
	d = ImageDraw.Draw(img)
	d.rectangle([0, s - 14 * SS, s, s], fill=lerp3(MAGENTA, NIGHT0, 0.35) + (255,))
	n = 4
	w = s // n
	for i in range(n):
		x0 = i * w
		pts = [(x0 + 2 * SS, s - 12 * SS), (x0 + w // 2, 10 * SS), (x0 + w - 2 * SS, s - 12 * SS)]
		d.polygon(pts, fill=MAGENTA + (255,))
		d.polygon([(x0 + w // 2 - 3 * SS, s - 14 * SS), (x0 + w // 2, 22 * SS), (x0 + w // 2 + 3 * SS, s - 14 * SS)], fill=lerp3(MAGENTA, ICE, 0.55) + (255,))
	return img


def build_death_solid():
	img = build_solid()
	d = ImageDraw.Draw(img)
	s = CELL * SS
	for i in range(4):
		x = i * 32 * SS + 8 * SS
		d.polygon([(x, s - 6 * SS), (x + 8 * SS, 26 * SS), (x + 16 * SS, s - 6 * SS)], fill=MAGENTA + (220,))
	return img


def build_nohook():
	img = cell_canvas()
	slab_base(img)
	d = ImageDraw.Draw(img)
	s = CELL * SS
	step = 24 * SS
	for i in range(-s, s, step):
		d.line([(i, s), (i + s, 0)], fill=(60, 24, 50, 150), width=3 * SS)
	img = neon_edge(img, "top", DIM, width=2, glow=4)
	d = ImageDraw.Draw(img)
	c = s // 2
	d.ellipse([c - 26 * SS, c - 26 * SS, c + 26 * SS, c + 26 * SS], outline=MAGENTA + (170,), width=3 * SS)
	d.line([(c - 18 * SS, c + 18 * SS), (c + 18 * SS, c - 18 * SS)], fill=MAGENTA + (170,), width=3 * SS)
	return img


def build_start():
	img = cell_canvas()
	d = ImageDraw.Draw(img)
	s = CELL * SS
	glow = Image.new("RGBA", (s, s), (0, 0, 0, 0))
	gd = ImageDraw.Draw(glow)
	gd.ellipse([s * 0.2, s * 0.2, s * 0.8, s * 0.8], fill=SUN_BOTTOM + (255,))
	glow = glow.filter(ImageFilter.GaussianBlur(10 * SS))
	img = Image.alpha_composite(img, glow)
	d = ImageDraw.Draw(img)
	# chrome gate posts + sun disc
	d.rectangle([s * 0.18, s * 0.25, s * 0.26, s * 0.9], fill=lerp3(ICE, DIM, 0.3) + (255,))
	d.rectangle([s * 0.74, s * 0.25, s * 0.82, s * 0.9], fill=lerp3(ICE, DIM, 0.3) + (255,))
	d.ellipse([s * 0.32, s * 0.3, s * 0.68, s * 0.66], fill=SUN_TOP + (255,))
	d.rectangle([s * 0.32, s * 0.5, s * 0.68, s * 0.54], fill=NIGHT0 + (255,))
	d.polygon([(s * 0.42, s * 0.72), (s * 0.62, s * 0.78), (s * 0.42, s * 0.86)], fill=CYAN + (255,))
	return img


def build_finish():
	img = cell_canvas()
	d = ImageDraw.Draw(img)
	s = CELL * SS
	glow = Image.new("RGBA", (s, s), (0, 0, 0, 0))
	gd = ImageDraw.Draw(glow)
	gd.rectangle([s * 0.15, s * 0.2, s * 0.85, s * 0.8], fill=CYAN + (255,))
	glow = glow.filter(ImageFilter.GaussianBlur(10 * SS))
	img = Image.alpha_composite(img, glow)
	d = ImageDraw.Draw(img)
	n = 6
	w = int(s * 0.7) // n
	for ry in range(4):
		for rx in range(n):
			c = ICE if (rx + ry) % 2 == 0 else NIGHT0
			d.rectangle([s * 0.15 + rx * w, s * 0.22 + ry * 10 * SS, s * 0.15 + (rx + 1) * w, s * 0.22 + (ry + 1) * 10 * SS], fill=c + (255,))
	d.rectangle([s * 0.13, s * 0.18, s * 0.17, s * 0.92], fill=lerp3(ICE, DIM, 0.2) + (255,))
	return img


def build_checkpoint():
	img = cell_canvas()
	s = CELL * SS
	glow = Image.new("RGBA", (s, s), (0, 0, 0, 0))
	gd = ImageDraw.Draw(glow)
	gd.polygon([(s / 2, s * 0.15), (s * 0.8, s / 2), (s / 2, s * 0.85), (s * 0.2, s / 2)], fill=CYAN + (255,))
	glow = glow.filter(ImageFilter.GaussianBlur(9 * SS))
	img = Image.alpha_composite(img, glow)
	d = ImageDraw.Draw(img)
	d.polygon([(s / 2, s * 0.22), (s * 0.72, s / 2), (s / 2, s * 0.78), (s * 0.28, s / 2)], fill=lerp3(CYAN, NIGHT1, 0.25) + (255,), outline=ICE + (255,))
	d.polygon([(s / 2, s * 0.36), (s * 0.6, s / 2), (s / 2, s * 0.64), (s * 0.4, s / 2)], fill=ICE + (235,))
	return img


def build_freeze():
	img = cell_canvas()
	d = ImageDraw.Draw(img)
	s = CELL * SS
	d.rounded_rectangle([s * 0.12, s * 0.12, s * 0.88, s * 0.88], radius=18 * SS, fill=lerp3(INDIGO, NIGHT1, 0.45) + (235,), outline=CYAN + (200,))
	for i in range(3):
		x = s * (0.3 + 0.2 * i)
		d.line([(x, s * 0.25), (x - 8 * SS, s * 0.75)], fill=ICE + (170,), width=2 * SS)
	d.ellipse([s * 0.44, s * 0.44, s * 0.56, s * 0.56], fill=CYAN + (220,))
	return img


def build_tele(color):
	img = cell_canvas()
	s = CELL * SS
	glow = Image.new("RGBA", (s, s), (0, 0, 0, 0))
	gd = ImageDraw.Draw(glow)
	gd.ellipse([s * 0.18, s * 0.3, s * 0.82, s * 0.94], fill=color + (255,))
	glow = glow.filter(ImageFilter.GaussianBlur(9 * SS))
	img = Image.alpha_composite(img, glow)
	d = ImageDraw.Draw(img)
	d.ellipse([s * 0.22, s * 0.36, s * 0.78, s * 0.88], fill=NIGHT0 + (240,), outline=color + (255,), width=3 * SS)
	d.ellipse([s * 0.34, s * 0.48, s * 0.66, s * 0.76], outline=lerp3(color, ICE, 0.5) + (230,), width=2 * SS)
	d.arc([s * 0.22, s * 0.36, s * 0.78, s * 0.88], 200, 340, fill=ICE + (200,), width=2 * SS)
	return img


def build_grate():
	img = build_solid()
	d = ImageDraw.Draw(img)
	s = CELL * SS
	for x in range(12 * SS, s - 8 * SS, 18 * SS):
		d.rectangle([x, 10 * SS, x + 6 * SS, s - 6 * SS], fill=NIGHT0 + (235,))
		d.line([(x + 6 * SS, 10 * SS), (x + 6 * SS, s - 6 * SS)], fill=CYAN + (90,), width=SS)
	return img


def main():
	cells = {1: build_solid(), 2: build_death(), 3: build_nohook(),
		9: build_freeze(), 26: build_tele(MAGENTA), 27: build_tele(CYAN),
		33: build_start(), 34: build_finish(), 35: build_checkpoint(),
		60: build_nohook(), 61: build_grate(), 62: build_death_solid()}
	for mask in range(16):
		cells[16 + mask] = build_border(mask)
	# The renderer samples the sheet as a 16x16 grid of 64px cells
	# (src/game/map/render_map.cpp: tx = index % 16, cell = 1024/16),
	# so final cells are 64px placed at (idx % 16, idx // 16).
	OUT_CELL = 64
	sheet = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
	for idx, img in cells.items():
		if img is None:
			continue
		x = (idx % 16) * OUT_CELL
		y = (idx // 16) * OUT_CELL
		sheet.paste(img.resize((OUT_CELL, OUT_CELL), Image.LANCZOS), (x, y))
	OUT.parent.mkdir(parents=True, exist_ok=True)
	sheet.save(OUT)
	print(f"wrote {OUT} ({sheet.size[0]}x{sheet.size[1]})")
	return 0


if __name__ == "__main__":
	sys.exit(main())
