#!/usr/bin/env python3
"""Neon Relay original map backgrounds (BL-14, style A with B base).

Two from-scratch sheets:
  data/mapres/neonrelay_sky.png      2048x1024 full-bleed outrun backdrop:
    night-purple gradient, star field, striped setting sun on the horizon,
    chrome mountain ridges with pink rim light, magenta perspective grid
    floor, horizon glow, scanlines and vignette.
  data/mapres/neonrelay_scenery.png  1024x1024 (16x16 grid of 64px cells)
#   of midground
    props: palms, chrome peaks, neon signs, antennas, cloud streaks,
    star clusters, meteor, horizon strip — for parallax decor layers.
No upstream pixels; deterministic seed.
"""
import pathlib
import random
import sys

from PIL import Image, ImageDraw, ImageFilter

ROOT = pathlib.Path(__file__).resolve().parent.parent
MAPRES = ROOT / "data" / "mapres"
SKY = MAPRES / "neonrelay_sky.png"
SCENERY = MAPRES / "neonrelay_scenery.png"

NIGHT0 = (5, 6, 14)
PURPLE = (46, 12, 84)
PURPLE2 = (96, 18, 96)
MAGENTA = (255, 46, 136)
CYAN = (77, 227, 247)
INDIGO = (108, 96, 255)
ICE = (216, 246, 255)
DIM = (96, 116, 148)
SUN_TOP = (255, 95, 109)
SUN_BOTTOM = (255, 176, 32)

rng = random.Random(4202609)


def lerp3(a, b, t):
	t = min(1.0, max(0.0, t))
	return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def build_sky():
	w, h = 2048, 1024
	img = Image.new("RGBA", (w, h), (0, 0, 0, 255))
	d = ImageDraw.Draw(img)
	horizon = int(h * 0.62)
	# sky gradient
	for y in range(horizon):
		t = y / horizon
		c = lerp3(NIGHT0, PURPLE, t ** 1.4) if t < 0.7 else lerp3(PURPLE, PURPLE2, (t - 0.7) / 0.3)
		d.line([(0, y), (w, y)], fill=c + (255,))
	# stars
	for _ in range(420):
		x = rng.randrange(w)
		y = rng.randrange(int(horizon * 0.92))
		r = rng.choice((1, 1, 1, 2))
		c = rng.choice((ICE, ICE, CYAN, MAGENTA))
		a = rng.randrange(70, 230)
		d.ellipse([x, y, x + r, y + r], fill=c + (a,))
	# sun glow + striped disc
	cx = w // 2
	r = int(h * 0.30)
	glow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
	gd = ImageDraw.Draw(glow)
	gd.ellipse([cx - r - 90, horizon - r - 90, cx + r + 90, horizon + 90], fill=MAGENTA + (160,))
	glow = glow.filter(ImageFilter.GaussianBlur(60))
	img = Image.alpha_composite(img, glow)
	d = ImageDraw.Draw(img)
	sun = Image.new("RGBA", (w, h), (0, 0, 0, 0))
	sd = ImageDraw.Draw(sun)
	top = horizon - r
	for y in range(top, horizon):
		t = (y - top) / r
		c = lerp3(SUN_TOP, SUN_BOTTOM, t)
		gap = int(2 + 26 * t * t)
		band = max(2, int(10 - 4 * t))
		if (y % (band + gap)) < band or t < 0.45:
			sd.line([(cx - r, y), (cx + r, y)], fill=c + (255,))
	mask = Image.new("L", (w, h), 0)
	md = ImageDraw.Draw(mask)
	md.pieslice([cx - r, top, cx + r, top + 2 * r], 180, 360, fill=255)
	img.paste(sun, (0, 0), Image.composite(sun.getchannel("A"), Image.new("L", (w, h), 0), mask))
	d = ImageDraw.Draw(img)
	# chrome mountains left/right
	def ridge(x0, x1, peak, seed):
		rr = random.Random(seed)
		pts = [(x0, horizon)]
		x = x0
		while x < x1:
			x += rr.randrange(60, 150)
			pts.append((min(x, x1), horizon - rr.randrange(int(peak * 0.35), peak)))
		pts.append((x1, horizon))
		poly = Image.new("RGBA", (w, h), (0, 0, 0, 0))
		pd = ImageDraw.Draw(poly)
		pd.polygon(pts + [(x1, horizon + 4), (x0, horizon + 4)], fill=(200, 210, 230, 255))
		# chrome vertical gradient
		grad = Image.new("RGBA", (w, h), (0, 0, 0, 0))
		gdr = ImageDraw.Draw(grad)
		for y in range(horizon - peak, horizon):
			t = (y - (horizon - peak)) / peak
			c = lerp3(ICE, DIM, t) if t < 0.5 else lerp3(DIM, NIGHT2C, (t - 0.5) / 0.5)
			gdr.line([(0, y), (w, y)], fill=c + (255,))
		poly = Image.composite(grad, Image.new("RGBA", (w, h), (0, 0, 0, 0)), poly.getchannel("A"))
		pd = ImageDraw.Draw(poly)
		pd.line(pts, fill=MAGENTA + (200,), width=3)
		return poly
	NIGHT2C = (16, 26, 48)
	img = Image.alpha_composite(img, ridge(0, int(w * 0.34), 260, 7))
	img = Image.alpha_composite(img, ridge(int(w * 0.66), w, 300, 13))
	d = ImageDraw.Draw(img)
	# horizon glow line
	hl = Image.new("RGBA", (w, h), (0, 0, 0, 0))
	hd = ImageDraw.Draw(hl)
	hd.line([(0, horizon), (w, horizon)], fill=MAGENTA + (255,), width=6)
	hl = hl.filter(ImageFilter.GaussianBlur(8))
	img = Image.alpha_composite(img, hl)
	d = ImageDraw.Draw(img)
	d.line([(0, horizon), (w, horizon)], fill=lerp3(MAGENTA, ICE, 0.5) + (255,), width=2)
	# grid floor
	floor = Image.new("RGBA", (w, h), (0, 0, 0, 0))
	fd = ImageDraw.Draw(floor)
	yy = horizon + 6
	step = 6
	while yy < h:
		fd.line([(0, yy), (w, yy)], fill=MAGENTA + (150,), width=2)
		yy += step
		step = int(step * 1.55)
	vx = w // 2
	for i in range(-14, 15):
		xb = vx + i * 150
		fd.line([(vx + i * 12, horizon), (xb, h)], fill=MAGENTA + (130,), width=2)
	img = Image.alpha_composite(img, floor)
	# scanlines + vignette
	d = ImageDraw.Draw(img)
	for y in range(0, h, 4):
		d.line([(0, y), (w, y)], fill=(0, 0, 0, 14), width=1)
	vig = Image.new("L", (w, h), 0)
	vd = ImageDraw.Draw(vig)
	vd.ellipse([-w // 3, -h // 2, w + w // 3, h + h // 2], fill=255)
	vig = vig.filter(ImageFilter.GaussianBlur(180))
	black = Image.new("RGBA", (w, h), NIGHT0 + (160,))
	img = Image.composite(img, black, vig)
	return img


def build_scenery():
	# The tile renderer assumes every tileset image is 1024x1024 sampled as a
	# 16x16 grid of 64px cells (render_map.cpp: TexSize = 1024.0f), so props are
	# drawn at 128px for quality and downscaled into their 64px cell.
	cell = 128
	final = 64
	sheet = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))

	def at(idx):
		c = Image.new("RGBA", (cell, cell), (0, 0, 0, 0))
		return c, ImageDraw.Draw(c), (idx % 16) * final, (idx // 16) * final

	def put(c, x, y):
		sheet.paste(c.resize((final, final), Image.LANCZOS), (x, y))

	# 1 palm with cyan rim
	c, d, x, y = at(1)
	d.line([(60, 120), (66, 60)], fill=(20, 16, 40, 255), width=6)
	for ang in (-70, -30, 10, 50, 90, 130):
		import math
		rad = math.radians(ang)
		d.arc([66 - 34, 60 - 26, 66 + 34, 60 + 26], ang - 26, ang + 26, fill=(24, 20, 46, 255), width=7)
		d.arc([66 - 36, 60 - 28, 66 + 36, 60 + 28], ang - 20, ang + 20, fill=CYAN + (140,), width=2)
	put(c, x, y)
	# 2/3 chrome peaks
	for idx, flip in ((2, False), (3, True)):
		c, d, x, y = at(idx)
		pts = [(10, 120), (52, 26), (78, 64), (104, 34), (120, 120)]
		if flip:
			pts = [(128 - px, py) for px, py in pts]
		d.polygon(pts, fill=(150, 165, 190, 255))
		d.line(pts, fill=MAGENTA + (190,), width=2)
		d.polygon([(pts[0][0], 120), (pts[1][0], 26), (pts[1][0] + 6, 40), (pts[0][0] + 18, 120)], fill=ICE + (120,))
		put(c, x, y)
	# 4 neon arrow sign
	c, d, x, y = at(4)
	d.rounded_rectangle([24, 30, 104, 98], radius=10, outline=MAGENTA + (255,), width=4)
	d.polygon([(44, 48), (84, 64), (44, 80)], fill=CYAN + (255,))
	put(c, x, y)
	# 5 antenna with beacon
	c, d, x, y = at(5)
	d.line([(64, 122), (64, 30)], fill=(120, 130, 160, 255), width=4)
	d.line([(48, 122), (64, 70)], fill=(90, 100, 130, 255), width=3)
	d.line([(80, 122), (64, 70)], fill=(90, 100, 130, 255), width=3)
	d.ellipse([58, 20, 70, 32], fill=MAGENTA + (255,))
	d.ellipse([54, 16, 74, 36], outline=MAGENTA + (110,), width=2)
	put(c, x, y)
	# 6/7 cloud streaks
	for idx, col in ((6, MAGENTA), (7, CYAN)):
		c, d, x, y = at(idx)
		for i, (yy, ww, aa) in enumerate(((48, 90, 150), (62, 64, 110), (76, 40, 80))):
			d.rounded_rectangle([20, yy, 20 + ww, yy + 8], radius=4, fill=col + (aa,))
		put(c, x, y)
	# 8 star cluster
	c, d, x, y = at(8)
	for _ in range(14):
		px, py = rng.randrange(16, 112), rng.randrange(16, 112)
		d.ellipse([px, py, px + 2, py + 2], fill=rng.choice((ICE, CYAN)) + (rng.randrange(120, 240),))
	put(c, x, y)
	# 9 meteor streak
	c, d, x, y = at(9)
	d.line([(20, 30), (96, 96)], fill=ICE + (220,), width=3)
	d.line([(26, 26), (86, 78)], fill=CYAN + (120,), width=6)
	d.ellipse([92, 92, 104, 104], fill=ICE + (255,))
	put(c, x, y)
	# 10 horizon glow strip
	c, d, x, y = at(10)
	d.rectangle([0, 58, 128, 66], fill=MAGENTA + (220,))
	d.rectangle([0, 54, 128, 58], fill=lerp3(MAGENTA, ICE, 0.5) + (160,))
	d.rectangle([0, 66, 128, 84], fill=lerp3(MAGENTA, NIGHT0, 0.6) + (140,))
	put(c, x, y)
	# 11 street lamp
	c, d, x, y = at(11)
	d.line([(40, 122), (40, 40), (76, 40)], fill=(110, 120, 150, 255), width=4)
	d.ellipse([70, 36, 86, 50], fill=CYAN + (235,))
	d.polygon([(70, 48), (86, 48), (102, 120), (54, 120)], fill=CYAN + (36,))
	put(c, x, y)
	# 12 billboard
	c, d, x, y = at(12)
	d.rectangle([28, 30, 100, 74], fill=(18, 14, 36, 255), outline=ICE + (200,), width=3)
	d.rectangle([34, 36, 94, 68], fill=lerp3(MAGENTA, PURPLEC, 0.5) + (200,)) if False else d.rectangle([34, 36, 94, 68], fill=(120, 22, 90, 200))
	d.line([(44, 74), (44, 120)], fill=(110, 120, 150, 255), width=4)
	d.line([(84, 74), (84, 120)], fill=(110, 120, 150, 255), width=4)
	put(c, x, y)
	return sheet


PURPLEC = (46, 12, 84)


def main():
	sky = build_sky()
	sky.save(SKY)
	print(f"wrote {SKY} ({sky.size[0]}x{sky.size[1]})")
	sc = build_scenery()
	sc.save(SCENERY)
	build_theme()
	build_none_icon()
	print(f"wrote {SCENERY} ({sc.size[0]}x{sc.size[1]})")
	return 0




def build_theme():
    """Original 'nightdrive' menu theme: day/night maps + icon (BL-16)."""
    import sys as _sys
    _sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
    from map_format import MapWriter, quad_rect
    themes = ROOT / "data" / "themes"
    themes.mkdir(parents=True, exist_ok=True)
    W, H = 64, 36
    for variant, tint in (("day", (255, 255, 255, 255)), ("night", (96, 104, 168, 255))):
        mw = MapWriter()
        mw.version()
        mw.info("The Neon Relay Authors", "1",
                "original Neon Relay menu theme (BL-16)", "Zlib")
        img_sky = mw.image("neonrelay_sky", 2048, 1024)
        img_scn = mw.image("neonrelay_scenery", 1024, 1024)
        deco = bytearray(W * H * 4)
        rng = random.Random(4242)
        for x in range(2, W - 2, 7):
            c = rng.choice((1, 6, 7, 8, 11, 0))
            if c:
                deco[((H - 3) * W + x) * 4] = c
        for x in range(0, W - 12, 15):
            deco[(6 * W + x + 4) * 4] = 6
            deco[(9 * W + x + 9) * 4] = 7
        mw.quads_layer([quad_rect(-2000, -1200, W * 32 * 2 + 2000, H * 32 * 2 + 1200, rgba=tint)],
                       img_sky, "Sky")
        mw.tiles_layer(W, H, bytes(deco), img_scn, flags=0, layer_flags=1, name="Decor")
        mw.group((0, 0), (50, 50), 0, 2, "Background")
        out = themes / f"nightdrive_{variant}.map"
        mw.save(out)
        print(f"wrote {out}")
    sky = Image.open(SKY)
    icon = sky.crop((768, 256, 1280, 768)).resize((128, 128), Image.LANCZOS)
    icon.save(themes / "nightdrive.png")
    print(f"wrote {themes / 'nightdrive.png'}")


def build_none_icon():
    """Original neutral 'no theme' icon (themes/none.png)."""
    img = Image.new("RGBA", (128, 128), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([16, 16, 112, 112], 18, fill=(14, 18, 38, 255),
                        outline=(77, 227, 247, 220))
    d.line([(40, 64), (88, 64)], fill=(126, 140, 172, 220), width=6)
    img.save(ROOT / "data" / "themes" / "none.png")
    print(f"wrote {ROOT / 'data' / 'themes' / 'none.png'}")


if __name__ == "__main__":
	sys.exit(main())
