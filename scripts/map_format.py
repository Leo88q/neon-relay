#!/usr/bin/env python3
"""Minimal datafile (.map) writer for original Neon Relay maps (BL-14).

Implements the datafile v4 layout used by src/engine/shared/datafile.cpp:

  header: "DATA", version=4, size, swaplen, num_item_types, num_items,
          num_raw_data, item_size, data_size
  then:   CDatafileItemType[num_item_types]      (type, start_id, count)
          int item_offsets[num_items]            (bytes from item start)
          int data_offsets[num_raw_data]     (bytes from data start)
          int data_sizes[num_raw_data]           (uncompressed sizes)
          item region (item_size bytes): per item int typeAndId + int payload_size + payload
          data region: zlib-compressed raw blocks, concatenated

Item structs follow src/game/mapitems.h field order. Little-endian on disk.
Only what original Neon Relay maps need is emitted: version, info(settings),
images (external), groups, tiles layers and one quad layer for the sky.
"""
import struct
import zlib

TILE = 4  # sizeof(CTile)


def pack_name(name, num_ints=3):
	b = name.encode("utf-8")[:num_ints*4-1].ljust(num_ints*4, b"\0")
	b = bytes((v + 128) % 256 for v in b)
	b = b[:-1] + b"\0"
	return [struct.unpack(">i", b[i:i + 4])[0] for i in range(0,num_ints*4,4)]


class Raw:
	def __init__(self, payload: bytes):
		self.payload = payload


class MapWriter:
	def __init__(self):
		self.raws = []          # bytes payloads
		self.items = {}         # type -> list of (id, [ints])
		self._next_id = {}

	def raw(self, payload: bytes) -> int:
		self.raws.append(payload)
		return len(self.raws) - 1

	def string(self, s: str) -> int:
		return self.raw(s.encode("utf-8") + b"\0")

	def item(self, type_id: int, payload):
		i = self._next_id.get(type_id, 0)
		self.items.setdefault(type_id, []).append((i, payload))
		self._next_id[type_id] = i + 1
		return i

	# -- convenience builders ------------------------------------------------
	def version(self):
		self.item(0, [1])

	def info(self, author, version, credits, license_):
		self.item(1, [1, self.string(author), self.string(version),
			self.string(credits), self.string(license_), -1])

	def image(self, name, w, h):
		return self.item(2, [1, w, h, 1, self.string(name), -1])

	def group(self, offset, parallax, start_layer, num_layers, name=""):
		self.item(4, [3, offset[0], offset[1], parallax[0], parallax[1],
			start_layer, num_layers, 0, 0, 0, 0, 0] + pack_name(name))

	def tiles_layer(self, w, h, tiles, image, flags=0, layer_flags=0, name="", tele=-1):
		data = self.raw(bytes(tiles))
		self.item(5, [2, 2, layer_flags, 3, w, h, flags, 255, 255, 255, 255,
			-1, 0, image, data] + pack_name(name) + [tele, -1, -1, -1, -1])

	def quads_layer(self, quads, image, name=""):
		buf = b"".join(quads)
		data = self.raw(buf)
		self.item(5, [2, 3, 0, 2, len(quads), data, image] + pack_name(name))

	# -- serialization -------------------------------------------------------
	def save(self, path):
		# flatten items: sorted by type, then id
		flat = []
		for t in sorted(self.items):
			for i, payload in sorted(self.items[t]):
				flat.append((t, i, payload))
		item_bytes = b""
		offsets = []
		for t, i, payload in flat:
			offsets.append(len(item_bytes))
			item_bytes += struct.pack("<Ii", (t << 16) | i, len(payload) * 4)
			item_bytes += struct.pack("<%di" % len(payload), *payload)
		item_size = len(item_bytes)

		comp = [zlib.compress(r, 9) for r in self.raws]
		data_offsets = [0]
		for c in comp:
			data_offsets.append(data_offsets[-1] + len(c))
		data_blob = b"".join(comp)
		data_sizes = [len(r) for r in self.raws]

		types = []
		start = 0
		for t in sorted(self.items):
			types.append((t, start, len(self.items[t])))
			start += len(self.items[t])
		ntypes = len(types)
		nitems = len(flat)
		nraw = len(self.raws)
		swaplen = 36 - 16 + ntypes * 12 + nitems * 4 + nraw * 8 + item_size
		size = swaplen + len(data_blob)

		out = bytearray()
		out += b"DATA"
		out += struct.pack("<iiiiiii", 4, size, swaplen, ntypes, nitems, nraw, item_size)
		out += struct.pack("<i", len(data_blob))
		for t, s, c in types:
			out += struct.pack("<iii", t, s, c)
		for o in offsets:
			out += struct.pack("<i", o)
		for o in data_offsets[:-1]:
			out += struct.pack("<i", o)
		for s in data_sizes:
			out += struct.pack("<i", s)
		out += item_bytes
		out += data_blob
		with open(path, "wb") as f:
			f.write(bytes(out))
		return len(out)


def quad_rect(x0, y0, x1, y1, rgba=(255, 255, 255, 255)):
	"""One CQuad covering the rect (map pixels), texcoords 0..1, 22.10 fixed."""
	f = 1024
	pts = [(x0, y0), (x1, y0), (x0, y1), (x1, y1)]
	cx = sum(p[0] for p in pts) // 4
	cy = sum(p[1] for p in pts) // 4
	out = []
	for x, y in pts + [(cx, cy)]:
		out += [x * f, y * f]
	for _ in range(4):
		out += list(rgba)
	tex = [(0, 0), (1, 0), (0, 1), (1, 1)]
	for u, v in tex:
		out += [u * f, v * f]
	out += [-1, 0, -1, 0]
	return struct.pack("<%di" % len(out), *out)
