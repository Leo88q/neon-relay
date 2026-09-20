#!/usr/bin/env python3
"""Original Neon Relay race maps (BL-14).

Generates five original race maps alongside the existing
map, using only original Neon Relay art (neonrelay_sky / neonrelay_scenery /
neonrelay_tiles). Tile ids follow src/game/mapitems.h; entity tiles are
ENTITY_OFFSET + id. Layout rules keep every map solvable with stock
movement: jump rises <= 4 tiles (hook-assistable via 2-tile ledge overlaps),
gaps <= 5 tiles, under-gaps >= 3 tiles, no nohook walls across the route.

  Neon Relay Basin    - balanced intro: pits, platforms, nohook ceiling,
                        teleport shortcut, spike totems, 3 checkpoints
  Chromatic Canyon    - open canyon with wall ledges down to a death river
                        and stepping stones, hook walls back up
  Vector Spire        - zigzag ledge tower climb (rise 4, overlap 2)
  Midnight Circuit    - fast flat run: low walls, hanging nohook curtains,
                        one long death jump
  Aurora Ascent       - rising staircase (rise 3) under an aurora band
"""
import pathlib
import random
import sys
import struct
import math

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from map_format import MapWriter, quad_rect, pack_name  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUTDIR = ROOT / "data" / "maps"

T_AIR, T_SOLID, T_DEATH, T_NOHOOK = 0, 1, 2, 3
T_TELEIN, T_TELEOUT = 26, 27
T_START, T_FINISH, T_CP = 33, 34, 35
ENTITY_SPAWN = 191 + 1


class Grid:
	def __init__(self, w, h):
		self.w, self.h = w, h
		self.g = [[T_AIR] * w for _ in range(h)]

	def rect(self, x0, y0, x1, y1, t):
		for y in range(max(0, y0), min(self.h, y1 + 1)):
			for x in range(max(0, x0), min(self.w, x1 + 1)):
				self.g[y][x] = t

	def set(self, x, y, t):
		if 0 <= x < self.w and 0 <= y < self.h:
			self.g[y][x] = t

	def floor(self, x0, x1, y):
		self.rect(x0, y, x1, self.h - 1, T_SOLID)

	def bytes(self):
		buf = bytearray()
		for y in range(self.h):
			for x in range(self.w):
				buf += bytes((self.g[y][x], 0, 0, 0))
		return bytes(buf)


def decor(gr, seed, spots, high):
	"""spots: {x: row} ground decor; high: [(x, row)] sky props."""
	rng = random.Random(seed)
	g = [[0] * gr.w for _ in range(gr.h)]
	for x, row in spots.items():
		c = rng.choice((1, 6, 7, 8, 11, 0, 0, 3))
		if c and 0 <= x < gr.w and 0 <= row < gr.h:
			g[row][x] = c
	for x, y in high:
		if 0 <= x < gr.w and 0 <= y < gr.h:
			g[y][x] = rng.choice((5, 6, 7, 9, 12))
	buf = bytearray()
	for y in range(gr.h):
		for x in range(gr.w):
			buf += bytes((g[y][x], 0, 0, 0))
	return bytes(buf)


def build_basin():
	W, H, G = 220, 70, 52
	g = Grid(W, H)
	pits = [(38, 44), (78, 86), (128, 134), (168, 176)]
	for x in range(W):
		if any(a <= x <= b for a, b in pits):
			g.rect(x, H - 3, x, H - 1, T_DEATH)
		else:
			g.floor(x, x, G)
	g.rect(92, 18, 126, 21, T_SOLID)
	g.rect(92, 22, 126, 22, T_NOHOOK)
	for a, b in pits:
		mx = (a + b) // 2
		g.rect(mx - 2, G - 6, mx + 2, G - 6, T_SOLID)
	g.rect(148, 34, 162, 35, T_SOLID)
	g.rect(W - 6, G - 10, W - 1, G - 1, T_SOLID)
	for sx in (10, 12, 14):
		g.set(sx, G - 1, ENTITY_SPAWN)
	g.set(18, G - 1, T_START)
	for cx in (60, 110, 155):
		g.set(cx, G - 8, T_CP)
	g.set(96, G - 5, T_TELEIN)
	g.set(150, 33, T_TELEOUT)
	g.set(W - 10, G - 1, T_FINISH)
	for tx in (70, 104):
		g.rect(tx, G - 2, tx, G - 1, T_SOLID)
		g.rect(tx, G - 4, tx, G - 3, T_DEATH)
	spots = {x: G - 2 for x in range(4, W - 4, 9)
		if not any(a - 2 <= x <= b + 2 for a, b in pits)}
	high = [(30, 15), (88, 12), (140, 15), (190, 12), (65, 8), (155, 5)]
	return g, decor(g, 777, spots, high)


def build_canyon():
	W, H = 240, 90
	g = Grid(W, H)
	rim, bed = 30, 78
	g.floor(0, W - 1, rim)
	g.rect(25, rim, W - 26, bed - 1, T_AIR)   # carve the canyon
	g.rect(40, bed - 1, W - 41, bed - 1, T_DEATH)
	for sx in range(46, W - 40, 12):
		g.rect(sx - 2, bed - 3, sx + 2, bed - 2, T_SOLID)
	for y in (42, 54, 66):
		g.rect(25, y, 30, y, T_SOLID)
	for y in range(38, 74, 4):
		g.rect(W - 31, y, W - 26, y, T_SOLID)
	g.rect(70, 50, 76, 50, T_SOLID)
	g.rect(110, 46, 116, 46, T_SOLID)
	g.rect(150, 50, 156, 50, T_SOLID)
	for sx in (6, 8, 10):
		g.set(sx, rim - 1, ENTITY_SPAWN)
	g.set(14, rim - 1, T_START)
	g.set(28, 40, T_CP)
	g.set(113, 44, T_CP)
	g.set(W - 28, 61, T_CP)
	g.set(45, bed - 5, T_TELEIN)
	g.set(160, 45, T_TELEOUT)
	g.set(W - 12, rim - 1, T_FINISH)
	g.rect(W - 16, rim - 3, W - 16, rim - 1, T_DEATH)
	spots = {x: rim - 2 for x in range(4, 22, 7)}
	spots.update({x: bed - 4 for x in range(32, W - 32, 11)})
	high = [(50, 20), (100, 16), (160, 20), (200, 14), (80, 8)]
	return g, decor(g, 31337, spots, high)


def build_spire():
	W, H = 160, 110
	g = Grid(W, H)
	g.floor(0, W - 1, H - 6)
	steps = [(16, 92), (34, 88), (52, 84), (70, 80), (88, 76), (70, 72),
		(52, 68), (34, 64), (16, 60), (34, 56), (52, 52), (70, 48),
		(88, 44), (70, 40), (52, 36), (34, 32), (16, 28), (34, 24), (52, 20)]
	for x, y in steps:
		g.rect(x, y, x + 19, y + 1, T_SOLID)
	for px in (40, 72, 104, 128):
		g.rect(px, H - 7, px + 5, H - 7, T_DEATH)
	g.rect(120, 90, 123, 100, T_NOHOOK)  # side pillar, off-route
	for sx in (6, 8, 10):
		g.set(sx, H - 7, ENTITY_SPAWN)
	g.set(14, H - 7, T_START)
	g.set(24, 90, T_CP)
	g.set(60, 82, T_CP)
	g.set(96, 74, T_CP)
	g.set(60, 66, T_CP)
	g.set(24, 58, T_CP)
	g.set(96, 42, T_CP)
	g.set(96, 78, T_TELEIN)
	g.set(58, 18, T_TELEOUT)
	g.set(66, 19, T_FINISH)
	spots = {x: H - 8 for x in range(4, W - 4, 10)}
	high = [(20, 10), (60, 6), (100, 10), (130, 4), (80, 2)]
	return g, decor(g, 4242, spots, high)


def build_circuit():
	W, H = 260, 56
	g = Grid(W, H)
	G = 40
	g.floor(0, W - 1, G)
	g.rect(70, G, 80, H - 1, T_AIR)
	g.rect(70, H - 2, 80, H - 1, T_DEATH)
	g.rect(74, G - 4, 76, G - 3, T_SOLID)
	for i, px in enumerate(range(100, 200, 16)):
		if i % 2 == 0:
			g.rect(px, G - 2, px + 2, G - 1, T_SOLID)
		else:
			g.rect(px, G - 12, px + 2, G - 4, T_NOHOOK)
	g.rect(W - 5, G - 8, W - 1, G - 1, T_SOLID)
	for sx in (8, 10, 12):
		g.set(sx, G - 1, ENTITY_SPAWN)
	g.set(16, G - 1, T_START)
	for cx in (50, 90, 140, 190, 230):
		g.set(cx, G - 6, T_CP)
	g.set(64, G - 4, T_TELEIN)
	g.set(210, G - 4, T_TELEOUT)
	g.set(W - 9, G - 1, T_FINISH)
	spots = {x: G - 2 for x in range(4, W - 4, 8)}
	high = [(40, 12), (90, 10), (150, 12), (210, 8), (240, 14)]
	return g, decor(g, 9001, spots, high)


def build_ascent():
	W, H = 200, 100
	g = Grid(W, H)
	base = 88
	for i in range(12):
		x0 = 10 + i * 15
		y = base - i * 3
		g.rect(x0, y, x0 + 12, H - 1, T_SOLID)
		if i < 11:
			g.rect(x0 + 13, y + 2, x0 + 14, H - 1, T_DEATH)
	g.rect(0, 6, W - 1, 8, T_SOLID)
	g.rect(0, 9, W - 1, 9, T_NOHOOK)
	for sx in (4, 6, 8):
		g.set(sx, base - 1, ENTITY_SPAWN)
	g.set(12, base - 1, T_START)
	for i, cx in enumerate((40, 85, 130, 170)):
		g.set(cx, base - (cx - 10) // 15 * 3 - 3, T_CP)
	g.set(60, base - 3 * 3 - 1, T_TELEIN)
	g.set(150, base - 3 * 9 - 1, T_TELEOUT)
	g.set(186, base - 3 * 11 - 1, T_FINISH)
	spots = {10 + i * 15 + 4: base - i * 3 - 2 for i in range(12)}
	high = [(30, 14), (80, 12), (130, 14), (170, 12), (100, 4)]
	return g, decor(g, 555, spots, high)


MAPS = [
	("Neon Relay Basin", build_basin, "balanced intro race"),
	("Chromatic Canyon", build_canyon, "canyon hook route over a death river"),
	("Vector Spire", build_spire, "zigzag ledge tower climb"),
	("Midnight Circuit", build_circuit, "fast flat gate slalom"),
	("Aurora Ascent", build_ascent, "staircase climb under an aurora band"),
]


def write_map(name, build, blurb):
	g, deco_b = build()
	mw = MapWriter()
	mw.version()
	mw.info("The Neon Relay Authors", "1",
		f"original Neon Relay map: {blurb} (BL-14, procedural)", "Zlib")
	styles = {"Neon Relay Basin": "sound", "Chromatic Canyon": "folds", "Vector Spire": "circuit", "Midnight Circuit": "chrome", "Aurora Ascent": "folds"}
	style = styles[name]
	img_sky = mw.image(f"neonrelay_{style}_sky", 1536, 768)
	img_mid = mw.image(f"neonrelay_{style}_mid", 1024, 512)
	img_tile = mw.image(f"neonrelay_{style}_tiles", 1024, 1024)
	img_light = mw.image("neonrelay_pulse", 128, 128)
	# lift tele pads out of the game grid into a numbered tele layer
	# (CTeleTile = {number, type}; RenderTelemap draws m_Type from the image)
	tele = bytearray(g.w * g.h * 2)
	for y in range(g.h):
		for x in range(g.w):
			v = g.g[y][x]
			if v in (T_TELEIN, T_TELEOUT):
				tele[(y * g.w + x) * 2] = 1
				tele[(y * g.w + x) * 2 + 1] = v
				g.g[y][x] = T_AIR
	# Static collision data is untouched. Ordinary decorative tiles provide the
	# visible terrain: the engine does not display the game layer as normal art.
	visual = bytearray(g.w*g.h*4)
	light_quads = []
	for y in range(g.h):
		for x in range(g.w):
			v = g.g[y][x]
			idx = 0
			if v in (T_SOLID,T_NOHOOK):
				mask=0
				for dx,dy,bit in [(0,-1,1),(1,0,2),(0,1,4),(-1,0,8)]:
					nx,ny=x+dx,y+dy
					if not (0<=nx<g.w and 0<=ny<g.h) or g.g[ny][nx] not in (T_SOLID,T_NOHOOK): mask |= bit
				idx = (32 if v==T_NOHOOK else 16)+mask
				if v==T_SOLID and style in ("sound","chrome"):
					depth=0
					while depth<9 and y-depth>0 and g.g[y-depth-1][x] in (T_SOLID,T_NOHOOK): depth+=1
					idx=80+depth*16+mask
				if mask&1 and x%8==0:
					q=list(struct.unpack('<38i',quad_rect(x*32-48,y*32-64,x*32+80,y*32+32)))
					q[-2]=0 # shared synchronized color envelope
					light_quads.append(struct.pack('<38i',*q))
			elif v==T_DEATH: idx=64
			elif v==T_START: idx=65
			elif v==T_FINISH: idx=66
			elif v==T_CP: idx=67
			if tele[(y*g.w+x)*2+1]: idx=68 if tele[(y*g.w+x)*2+1]==T_TELEIN else 69
			visual[(y*g.w+x)*4]=idx
	period = 500 if style=="sound" else 4000
	points=[]
	for step in range(17):
		phase=step/16
		strength=(math.exp(-phase*5) if step<16 else 1) if style=="sound" else .5+.5*math.cos(phase*math.tau)
		points += [round(phase*period),1,1024,1024,1024,round(250+strength*500)]
	mw.item(3,[2,4,0,17]+pack_name("Material light",8)+[1])
	mw.item(6,points)
	mw.quads_layer([quad_rect(-1600,-1000,1600,1000)],img_sky,"Atmosphere")
	mw.group((0,0),(0,0),0,1,"Far")
	mw.quads_layer([quad_rect(x,-256,x+1024,256) for x in range(-2048,int(g.w*32*.35)+2048,1024)],img_mid,"Depth")
	mw.group((0,0),(35,0),1,1,"Mid")
	mw.tiles_layer(g.w,g.h,visual,img_tile,name="Materials")
	mw.quads_layer(light_quads,img_light,"Light")
	mw.tiles_layer(g.w, g.h, g.bytes(), img_tile, flags=1, name="Game")
	tele_idx = mw.raw(bytes(tele))
	zero = b"\0" * (g.w * g.h * 4)
	mw.tiles_layer(g.w, g.h, zero, img_tile, flags=2, layer_flags=0, name="Tele", tele=tele_idx)
	mw.group((0, 0), (100, 100), 2, 4, "Game")
	out = OUTDIR / f"{name}.map"
	n = mw.save(out)
	print(f"wrote {out} ({n} bytes, {g.w}x{g.h})")
	return n


def main():
	OUTDIR.mkdir(parents=True, exist_ok=True)
	for name, build, blurb in MAPS:
		write_map(name, build, blurb)
	return 0


if __name__ == "__main__":
	sys.exit(main())
