#!/usr/bin/env python3
"""Verified twmap API bridge/probe. Does not replace existing map generators yet."""
import argparse
import hashlib
from importlib.metadata import metadata, version
import json
from pathlib import Path
import tempfile

import numpy as np
import twmap

from datafile_v4 import read
from map_gameplay_fingerprint import gameplay

ROOT = Path(__file__).resolve().parent.parent
PIN = '0.6.6'
PHYSICS = ('game', 'front', 'tele', 'speedup', 'switch', 'tune')


def require_version():
    if version('twmap') != PIN:
        raise RuntimeError(f'Expected twmap {PIN}; install scripts/requirements-map-tools.txt')


def physics_snapshot(m):
    result = {'settings': list(m.info.settings)}
    for name in PHYSICS:
        layer = getattr(m, name + '_layer')()
        if layer is None:
            result[name] = None
        else:
            tiles = layer.tiles
            result[name] = {'shape': list(tiles.shape), 'dtype': str(tiles.dtype),
                            'sha256': hashlib.sha256(tiles.tobytes()).hexdigest()}
    return result


def roundtrip_probe(source):
    """Temporary output only: production sources are never overwritten."""
    require_version()
    source = Path(source)
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    original = twmap.Map(str(source))
    before = physics_snapshot(original)
    a = read(source)
    with tempfile.TemporaryDirectory(prefix='neon-twmap-probe-') as directory:
        output = Path(directory) / 'roundtrip.map'
        original.save(str(output))
        loaded = twmap.Map(str(output))
        b = read(output)
        api_equal = before == physics_snapshot(loaded)
        # Independent raw-byte game/front/tele/speed/switch/tune + settings check.
        raw_equal = gameplay(source) == gameplay(output)
        extensions = {str(t): {'before': len(a.items.get(t, [])), 'after': len(b.items.get(t, []))}
                      for t in sorted(set(a.items) | set(b.items)) if t >= 0x8000}
        result = {'source': source.name, 'source_sha256': digest,
                  'physics_api_equal': api_equal, 'physics_raw_equal': raw_equal,
                  'byte_identical': source.read_bytes() == output.read_bytes(),
                  'extension_item_counts': extensions, 'physics': before,
                  'visual_equivalence_verified': False, 'native_roundtrip_boot_verified': False}
    if hashlib.sha256(source.read_bytes()).hexdigest() != digest:
        raise RuntimeError('Source changed during probe')
    if not api_equal or not raw_equal:
        raise RuntimeError(f'Gameplay changed during roundtrip: {source}')
    return result


def assign_tiles(layer, tiles):
    """Accept the getter/documented layout, compensating for 0.6.6 Speedup setter.

    Getter: [force, max_speed, id, angle]. Setter: [id, force, max_speed, angle].
    Reorder the WHOLE array, not only edited cells, or existing boosts get corrupted.
    """
    require_version()
    values = np.ascontiguousarray(tiles)
    if layer.kind() == 'Speedup':
        values = np.ascontiguousarray(values[..., [2, 0, 1, 3]])
    layer.tiles = values


def calibration_map():
    """Original technical fixture, NOT a designed/visually playable production level.

    API names/layouts are taken from installed twmap 0.6.6 help(), not guessed.
    Tile IDs are the project's src/game/mapitems.h constants.
    """
    require_version()
    m = twmap.Map.empty('DDNet06')
    m.info.author = 'Neon Relay'
    m.info.credits = 'Original technical I/O fixture; no third-party map or artwork'
    m.info.license = 'CC0-1.0'
    m.info.settings = ['switch_open 1', 'tune_zone 1 gravity 0.4']
    group = m.groups.new_physics()
    group.name = 'Game'
    game = group.layers.new_game(32, 16)
    tiles = game.tiles
    tiles[12:, :, 0] = 1
    tiles[11, 3] = (192, 0)  # ENTITY_OFFSET + ENTITY_SPAWN
    tiles[11, 5] = (33, 0)
    tiles[11, 27] = (34, 0)
    tiles[11, 16:18, 0] = 9
    game.tiles = tiles  # assigning back is required; do not rely on a borrowed view
    for kind in ('Front', 'Tele', 'Speedup', 'Switch', 'Tune'):
        group.layers.new_physics(kind)
    # Entries use the getter/documented layout. assign_tiles handles the setter quirk.
    entries = {
        'front': [(10, 14, (60, 8))],
        'tele': [(11, 20, (1, 26)), (11, 23, (1, 27))],
        'speedup': [(11, 9, (10, 20, 28, 180))],
        'switch': [(11, 12, (1, 23, 0, 2))],
        'tune': [(11, 25, (1, 68))],
    }
    for name, changes in entries.items():
        layer = getattr(m, name + '_layer')()
        array = layer.tiles
        for y, x, value in changes:
            array[y, x] = value
        assign_tiles(layer, array)
    return m


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()
    report = {'twmap_version': version('twmap'), 'package_license': metadata('twmap').get('License'),
              'scope': 'I/O proof only; no production maps overwritten; not a route-completion test',
              'maps': [roundtrip_probe(ROOT / 'data/maps' / (name + '.map')) for name in
                       ('LearnToPlay', 'LearnToPlay Sound', 'LearnToPlay Sound Heights')]}
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / 'calibration.map'
        calibration_map().save(str(path))
        report['original_fixture'] = roundtrip_probe(path)
    text = json.dumps(report, ensure_ascii=False, indent=2) + '\n'
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(text)
    print(text)


if __name__ == '__main__':
    main()
