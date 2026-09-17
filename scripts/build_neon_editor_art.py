#!/usr/bin/env python3
"""Neon Relay original editor art (BL-16 1/2).

Redraws every editor helper sheet with original pixels while preserving the
functional layout: for each 1024x1024 overlay the occupied 64px cells (alpha
mask of the previous sheet) are kept, but the art inside them is replaced by
procedural neon glyphs (portals, bolts, arrows, notes, stars, entity icons).
Small editor pngs (cursor, checker, audio_source, speed_arrow) and the
entity icon sets are redrawn from scratch in the house style.
"""
import math
import pathlib

from PIL import Image, ImageDraw, ImageFilter

ROOT = pathlib.Path(__file__).resolve().parent.parent
ED = ROOT / "data" / "editor"
SS = 4

NIGHT = (10, 12, 24)
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


def occupied_cells(path, cell=64):
	im = Image.open(path).convert("RGBA")
	cells = []
	for cy in range(im.height // cell):
		for cx in range(im.width // cell):
			box = im.crop((cx * cell, cy * cell, cx * cell + cell, cy * cell + cell))
			if max(box.getchannel("A").getextrema()) > 8:
				cells.append((cx, cy))
	return cells


def glow(d, img, box, color, radius, alpha):
	layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
	ImageDraw.Draw(layer).ellipse(box, fill=color + (alpha,))
	img.alpha_composite(layer.filter(ImageFilter.GaussianBlur(radius)))


def glyph_portal(d, img, box, color):
	cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
	r = (box[2] - box[0]) * 0.32
	glow(d, img, (cx - r, cy - r, cx + r, cy + r), color, 6, 110)
	d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=color + (240,), width=3)
	d.ellipse([cx - r * 0.45, cy - r * 0.45, cx + r * 0.45, cy + r * 0.45], fill=color + (200,))


def glyph_bolt(d, box, color):
	x0, y0, x1, y1 = box
	w, h = x1 - x0, y1 - y0
	d.polygon([(x0 + w * 0.55, y0 + h * 0.15), (x0 + w * 0.35, y0 + h * 0.52),
		(x0 + w * 0.5, y0 + h * 0.52), (x0 + w * 0.42, y0 + h * 0.85),
		(x0 + w * 0.68, y0 + h * 0.45), (x0 + w * 0.52, y0 + h * 0.45)],
		fill=color + (240,))


def glyph_arrow(d, box, color, angle):
	cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
	r = (box[2] - box[0]) * 0.34
	pts = [(r, 0), (-r * 0.4, r * 0.5), (-r * 0.15, 0), (-r * 0.4, -r * 0.5)]
	rot = [((x * math.cos(angle) - y * math.sin(angle)) + cx,
		(x * math.sin(angle) + y * math.cos(angle)) + cy) for x, y in pts]
	d.polygon(rot, fill=color + (240,))


def glyph_note(d, box, color):
	x0, y0, x1, y1 = box
	w, h = x1 - x0, y1 - y0
	d.line([(x0 + w * 0.6, y0 + h * 0.2), (x0 + w * 0.6, y0 + h * 0.72)], fill=color + (240,), width=3)
	d.ellipse([x0 + w * 0.38, y0 + h * 0.66, x0 + w * 0.62, y0 + h * 0.86], fill=color + (240,))
	d.line([(x0 + w * 0.6, y0 + h * 0.2), (x0 + w * 0.78, y0 + h * 0.3)], fill=color + (240,), width=3)


def glyph_star(d, box, color):
	cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
	r = (box[2] - box[0]) * 0.34
	pts = []
	for k in range(10):
		rr = r if k % 2 == 0 else r * 0.45
		a = math.radians(-90 + k * 36)
		pts.append((cx + rr * math.cos(a), cy + rr * math.sin(a)))
	d.polygon(pts, fill=color + (240,))


def glyph_entity(d, box, kind, color):
	x0, y0, x1, y1 = box
	w, h = x1 - x0, y1 - y0
	if kind == 0:  # weapon crate
		d.rounded_rectangle([x0 + w * 0.2, y0 + h * 0.3, x0 + w * 0.8, y0 + h * 0.7],
			4, fill=lerp3(color, NIGHT, 0.35) + (240,), outline=color + (240,))
		d.line([(x0 + w * 0.5, y0 + h * 0.3), (x0 + w * 0.5, y0 + h * 0.7)], fill=color + (200,), width=2)
	elif kind == 1:  # heart
		d.ellipse([x0 + w * 0.24, y0 + h * 0.28, x0 + w * 0.5, y0 + h * 0.54], fill=color + (240,))
		d.ellipse([x0 + w * 0.5, y0 + h * 0.28, x0 + w * 0.76, y0 + h * 0.54], fill=color + (240,))
		d.polygon([(x0 + w * 0.24, y0 + h * 0.44), (x0 + w * 0.76, y0 + h * 0.44),
			(x0 + w * 0.5, y0 + h * 0.78)], fill=color + (240,))
	elif kind == 2:  # shield
		d.polygon([(x0 + w * 0.3, y0 + h * 0.25), (x0 + w * 0.7, y0 + h * 0.25),
			(x0 + w * 0.66, y0 + h * 0.6), (x0 + w * 0.5, y0 + h * 0.78),
			(x0 + w * 0.34, y0 + h * 0.6)], fill=color + (240,))
	elif kind == 3:  # flag
		d.line([(x0 + w * 0.35, y0 + h * 0.2), (x0 + w * 0.35, y0 + h * 0.8)], fill=color + (240,), width=3)
		d.polygon([(x0 + w * 0.38, y0 + h * 0.22), (x0 + w * 0.75, y0 + h * 0.32),
			(x0 + w * 0.38, y0 + h * 0.46)], fill=color + (240,))
	elif kind == 4:  # timer gem
		d.polygon([(x0 + w * 0.5, y0 + h * 0.2), (x0 + w * 0.72, y0 + h * 0.5),
			(x0 + w * 0.5, y0 + h * 0.8), (x0 + w * 0.28, y0 + h * 0.5)], fill=color + (240,))
	else:  # spawn ring
		d.ellipse([x0 + w * 0.3, y0 + h * 0.3, x0 + w * 0.7, y0 + h * 0.7],
			outline=color + (240,), width=3)
		d.ellipse([x0 + w * 0.45, y0 + h * 0.45, x0 + w * 0.55, y0 + h * 0.55], fill=color + (240,))


def rebuild_overlay(name, glyph_fn):
	path = ED / name
	cells = occupied_cells(path)
	img = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
	d = ImageDraw.Draw(img)
	for cx, cy in cells:
		box = (cx * 64 + 4, cy * 64 + 4, cx * 64 + 60, cy * 64 + 60)
		glyph_fn(d, img, box, (cx, cy))
	img.save(path, "PNG")
	return len(cells)


def main():
	counts = {}
	counts["tele"] = rebuild_overlay("tele.png", lambda d, img, b, c:
		glyph_portal(d, img, b, MAGENTA if c[0] % 2 == 0 else CYAN))
	counts["switch"] = rebuild_overlay("switch.png", lambda d, img, b, c:
		glyph_bolt(d, b, GOLD))
	counts["speedup"] = rebuild_overlay("speedup.png", lambda d, img, b, c:
		glyph_arrow(d, b, CYAN, math.radians((c[0] % 8) * 45)))
	counts["tune"] = rebuild_overlay("tune.png", lambda d, img, b, c:
		glyph_note(d, b, INDIGO))
	counts["front"] = rebuild_overlay("front.png", lambda d, img, b, c:
		glyph_star(d, b, ICE))
	for sheet in sorted((ED / "entities").glob("*.png")):
		cells = occupied_cells(sheet)
		img = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
		d = ImageDraw.Draw(img)
		for i, (cx, cy) in enumerate(cells):
			box = (cx * 64 + 6, cy * 64 + 6, cx * 64 + 58, cy * 64 + 58)
			glyph_entity(d, box, i % 6, [CYAN, MAGENTA, GOLD, ICE, INDIGO, CHROME][i % 6])
		img.save(sheet, "PNG")
		counts[f"entities/{sheet.name}"] = len(cells)
	for sheet in sorted((ED / "entities_clear").glob("*.png")):
		cells = occupied_cells(sheet)
		img = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
		d = ImageDraw.Draw(img)
		for i, (cx, cy) in enumerate(cells):
			x0, y0, x1, y1 = (cx * 64 + 10, cy * 64 + 10, cx * 64 + 54, cy * 64 + 54)
			d.ellipse([x0, y0, x1, y1], outline=STEEL2 + (200,), width=2)
			d.line([(x0 + 8, y1 - 8), (x1 - 8, y0 + 8)], fill=STEEL2 + (200,), width=2)
		img.save(sheet, "PNG")
		counts[f"entities_clear/{sheet.name}"] = len(cells)

	# small editor pngs
	cur = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
	d = ImageDraw.Draw(cur)
	d.polygon([(12, 8), (52, 32), (30, 36), (36, 54), (28, 56), (22, 38), (12, 46)],
		fill=ICE + (255,), outline=lerp3(CYAN, NIGHT, 0.4) + (255,))
	cur.save(ED / "cursor.png", "PNG")
	chk = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
	d = ImageDraw.Draw(chk)
	for y in range(4):
		for x in range(4):
			if (x + y) % 2 == 0:
				d.rectangle([x * 8, y * 8, x * 8 + 8, y * 8 + 8], fill=lerp3(NIGHT, STEEL2, 0.25) + (90,))
	chk.save(ED / "checker.png", "PNG")
	aud = Image.new("RGBA", (128, 128), (0, 0, 0, 0))
	d = ImageDraw.Draw(aud)
	for i, r in enumerate((52, 38, 24)):
		d.ellipse([64 - r, 64 - r, 64 + r, 64 + r], outline=lerp3(CYAN, MAGENTA, i / 2) + (220 - i * 40,),
			width=3)
	d.ellipse([56, 56, 72, 72], fill=MAGENTA + (255,))
	aud.save(ED / "audio_source.png", "PNG")
	sa = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
	d = ImageDraw.Draw(sa)
	d.polygon([(10, 32), (40, 14), (40, 26), (56, 26), (56, 38), (40, 38), (40, 50)],
		fill=CYAN + (255,), outline=ICE + (220,))
	sa.save(ED / "speed_arrow.png", "PNG")
	print("editor art rebuilt:", len(counts), "sheets;",
		{ k: v for k, v in list(counts.items())[:6] })
	return 0


if __name__ == "__main__":
	raise SystemExit(main())
