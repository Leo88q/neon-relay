#!/usr/bin/env python3
"""Neon Relay original misc sheets generator (BL-15 2/3).

Redraws the three remaining small upstream art files as originals:

  data/extras.png      512x512, grid 16x16 - part_snowflake (0,0,2,2),
                       part_sparkle (2,0,2,2), part_pulley (4,0,1,1),
                       part_hectagon (6,0,2,2)  (datasrc/content.py)
  data/strong_weak.png 192x64,  grid 3x1   - hook_strong / hook_weak / hook_icon
  data/deadtee.png     64x64               - scoreboard dead-tee face

House style: concept A neon accents on concept B night base.
"""
import math
import pathlib

from PIL import Image, ImageDraw, ImageFilter

ROOT = pathlib.Path(__file__).resolve().parent.parent
SS = 4

NIGHT0 = (6, 7, 16)
NIGHT1 = (14, 18, 38)
STEEL1 = (72, 84, 112)
STEEL2 = (126, 140, 172)
CHROME = (206, 220, 240)
MAGENTA = (255, 46, 136)
CYAN = (77, 227, 247)
ICE = (216, 246, 255)
INDIGO = (108, 96, 255)
GOLD = (255, 196, 64)


def lerp3(a, b, t):
	t = min(1.0, max(0.0, t))
	return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def new_canvas(w, h):
	return Image.new("RGBA", (w * SS, h * SS), (0, 0, 0, 0))


def glow(img, box, color, radius, alpha):
	layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
	ImageDraw.Draw(layer).ellipse(box, fill=color + (alpha,))
	img.alpha_composite(layer.filter(ImageFilter.GaussianBlur(radius)))


def snowflake(d, img, box):
	cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
	r = (box[2] - box[0]) * 0.42
	glow(img, (cx - r, cy - r, cx + r, cy + r), ICE, 8 * SS, 90)
	for k in range(6):
		a = math.radians(k * 60)
		x1, y1 = cx + r * math.cos(a), cy + r * math.sin(a)
		d.line([(cx, cy), (x1, y1)], fill=ICE + (240,), width=3 * SS)
		for t in (0.55, 0.8):
			px, py = cx + r * t * math.cos(a), cy + r * t * math.sin(a)
			for s in (-1, 1):
				b = math.radians(k * 60 + s * 45)
				d.line([(px, py), (px + r * 0.22 * math.cos(b), py + r * 0.22 * math.sin(b))],
					fill=lerp3(CYAN, ICE, 0.5) + (230,), width=2 * SS)
	d.ellipse([cx - r * 0.16, cy - r * 0.16, cx + r * 0.16, cy + r * 0.16], fill=ICE + (255,))


def sparkle(d, img, box):
	cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
	r = (box[2] - box[0]) * 0.44
	glow(img, (cx - r, cy - r, cx + r, cy + r), GOLD, 7 * SS, 100)
	d.polygon([(cx, cy - r), (cx + r * 0.22, cy - r * 0.22), (cx + r, cy),
		(cx + r * 0.22, cy + r * 0.22), (cx, cy + r), (cx - r * 0.22, cy + r * 0.22),
		(cx - r, cy), (cx - r * 0.22, cy - r * 0.22)], fill=GOLD + (245,), outline=ICE + (220,))


def pulley(d, img, box):
	cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
	r = (box[2] - box[0]) * 0.34
	d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=STEEL1 + (255,), outline=CHROME + (220,))
	d.ellipse([cx - r * 0.45, cy - r * 0.45, cx + r * 0.45, cy + r * 0.45],
		fill=lerp3(MAGENTA, NIGHT0, 0.3) + (255,))
	for k in range(4):
		a = math.radians(45 + k * 90)
		d.line([(cx + r * 0.45 * math.cos(a), cy + r * 0.45 * math.sin(a)),
			(cx + r * 0.9 * math.cos(a), cy + r * 0.9 * math.sin(a))],
			fill=STEEL2 + (255,), width=2 * SS)


def hectagon(d, img, box):
	cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
	r = (box[2] - box[0]) * 0.4
	pts = [(cx + r * math.cos(math.radians(22.5 + k * 45)),
		cy + r * math.sin(math.radians(22.5 + k * 45))) for k in range(8)]
	glow(img, (cx - r, cy - r, cx + r, cy + r), INDIGO, 7 * SS, 90)
	d.polygon(pts, fill=lerp3(INDIGO, NIGHT0, 0.25) + (240,), outline=lerp3(INDIGO, ICE, 0.5) + (240,))
	d.polygon([(cx + r * 0.5 * math.cos(math.radians(22.5 + k * 45)),
		cy + r * 0.5 * math.sin(math.radians(22.5 + k * 45))) for k in range(8)],
		fill=lerp3(INDIGO, ICE, 0.35) + (200,))


def hook_strong(d, img, box):
	cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
	w, h = (box[2] - box[0]) * 0.34, (box[3] - box[1]) * 0.36
	glow(img, (cx - w, cy - h, cx + w, cy + h), MAGENTA, 6 * SS, 110)
	d.polygon([(cx, cy - h), (cx + w, cy + h * 0.2), (cx + w * 0.35, cy + h * 0.2),
		(cx + w * 0.35, cy + h), (cx - w * 0.35, cy + h), (cx - w * 0.35, cy + h * 0.2),
		(cx - w, cy + h * 0.2)], fill=MAGENTA + (250,), outline=ICE + (210,))


def hook_weak(d, img, box):
	cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
	w, h = (box[2] - box[0]) * 0.34, (box[3] - box[1]) * 0.36
	d.polygon([(cx, cy + h), (cx + w, cy - h * 0.2), (cx + w * 0.35, cy - h * 0.2),
		(cx + w * 0.35, cy - h), (cx - w * 0.35, cy - h), (cx - w * 0.35, cy - h * 0.2),
		(cx - w, cy - h * 0.2)], fill=lerp3(CYAN, NIGHT0, 0.45) + (220,),
		outline=lerp3(CYAN, NIGHT0, 0.2) + (200,))


def hook_icon(d, img, box):
	cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
	r = (box[3] - box[1]) * 0.3
	d.arc([cx - r, cy - r, cx + r, cy + r], 300, 200, fill=CHROME + (255,), width=5 * SS)
	d.line([(cx + r * 0.7, cy - r * 0.7), (cx + r * 1.2, cy - r * 1.2)], fill=CHROME + (255,), width=5 * SS)
	d.ellipse([cx - r * 0.3, cy - r * 0.3, cx + r * 0.3, cy + r * 0.3], fill=MAGENTA + (255,))


def deadtee(d, img, box):
	cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
	r = (box[2] - box[0]) * 0.36
	d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=lerp3(NIGHT1, NIGHT0, 0.4) + (255,),
		outline=lerp3(MAGENTA, NIGHT0, 0.35) + (220,))
	for s in (-1, 1):
		ex = cx + s * r * 0.4
		d.line([(ex - r * 0.18, cy - r * 0.35 - r * 0.18), (ex + r * 0.18, cy - r * 0.35 + r * 0.18)],
			fill=lerp3(CYAN, NIGHT0, 0.2) + (240,), width=3 * SS)
		d.line([(ex - r * 0.18, cy - r * 0.35 + r * 0.18), (ex + r * 0.18, cy - r * 0.35 - r * 0.18)],
			fill=lerp3(CYAN, NIGHT0, 0.2) + (240,), width=3 * SS)
	d.line([(cx - r * 0.35, cy + r * 0.4), (cx + r * 0.35, cy + r * 0.4)],
		fill=lerp3(MAGENTA, NIGHT0, 0.3) + (230,), width=3 * SS)


def build_strong_weak():
	sw = new_canvas(192, 64)
	d = ImageDraw.Draw(sw)
	c = 64 * SS
	hook_strong(d, sw, (0, 0, c, c))
	hook_weak(d, sw, (c, 0, c * 2, c))
	hook_icon(d, sw, (c * 2, 0, c * 3, c))
	return sw.resize((192, 64), Image.LANCZOS)


def build_deadtee():
	dt = new_canvas(64, 64)
	d = ImageDraw.Draw(dt)
	deadtee(d, dt, (0, 0, 64 * SS, 64 * SS))
	return dt.resize((64, 64), Image.LANCZOS)


def main():
	extras = new_canvas(512, 512)
	d = ImageDraw.Draw(extras)
	cell = 32 * SS
	snowflake(d, extras, (0, 0, cell * 2, cell * 2))
	sparkle(d, extras, (cell * 2, 0, cell * 4, cell * 2))
	pulley(d, extras, (cell * 4, 0, cell * 5, cell))
	hectagon(d, extras, (cell * 6, 0, cell * 8, cell * 2))
	extras.resize((512, 512), Image.LANCZOS).save(ROOT / "data" / "extras.png")

	build_strong_weak().save(ROOT / "data" / "strong_weak.png")
	build_deadtee().save(ROOT / "data" / "deadtee.png")
	gui_buttons()
	print("wrote extras.png, strong_weak.png, deadtee.png, gui_buttons.png")
	return 0




def gui_buttons():
    """Original 3-state UI button sheet (data/gui_buttons.png, 384x128)."""
    img = new_canvas(384, 128)
    d = ImageDraw.Draw(img)
    states = (
        ((20, 26, 46), (77, 227, 247), 150),   # off: night slab, cyan rim
        ((70, 16, 52), (255, 46, 136), 210),  # on: magenta pressed
        ((16, 40, 56), (140, 240, 255), 230), # hover: bright cyan
    )
    for i, (fill, rim, alpha) in enumerate(states):
        x0 = i * 128 * SS
        box = [x0 + 10 * SS, 10 * SS, x0 + 118 * SS, 118 * SS]
        glow(img, [box[0] - 6 * SS, box[1] - 6 * SS, box[2] + 6 * SS, box[3] + 6 * SS],
             rim, 10 * SS, 60)
        d.rounded_rectangle(box, 14 * SS, fill=fill + (255,), outline=rim + (alpha,))
        d.rounded_rectangle([box[0] + 5 * SS, box[1] + 5 * SS, box[2] - 5 * SS, box[3] - 5 * SS],
                            10 * SS, outline=rim + (alpha // 3,), width=SS)
    img.resize((384, 128), Image.LANCZOS).save(ROOT / "data" / "gui_buttons.png")
    print("wrote data/gui_buttons.png")


if __name__ == "__main__":
	raise SystemExit(main())
