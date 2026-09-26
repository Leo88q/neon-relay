#!/usr/bin/env python3
"""Read a shipped .map (datafile v4) far enough to answer "what is actually on this map".

`data/maps/*.map` are datafile v4 containers written by the map editor and streamed by the client.
Nothing in Python could read them back, so the map gallery had to rasterise the *builder's* in-memory
grid instead (`scripts/build_neon_maps.py`) and therefore could only ever show the five maps that
generator knows about — 22 of the 27 shipped maps had no preview at all.

Field order below is `src/game/mapitems.h`, and the upgrade rules are the ones the engine itself
applies when it loads an old item (`CMap::UpgradeAndValidateTilesLayerItem`,
src/engine/shared/map.cpp:455-570): tiles layers exist in four truncations, the map version decides
whether the DDRace physics indices sit at ints 15-19 (v2 legacy) or 18-22 (v3/v4), and any index the
item is too short for reads as -1.

Tile indices are read with the engine's semantics, not a private one: CCollision::IsSolid()
accepts TILE_SOLID(1) and TILE_NOHOOK(3) (collision.cpp:605), death is TILE_DEATH(2), and every
index at or above ENTITY_OFFSET(191) is an entity numbered `index - ENTITY_OFFSET`
(CGameContext::CreateAllEntities, gamecontext.cpp:4382). Race markings live in the switch layer
(TILE_START 33, TILE_FINISH 34, TILE_CP 64, time checkpoints 35-59).

Usage:  scripts/neon_mapread.py data/maps/*.map          # JSON facts per map
        from neon_mapread import read_map; read_map("data/maps/dm1.map").facts()
"""
import argparse
import json
import struct
import zlib
from pathlib import Path

# MAPITEMTYPE_* (src/game/mapitems.h:26)
VERSION, INFO, IMAGE, ENVELOPE, GROUP, LAYER, ENVPOINTS, SOUND = range(8)
# LAYERTYPE_* (src/game/mapitems.h:10)
LT_INVALID, LT_GAME, LT_TILES, LT_QUADS, LT_FRONT, LT_TELE, LT_SPEEDUP, LT_SWITCH, LT_TUNE = range(9)
LT_SOUNDS_DEPRECATED, LT_SOUNDS = 9, 10
TILE_LAYER_TYPES = (LT_TILES, LT_FRONT, LT_TELE, LT_SPEEDUP, LT_SWITCH, LT_TUNE)
# TILESLAYERFLAG_* (src/game/mapitems.h:244) - at most one of these is set per layer
F_GAME, F_TELE, F_SPEEDUP, F_FRONT, F_SWITCH, F_TUNE = (1 << i for i in range(6))

# Tile ids, same table as the game layer in mapitems.h:124-175.
TILE_AIR, TILE_SOLID, TILE_DEATH, TILE_NOHOOK = 0, 1, 2, 3
TILE_NOLASER, TILE_THROUGH_CUT, TILE_THROUGH = 4, 5, 6
TILE_FREEZE, TILE_TELEINEVIL, TILE_UNFREEZE = 9, 10, 11
TILE_DFREEZE, TILE_DUNFREEZE = 12, 13
TILE_TELEIN, TILE_TELEOUT = 26, 27
TILE_SPEED_BOOST = 29
TILE_TELECHECK, TILE_TELECHECKOUT, TILE_TELECHECKIN = 29, 30, 31
TILE_REFILL_JUMPS = 32
TILE_START, TILE_FINISH = 33, 34
TILE_TIME_FIRST, TILE_TIME_LAST = 35, 59
TILE_STOP, TILE_STOPS, TILE_STOPA = 60, 61, 62
TILE_CP, TILE_CP_F = 64, 65
TILE_TUNE = 68
ENTITY_OFFSET = 191

# ENTITY_* (src/game/mapitems.h:53-116), i.e. what a game layer index above ENTITY_OFFSET means.
ENTITY_NAMES = {
    0: "null", 1: "spawn", 2: "spawn_red", 3: "spawn_blue", 4: "flag_red", 5: "flag_blue",
    6: "armor", 7: "health", 8: "shotgun", 9: "grenade", 10: "ninja", 11: "laser",
    12: "laser_fast_ccw", 13: "laser_normal_ccw", 14: "laser_slow_ccw", 15: "laser_stop",
    16: "laser_slow_cw", 17: "laser_normal_cw", 18: "laser_fast_cw", 19: "laser_short",
    20: "laser_medium", 21: "laser_long", 29: "plasma_e", 30: "plasma_f", 31: "plasma_u",
    33: "dragger", 34: "gun", 35: "gun_e", 36: "gun_f", 37: "light", 38: "pickup_light",
    49: "door",
}
PICKUPS = ("shotgun", "grenade", "laser", "ninja", "armor", "health")
ENTITY_PREFIXES = ("laser", "plasma", "gun", "dragger", "door", "light")


class TileArray:
    """One tiles layer: the index byte per cell, plus the flags byte stored next to it."""

    def __init__(self, width, height, data, stride=4, index_at=0, flags_at=1):
        self.width, self.height = width, height
        self.data, self.stride, self.index_at, self.flags_at = data, stride, index_at, flags_at

    def index(self, x, y):
        return self.data[(y * self.width + x) * self.stride + self.index_at]

    def flags(self, x, y):
        return self.data[(y * self.width + x) * self.stride + self.flags_at]

    def count(self, *wanted):
        want = set(wanted)
        return sum(1 for i in range(self.index_at, len(self.data), self.stride) if self.data[i] in want)

    def histogram(self):
        hist = {}
        for i in range(self.index_at, len(self.data), self.stride):
            v = self.data[i]
            hist[v] = hist.get(v, 0) + 1
        return hist


class Layer:
    """A layer item. Quads layers keep their quad count; tiles layers decode their tile arrays."""

    def __init__(self, index, payload, raws):
        self.index = index
        self.raw = payload
        self.layer_version, self.layer_type, self.layer_flags = payload[0], payload[1], payload[2]
        self.map_version = payload[3] if len(payload) > 3 else 0
        self.name = ""
        self.width = self.height = 0
        self.flags = 0
        self.image = self.data_index = -1
        self.num_quads = 0
        self.tiles = self.tele = self.speedup = self.switch = None
        if self.layer_type == LT_QUADS:
            self.num_quads, self.data_index, self.image = payload[4], payload[5], payload[6]
            self.name = _ints_to_str(payload[7:10]) if len(payload) >= 10 else ""
            return
        if self.layer_type not in TILE_LAYER_TYPES or len(payload) < 15:
            # Sound layers, or an item older than CMapItemLayerTilemap_v2. The engine rejects both
            # for physics, and so do we: keep the header, decode nothing.
            return
        # CMapItemLayerTilemap (mapitems.h:477): the v2 prefix is always present at this point.
        self.width, self.height, self.flags = payload[4], payload[5], payload[6]
        self.image, self.data_index = payload[13], payload[14]
        if self.map_version >= 3 and len(payload) >= 18:
            self.name = _ints_to_str(payload[15:18])
        physics = {}
        for flag, name, at_v2_legacy, at_v3 in ((F_TELE, "tele", 15, 18), (F_SPEEDUP, "speedup", 16, 19),
                                                (F_FRONT, "front", 17, 20), (F_SWITCH, "switch", 18, 21),
                                                (F_TUNE, "tune", 19, 22)):
            at = at_v2_legacy if self.map_version == 2 else at_v3
            physics[name] = payload[at] if len(payload) > at else -1
        self.tele_index, self.speedup_index = physics["tele"], physics["speedup"]
        self.front_index, self.switch_index, self.tune_index = physics["front"], physics["switch"], physics["tune"]
        self.decode(raws)

    def decode(self, raws):
        if self.layer_type not in TILE_LAYER_TYPES or self.width < 2:
            return
        self.tiles = TileArray(self.width, self.height, raws[self.data_index])
        if self.flags & F_FRONT and self.front_index >= 0:
            self.tiles = TileArray(self.width, self.height, raws[self.front_index])
        if self.flags & F_TELE and self.tele_index >= 0:
            self.tele = TileArray(self.width, self.height, raws[self.tele_index], stride=2, index_at=1)
        if self.flags & F_SPEEDUP and self.speedup_index >= 0:
            self.speedup = TileArray(self.width, self.height, raws[self.speedup_index], stride=6)
        if self.flags & F_SWITCH and self.switch_index >= 0:
            self.switch = TileArray(self.width, self.height, raws[self.switch_index])


def _ints_to_str(ints):
    if not ints:
        return ""
    raw = bytearray()
    for v in ints:
        raw += struct.pack(">i", v)
    return bytes((b - 128) % 256 for b in raw).split(b"\0")[0].decode("utf-8", "replace")


def _raw_str(raws, index):
    if index is None or index < 0 or index >= len(raws):
        return ""
    return raws[index].split(b"\0")[0].decode("utf-8", "replace")


class MapFile:
    def __init__(self, path):
        self.path = Path(path)
        self.items = []   # (type, id, payload ints)
        self.raws = []
        self.layers = []
        self.groups = []
        self.images = []
        self.info = {}
        self._parse()

    def _parse(self):
        b = self.path.read_bytes()
        magic, version, size, swaplen, ntypes, nitems, nraw, items_size, data_size = \
            struct.unpack_from("<4s8i", b)
        if magic != b"DATA" or version != 4:
            raise ValueError(f"{self.path.name}: not a datafile v4 ({magic!r} v{version})")
        pos = 36 + ntypes * 12
        item_offsets = struct.unpack_from(f"<{nitems}i", b, pos)
        pos += nitems * 4
        raw_offsets = struct.unpack_from(f"<{nraw}i", b, pos)
        pos += nraw * 8
        item_start = pos
        raw_start = item_start + items_size
        self.raws = [zlib.decompress(b[raw_start + o:raw_start + (raw_offsets[i + 1] if i + 1 < nraw else data_size)])
                     for i, o in enumerate(raw_offsets)]
        for o in item_offsets:
            tag, nbytes = struct.unpack_from("<Ii", b, item_start + o)
            payload = struct.unpack_from(f"<{nbytes // 4}i", b, item_start + o + 8)
            self.items.append((tag >> 16, tag & 0xFFFF, payload))
        for itype, _iid, p in self.items:
            if itype == INFO:
                self.info = {"author": _raw_str(self.raws, p[1]), "version": _raw_str(self.raws, p[2]),
                             "credits": _raw_str(self.raws, p[3]), "license": _raw_str(self.raws, p[4])}
            elif itype == IMAGE:
                self.images.append({"name": _raw_str(self.raws, p[4]), "w": p[1], "h": p[2], "external": p[3]})
            elif itype == GROUP:
                self.groups.append({"offset": (p[1], p[2]), "parallax": (p[3], p[4]),
                                    "start_layer": p[5], "num_layers": p[6],
                                    "name": _ints_to_str(p[12:15]) if len(p) >= 15 else ""})
            elif itype == LAYER:
                self.layers.append(Layer(len(self.layers), p, self.raws))

    # -- queries -------------------------------------------------------------
    def physics_layer(self, flag):
        for l in self.layers:
            if l.flags & flag:
                return l
        return None

    @property
    def game(self):
        layer = self.physics_layer(F_GAME)
        return layer.tiles if layer else None

    def entities(self):
        """Entity number -> count, read from the game layer exactly like CreateAllEntities does."""
        game = self.game
        found = {}
        if game is None:
            return found
        for number in game.histogram():
            if number >= ENTITY_OFFSET:
                found[number - ENTITY_OFFSET] = game.histogram()[number]
        return found

    def facts(self):
        game = self.game
        ents = self.entities()
        switch = self.physics_layer(F_SWITCH)
        st = switch.switch if switch else None
        front = self.physics_layer(F_FRONT)
        tele = self.physics_layer(F_TELE)
        speed = self.physics_layer(F_SPEEDUP)
        quads = sum(l.num_quads for l in self.layers if l.layer_type == LT_QUADS)
        f = {
            "file": self.path.name,
            "bytes": self.path.stat().st_size,
            "width": game.width if game else 0,
            "height": game.height if game else 0,
            "solid": game.count(TILE_SOLID, TILE_NOHOOK) if game else 0,
            "death": game.count(TILE_DEATH) if game else 0,
            "nohook": game.count(TILE_NOHOOK) if game else 0,
            "nol_aaser": game.count(TILE_NOLASER) if game else 0,
            "through": game.count(TILE_THROUGH_CUT, TILE_THROUGH) if game else 0,
            "layers": len(self.layers),
            "quads": quads,
            "groups": len(self.groups),
            "images": [i["name"] for i in self.images if i["name"]],
            "license": self.info.get("license", ""),
            "credits": self.info.get("credits", ""),
            "author": self.info.get("author", ""),
        }
        f["spawns"] = sum(ents.get(n, 0) for n in (1, 2, 3))
        f["entities"] = {ENTITY_NAMES.get(k, f"entity_{k}"): v for k, v in sorted(ents.items())}
        for name in PICKUPS:
            f[name] = sum(v for k, v in ents.items() if ENTITY_NAMES.get(k) == name)
        f["hazards"] = sum(v for k, v in ents.items()
                          if ENTITY_NAMES.get(k, "").startswith(ENTITY_PREFIXES))
        # Race markings normally live in the switch layer. The five original Neon Relay maps keep
        # them in the game layer instead (they are drawn from one semantic grid, build_neon_maps.py
        # T_START/T_FINISH/T_CP), so both layers are counted and the switch layer wins on a tie.
        gs = game.count if game else (lambda *a: 0)
        f["race"] = {
            "start": max(st.count(TILE_START) if st else 0, gs(TILE_START)),
            "finish": max(st.count(TILE_FINISH) if st else 0, gs(TILE_FINISH)),
            # TILE_CP lives in the switch layer on race maps; the fork's own builders use 35 there
            # (scripts/build_neon_maps.py T_CP), which is the same number as the first time
            # checkpoint, so both are accepted and the larger count wins.
            "cp": max(st.count(TILE_CP) if st else 0, gs(TILE_CP), gs(TILE_TIME_FIRST)),
            "cp_f": st.count(TILE_CP_F) if st else 0,
            "time_cp": st.count(*range(TILE_TIME_FIRST, TILE_TIME_LAST + 1)) if st else 0,
            "tele": (st.count(TILE_TELEIN, TILE_TELEOUT) if st else 0) + gs(TILE_TELEIN, TILE_TELEOUT),
            "boost": st.count(TILE_SPEED_BOOST) if st else 0,
            "jumps": st.count(TILE_REFILL_JUMPS) if st else 0,
            "freeze": st.count(TILE_FREEZE, TILE_DFREEZE) if st else 0,
            "unfreeze": st.count(TILE_UNFREEZE, TILE_DUNFREEZE) if st else 0,
            "stop": st.count(TILE_STOP, TILE_STOPS, TILE_STOPA) if st else 0,
            "tune": st.count(TILE_TUNE) if st else 0,
        }
        f["front_death"] = front.tiles.count(TILE_DEATH, TILE_TELEINEVIL) if front and front.tiles else 0
        f["layer_tele"] = tele.tele.count(1, 2) if tele and tele.tele else 0
        f["speedup_tiles"] = sum(1 for i in range(speed.speedup.index_at, len(speed.speedup.data),
                                                  speed.speedup.stride) if speed.speedup.data[i]) if speed and speed.speedup else 0
        f["dm_ready"] = f["spawns"] >= 2
        f["race_ready"] = f["race"]["start"] > 0 and f["race"]["finish"] > 0
        f["tileset"] = next((i["name"] for i in self.images if "tiles" in i["name"].lower()),
                            self.images[0]["name"] if self.images else "")
        return f


def read_map(path):
    return MapFile(path)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("maps", nargs="+", help="one or more .map files")
    args = ap.parse_args()
    for m in args.maps:
        print(json.dumps(read_map(m).facts(), ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
