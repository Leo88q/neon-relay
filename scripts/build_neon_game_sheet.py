#!/usr/bin/env python3
"""Neon Relay original gameplay sheet generator (BL-15).

Redraws data/game.png — the weapons / pickups / effects / flags sheet — as a
fully original Neon Relay artwork in the exact sprite rectangles declared in
datasrc/content.py (set_game grid 32x16 over 1024x512). No upstream pixels:
chrome-and-neon blasters, energy katana, prism laser, neon hearts and hex
shields, magenta/cyan muzzle bursts and Neon Relay pennant flags, in the
house style (concept A neon density on concept B night base,
docs/DESIGN_SYNTHWAVE.md). Drawn at 4x and LANCZOS-downscaled.
"""
import math
import pathlib

from PIL import Image, ImageDraw, ImageFilter

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "game.png"

SS = 4
W, H = 1024, 512
CELL = 32

NIGHT0 = (6, 7, 16)
NIGHT1 = (14, 18, 38)
STEEL0 = (38, 46, 66)
STEEL1 = (72, 84, 112)
STEEL2 = (126, 140, 172)
CHROME = (206, 220, 240)
MAGENTA = (255, 46, 136)
CYAN = (77, 227, 247)
ICE = (216, 246, 255)
INDIGO = (108, 96, 255)
GOLD = (255, 196, 64)
RED = (255, 64, 96)

canvas = Image.new("RGBA", (W * SS, H * SS), (0, 0, 0, 0))


def lerp3(a, b, t):
	t = min(1.0, max(0.0, t))
	return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def rect_px(x, y, w, h):
	x0, y0 = x * CELL * SS, y * CELL * SS
	return x0, y0, x0 + w * CELL * SS, y0 + h * CELL * SS


def glow_patch(box, color, radius, alpha):
	layer = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
	d = ImageDraw.Draw(layer)
	d.ellipse(box, fill=color + (alpha,))
	layer = layer.filter(ImageFilter.GaussianBlur(radius))
	canvas.alpha_composite(layer)


def fx(box, u, v):
	"""Fractional point inside a sprite box."""
	x0, y0, x1, y1 = box
	return x0 + (x1 - x0) * u, y0 + (y1 - y0) * v


def fbox(box, u0, v0, u1, v1):
	ax, ay = fx(box, u0, v0)
	bx, by = fx(box, u1, v1)
	return [ax, ay, bx, by]


# -- pickups / icons ---------------------------------------------------------
def heart(d, box, filled):
	cx, cy = fx(box, 0.5, 0.54)
	w, h = (box[2] - box[0]) * 0.40, (box[3] - box[1]) * 0.40
	pts = []
	for t in range(0, 360, 5):
		a = math.radians(t)
		px = 16 * math.sin(a) ** 3
		py = -(13 * math.cos(a) - 5 * math.cos(2 * a) - 2 * math.cos(3 * a) - math.cos(4 * a))
		pts.append((cx + px / 17 * w, cy + py / 17 * h))
	if filled:
		glow_patch((cx - w, cy - h, cx + w, cy + h), MAGENTA, 10 * SS, 90)
		d.polygon(pts, fill=lerp3(MAGENTA, RED, 0.35) + (255,), outline=ICE + (230,))
		d.polygon([(cx - w * 0.38, cy - h * 0.22), (cx - w * 0.08, cy - h * 0.58),
			(cx + w * 0.14, cy - h * 0.18)], fill=ICE + (150,))
	else:
		d.polygon(pts, fill=NIGHT1 + (220,), outline=lerp3(MAGENTA, NIGHT1, 0.45) + (230,))


def shield(d, box, filled, glyph=None):
	x0, y0, x1, y1 = box
	pts = [fx(box, 0.12, 0.22), fx(box, 0.3, 0.1), fx(box, 0.5, 0.06), fx(box, 0.7, 0.1),
		fx(box, 0.88, 0.22), fx(box, 0.82, 0.62), fx(box, 0.5, 0.94), fx(box, 0.18, 0.62)]
	if filled:
		cx, cy = fx(box, 0.5, 0.5)
		glow_patch((cx - (x1 - x0) * 0.4, cy - (x1 - x0) * 0.4,
			cx + (x1 - x0) * 0.4, cy + (x1 - x0) * 0.4), CYAN, 9 * SS, 80)
		d.polygon(pts, fill=lerp3(STEEL0, NIGHT0, 0.3) + (255,), outline=CYAN + (240,))
		d.polygon([fx(box, 0.26, 0.26), fx(box, 0.5, 0.18), fx(box, 0.74, 0.26),
			fx(box, 0.68, 0.58), fx(box, 0.5, 0.8), fx(box, 0.32, 0.58)],
			fill=lerp3(CYAN, INDIGO, 0.45) + (230,))
		if glyph:
			glyph(d, fbox(box, 0.34, 0.3, 0.66, 0.68))
	else:
		d.polygon(pts, fill=NIGHT1 + (200,), outline=lerp3(CYAN, NIGHT1, 0.5) + (220,))


def star(d, box, i):
	cx, cy = fx(box, 0.5, 0.5)
	r = (box[2] - box[0]) * (0.42 - i * 0.05)
	pts = []
	for k in range(10):
		rr = r if k % 2 == 0 else r * 0.45
		a = math.radians(-90 + k * 36)
		pts.append((cx + rr * math.cos(a), cy + rr * math.sin(a)))
	glow_patch((cx - r, cy - r, cx + r, cy + r), GOLD, 8 * SS, 100)
	d.polygon(pts, fill=GOLD + (255,), outline=ICE + (220,))


def freeze_crystal(d, box):
	cx, cy = fx(box, 0.5, 0.5)
	w, h = (box[2] - box[0]) * 0.3, (box[3] - box[1]) * 0.4
	glow_patch((cx - w, cy - h, cx + w, cy + h), INDIGO, 9 * SS, 110)
	d.polygon([(cx, cy - h), (cx + w, cy - h * 0.2), (cx + w * 0.6, cy + h),
		(cx - w * 0.6, cy + h), (cx - w, cy - h * 0.2)],
		fill=lerp3(INDIGO, ICE, 0.35) + (240,), outline=ICE + (240,))
	d.line([(cx, cy - h), (cx, cy + h)], fill=ICE + (160,), width=SS)


# -- weapons -----------------------------------------------------------------
def gun_body(d, box):
	d.polygon([fx(box, 0.16, 0.55), fx(box, 0.34, 0.55), fx(box, 0.28, 0.95),
		fx(box, 0.12, 0.95)], fill=STEEL0 + (255,))
	d.polygon([fx(box, 0.19, 0.6), fx(box, 0.29, 0.6), fx(box, 0.25, 0.88),
		fx(box, 0.17, 0.88)], fill=lerp3(MAGENTA, NIGHT0, 0.35) + (255,))
	d.rounded_rectangle(fbox(box, 0.12, 0.22, 0.78, 0.6), 3 * SS,
		fill=STEEL1 + (255,), outline=STEEL2 + (210,))
	d.rounded_rectangle(fbox(box, 0.2, 0.32, 0.52, 0.5), 2 * SS,
		fill=lerp3(CYAN, NIGHT0, 0.2) + (235,))
	d.rectangle(fbox(box, 0.78, 0.34, 0.96, 0.48), fill=STEEL2 + (255,))
	d.line([fx(box, 0.78, 0.34), fx(box, 0.96, 0.34)], fill=CHROME + (150,), width=SS)
	d.ellipse(fbox(box, 0.9, 0.3, 0.99, 0.52), fill=CYAN + (255,))


def shotgun_body(d, box):
	d.polygon([fx(box, 0.1, 0.55), fx(box, 0.24, 0.55), fx(box, 0.18, 0.95),
		fx(box, 0.05, 0.95)], fill=STEEL0 + (255,))
	d.rounded_rectangle(fbox(box, 0.08, 0.2, 0.52, 0.68), 3 * SS,
		fill=STEEL1 + (255,), outline=STEEL2 + (210,))
	d.rounded_rectangle(fbox(box, 0.16, 0.32, 0.44, 0.56), 2 * SS,
		fill=lerp3(MAGENTA, NIGHT0, 0.25) + (235,))
	d.rectangle(fbox(box, 0.52, 0.26, 0.94, 0.42), fill=STEEL2 + (255,))
	d.rectangle(fbox(box, 0.52, 0.46, 0.94, 0.62), fill=lerp3(STEEL2, NIGHT0, 0.3) + (255,))
	d.rectangle(fbox(box, 0.6, 0.66, 0.8, 0.82), fill=STEEL0 + (255,))
	d.ellipse(fbox(box, 0.9, 0.24, 0.98, 0.44), fill=MAGENTA + (255,))
	d.ellipse(fbox(box, 0.9, 0.44, 0.98, 0.64), fill=MAGENTA + (255,))


def grenade_body(d, box):
	d.rounded_rectangle(fbox(box, 0.08, 0.24, 0.62, 0.76), 4 * SS,
		fill=STEEL1 + (255,), outline=STEEL2 + (210,))
	cx, cy = fx(box, 0.34, 0.5)
	r = (box[3] - box[1]) * 0.26
	glow_patch((cx - r, cy - r, cx + r, cy + r), MAGENTA, 8 * SS, 90)
	d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=lerp3(MAGENTA, NIGHT0, 0.3) + (255,),
		outline=MAGENTA + (230,))
	d.ellipse([cx - r * 0.35, cy - r * 0.35, cx + r * 0.35, cy + r * 0.35], fill=ICE + (210,))
	d.rectangle(fbox(box, 0.62, 0.4, 0.92, 0.6), fill=STEEL2 + (255,))
	d.ellipse(fbox(box, 0.88, 0.36, 0.97, 0.64), fill=GOLD + (255,))


def ninja_body(d, box):
	d.rectangle(fbox(box, 0.05, 0.4, 0.18, 0.62), fill=STEEL0 + (255,))
	d.rectangle(fbox(box, 0.18, 0.24, 0.23, 0.78), fill=GOLD + (255,))
	pts = [fx(box, 0.23, 0.34), fx(box, 0.86, 0.4), fx(box, 0.98, 0.5),
		fx(box, 0.86, 0.58), fx(box, 0.23, 0.66)]
	glow_patch(fbox(box, 0.2, 0.2, 1.0, 0.8), CYAN, 8 * SS, 90)
	d.polygon(pts, fill=lerp3(CYAN, ICE, 0.45) + (240,), outline=ICE + (255,))
	d.line([fx(box, 0.28, 0.48), fx(box, 0.88, 0.48)], fill=ICE + (230,), width=SS)


def laser_body(d, box):
	d.polygon([fx(box, 0.12, 0.58), fx(box, 0.28, 0.58), fx(box, 0.22, 0.96),
		fx(box, 0.08, 0.96)], fill=STEEL0 + (255,))
	d.rounded_rectangle(fbox(box, 0.1, 0.24, 0.6, 0.72), 4 * SS,
		fill=STEEL1 + (255,), outline=STEEL2 + (210,))
	d.rounded_rectangle(fbox(box, 0.18, 0.38, 0.5, 0.58), 2 * SS,
		fill=lerp3(INDIGO, NIGHT0, 0.15) + (235,))
	px, py = fx(box, 0.68, 0.48)
	r = (box[3] - box[1]) * 0.3
	glow_patch((px - r, py - r, px + r, py + r), INDIGO, 9 * SS, 120)
	d.polygon([fx(box, 0.6, 0.2), fx(box, 0.86, 0.48), fx(box, 0.6, 0.76), fx(box, 0.48, 0.48)],
		fill=lerp3(INDIGO, ICE, 0.4) + (240,), outline=ICE + (240,))
	d.rectangle(fbox(box, 0.86, 0.44, 0.97, 0.52), fill=ICE + (220,))


def hammer_body(d, box):
	d.rectangle(fbox(box, 0.06, 0.44, 0.56, 0.58), fill=STEEL1 + (255,))
	d.line([fx(box, 0.06, 0.44), fx(box, 0.56, 0.44)], fill=CHROME + (140,), width=SS)
	glow_patch(fbox(box, 0.5, 0.05, 1.0, 0.95), MAGENTA, 9 * SS, 90)
	d.rounded_rectangle(fbox(box, 0.56, 0.1, 0.96, 0.9), 5 * SS,
		fill=STEEL2 + (255,), outline=CHROME + (230,))
	d.rounded_rectangle(fbox(box, 0.68, 0.2, 0.84, 0.8), 4 * SS,
		fill=lerp3(MAGENTA, NIGHT0, 0.2) + (245,))
	d.line([fx(box, 0.76, 0.24), fx(box, 0.76, 0.76)], fill=ICE + (170,), width=SS)


# -- small parts / projectiles / cursors -------------------------------------
def muzzle(d, box, variant, color):
	cx, cy = fx(box, 0.5, 0.5)
	r = min(box[2] - box[0], box[3] - box[1]) * 0.42
	glow_patch((cx - r, cy - r, cx + r, cy + r), color, 10 * SS, 120)
	pts = []
	spikes = 7 + variant
	for k in range(spikes * 2):
		rr = r * (1.0 if k % 2 == 0 else 0.42)
		a = math.radians(k * (360 / (spikes * 2)) + variant * 13)
		pts.append((cx + rr * math.cos(a), cy + rr * math.sin(a)))
	d.polygon(pts, fill=color + (235,), outline=ICE + (230,))
	d.ellipse([cx - r * 0.25, cy - r * 0.25, cx + r * 0.25, cy + r * 0.25], fill=ICE + (255,))


def cursor_cross(d, box, color):
	cx, cy = fx(box, 0.5, 0.5)
	r = (box[2] - box[0]) * 0.34
	for k in range(4):
		a = math.radians(45 + k * 90)
		d.line([(cx + r * 0.35 * math.cos(a), cy + r * 0.35 * math.sin(a)),
			(cx + r * math.cos(a), cy + r * math.sin(a))], fill=color + (255,), width=3 * SS)
	d.ellipse([cx - 2 * SS, cy - 2 * SS, cx + 2 * SS, cy + 2 * SS], fill=color + (255,))


def proj_orb(d, box, color):
	cx, cy = fx(box, 0.5, 0.5)
	r = (box[2] - box[0]) * 0.24
	glow_patch((cx - r * 2, cy - r * 2, cx + r * 2, cy + r * 2), color, 6 * SS, 130)
	d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=color + (255,), outline=ICE + (230,))


def smoke(d, box, i, big):
	cx, cy = fx(box, 0.5, 0.5)
	r = (box[2] - box[0]) * (0.16 + 0.05 * i) if not big else (box[2] - box[0]) * 0.34
	col = lerp3(STEEL2, ICE, 0.2 + 0.1 * i)
	d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=col + (120 - 12 * i,))


def hook_chain(d, box):
	cx, cy = fx(box, 0.5, 0.5)
	r = (box[2] - box[0]) * 0.3
	d.ellipse([cx - r, cy - r * 1.25, cx + r, cy + r * 1.25], outline=STEEL2 + (255,), width=4 * SS)


def hook_head(d, box):
	cx, cy = fx(box, 0.5, 0.5)
	r = (box[3] - box[1]) * 0.36
	d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=STEEL1 + (255,), outline=CHROME + (230,))
	for k in (-1, 1):
		d.arc([cx + k * r * 1.1 - r, cy - r * 1.1, cx + k * r * 1.1 + r, cy + r * 0.9],
			180 if k < 0 else 340, 340 if k < 0 else 120, fill=CHROME + (255,), width=4 * SS)
	d.ellipse([cx - r * 0.35, cy - r * 0.35, cx + r * 0.35, cy + r * 0.35], fill=MAGENTA + (255,))


def flag(d, box, color):
	px, _ = fx(box, 0.14, 0)
	d.rectangle([px - 2 * SS, box[1] + 4 * SS, px + 2 * SS, box[3] - 3 * SS], fill=STEEL2 + (255,))
	d.ellipse([px - 4 * SS, box[1] + 1 * SS, px + 4 * SS, box[1] + 9 * SS], fill=GOLD + (255,))
	cloth = [fx(box, 0.18, 0.1), fx(box, 0.95, 0.16), fx(box, 0.82, 0.34),
		fx(box, 0.95, 0.52), fx(box, 0.18, 0.58)]
	d.polygon(cloth, fill=color + (255,), outline=ICE + (210,))
	cx, cy = fx(box, 0.52, 0.34)
	r = (box[3] - box[1]) * 0.13
	glow_patch((cx - r, cy - r, cx + r, cy + r), GOLD, 5 * SS, 90)
	d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=GOLD + (255,))
	for i in range(1, 4):
		yy = cy + i * r * 0.45
		hw = math.sqrt(max(0.0, r * r - (yy - cy) ** 2))
		d.rectangle([cx - hw, yy, cx + hw, yy + r * 0.22], fill=lerp3(color, NIGHT0, 0.6) + (255,))


def ninja_muzzle(d, box, variant):
	cx, cy = fx(box, 0.5, 0.5)
	r = min(box[2] - box[0], box[3] - box[1]) * 0.4
	glow_patch((cx - r, cy - r, cx + r, cy + r), CYAN, 12 * SS, 110)
	for k in range(6 + variant * 2):
		a = math.radians(k * (360 / (6 + variant * 2)) + variant * 21)
		d.line([(cx + r * 0.25 * math.cos(a), cy + r * 0.25 * math.sin(a)),
			(cx + r * math.cos(a), cy + r * math.sin(a))],
			fill=lerp3(CYAN, ICE, 0.4) + (230,), width=3 * SS)
	d.ellipse([cx - r * 0.3, cy - r * 0.3, cx + r * 0.3, cy + r * 0.3], fill=ICE + (255,))


def build():
	d = ImageDraw.Draw(canvas)
	heart(d, rect_px(21, 0, 2, 2), True)
	heart(d, rect_px(23, 0, 2, 2), False)
	shield(d, rect_px(21, 2, 2, 2), True)
	shield(d, rect_px(23, 2, 2, 2), False)
	star(d, rect_px(15, 0, 2, 2), 0)
	star(d, rect_px(17, 0, 2, 2), 1)
	star(d, rect_px(19, 0, 2, 2), 2)
	freeze_crystal(d, rect_px(6, 2, 2, 2))
	for i, (px, py) in enumerate(((6, 0), (6, 1), (7, 0), (7, 1), (8, 0), (8, 1))):
		smoke(d, rect_px(px, py, 1, 1), i % 3, False)
	smoke(d, rect_px(9, 0, 2, 2), 0, True)
	smoke(d, rect_px(11, 0, 2, 2), 1, True)
	smoke(d, rect_px(13, 0, 2, 2), 2, True)
	hook_chain(d, rect_px(2, 0, 1, 1))
	hook_head(d, rect_px(3, 0, 2, 1))
	gun_body(d, rect_px(2, 4, 4, 2))
	cursor_cross(d, rect_px(0, 4, 2, 2), CYAN)
	proj_orb(d, rect_px(6, 4, 2, 2), CYAN)
	muzzle(d, rect_px(8, 4, 4, 2), 0, CYAN)
	muzzle(d, rect_px(12, 4, 4, 2), 1, CYAN)
	muzzle(d, rect_px(16, 4, 4, 2), 2, CYAN)
	shotgun_body(d, rect_px(2, 6, 8, 2))
	cursor_cross(d, rect_px(0, 6, 2, 2), MAGENTA)
	proj_orb(d, rect_px(10, 6, 2, 2), MAGENTA)
	muzzle(d, rect_px(12, 6, 4, 2), 0, MAGENTA)
	muzzle(d, rect_px(16, 6, 4, 2), 1, MAGENTA)
	muzzle(d, rect_px(20, 6, 4, 2), 2, MAGENTA)
	grenade_body(d, rect_px(2, 8, 7, 2))
	cursor_cross(d, rect_px(0, 8, 2, 2), GOLD)
	proj_orb(d, rect_px(10, 8, 2, 2), GOLD)
	hammer_body(d, rect_px(2, 1, 4, 3))
	cursor_cross(d, rect_px(0, 0, 2, 2), CHROME)
	ninja_body(d, rect_px(2, 10, 8, 2))
	cursor_cross(d, rect_px(0, 10, 2, 2), ICE)
	laser_body(d, rect_px(2, 12, 7, 3))
	cursor_cross(d, rect_px(0, 12, 2, 2), INDIGO)
	proj_orb(d, rect_px(10, 12, 2, 2), INDIGO)
	ninja_muzzle(d, rect_px(25, 0, 7, 4), 0)
	ninja_muzzle(d, rect_px(25, 4, 7, 4), 1)
	ninja_muzzle(d, rect_px(25, 8, 7, 4), 2)
	heart(d, rect_px(10, 2, 2, 2), True)
	shield(d, rect_px(12, 2, 2, 2), True)
	shield(d, rect_px(15, 2, 2, 2), True, glyph=lambda dd, b: dd.polygon(
		[(b[0], b[1] + (b[3] - b[1]) * 0.5), (b[0] + (b[2] - b[0]) * 0.7, b[1] + (b[3] - b[1]) * 0.2),
			(b[2], b[1] + (b[3] - b[1]) * 0.5), (b[0] + (b[2] - b[0]) * 0.7, b[1] + (b[3] - b[1]) * 0.9)],
		fill=ICE + (240,)))
	shield(d, rect_px(17, 2, 2, 2), True, glyph=lambda dd, b: dd.ellipse(
		[b[0], b[1], b[2], b[3]], fill=ICE + (240,)))
	shield(d, rect_px(19, 2, 2, 2), True, glyph=lambda dd, b: dd.line(
		[(b[0], b[3]), (b[2], b[1])], fill=ICE + (240,), width=3 * SS))
	shield(d, rect_px(10, 10, 2, 2), True, glyph=lambda dd, b: dd.polygon(
		[(b[0] + (b[2] - b[0]) * 0.5, b[1]), (b[2], b[1] + (b[3] - b[1]) * 0.5),
			(b[0] + (b[2] - b[0]) * 0.5, b[3]), (b[0], b[1] + (b[3] - b[1]) * 0.5)], fill=ICE + (240,)))
	flag(d, rect_px(12, 8, 4, 8), lerp3(CYAN, INDIGO, 0.55))
	flag(d, rect_px(16, 8, 4, 8), lerp3(MAGENTA, RED, 0.45))
	return canvas.resize((W, H), Image.LANCZOS)


def main():
	img = build()
	img.save(OUT)
	print(f"wrote {OUT} ({img.size[0]}x{img.size[1]})")
	return 0


if __name__ == "__main__":
	raise SystemExit(main())
