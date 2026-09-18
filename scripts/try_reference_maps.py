#!/usr/bin/env python3
"""Fetch pinned upstream maps for local evaluation; never install them into data/maps.

No third-party binaries are downloaded. Source maps/settings are not rewritten.
"""
import argparse
import hashlib
import json
import os
import shutil
from pathlib import Path
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
import urllib.error

ROOT = Path(__file__).resolve().parent.parent
CATALOG = ROOT / 'docs/reference_maps/catalog.json'
CACHE = ROOT / '.cache/reference-maps'


def catalog():
    return {row['name']: row for row in json.loads(CATALOG.read_text())}


def fetch(row, cache=CACHE):
    directory = cache / row['name']
    target = directory / 'maps' / (row['name'] + '.map')
    if target.exists():
        data = target.read_bytes()
    else:
        url = 'https://raw.githubusercontent.com/ddnet/ddnet-maps/' + row['revision'] + '/' + urllib.parse.quote(row['source_path'], safe='/')
        try:
            with urllib.request.urlopen(url, timeout=45) as response:
                data = response.read(row['bytes'] + 1)
        except urllib.error.URLError:
            # Some sandboxes block raw.githubusercontent.com but allow the GitHub API.
            if not shutil.which('gh'):
                raise
            endpoint = 'repos/ddnet/ddnet-maps/contents/' + urllib.parse.quote(row['source_path'], safe='/') + '?ref=' + row['revision']
            result = subprocess.run(['gh', 'api', endpoint, '-H', 'Accept: application/vnd.github.raw+json'], capture_output=True, timeout=60)
            if result.returncode:
                raise OSError('GitHub download failed; no files installed')
            data = result.stdout
    if len(data) != row['bytes'] or hashlib.sha256(data).hexdigest() != row['sha256']:
        raise ValueError(f"Source hash/length mismatch: {row['name']}; refusing to load")
    if not data.startswith(b'DATA'):
        raise ValueError('Not a DATA map file')
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as f:
            f.write(data)
            temporary = Path(f.name)
        temporary.replace(target)
    return directory


def server_args(binary, name, port):
    if any(c in name for c in '\n\r";'):
        raise ValueError('Unsafe map name')
    return [str(binary), 'bindaddr 127.0.0.1', f'sv_port {port}', 'sv_register 0',
            'sv_sixup 0', 'sv_dnsbl 0', 'sv_rcon_password ""',
            'sv_rcon_mod_password ""', f'sv_map "{name}"']


def prepare_storage(directory):
    # Do not read the user's normal autoexec_server.cfg, accounts or production config.
    (directory / 'storage.cfg').write_text(f'add_path {directory.resolve()}\nadd_path {ROOT / "data"}\n')
    (directory / 'autoexec_server.cfg').write_text('# Isolated local reference-map trial\n')


def main():
    rows = catalog()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('list', 'fetch', 'server'))
    parser.add_argument('name', nargs='?', choices=sorted(rows))
    parser.add_argument('--cache', type=Path, default=CACHE)
    parser.add_argument('--server-bin', type=Path, default=ROOT / 'build-mac/neonrelay-server')
    parser.add_argument('--port', type=int, default=8304)
    args = parser.parse_args()
    if args.action == 'list':
        for row in rows.values():
            print(f"{row['name']} | {row['category']} {row['stars']}/5 | {row['author_catalog']} | {row['note_ru']}")
        return 0
    if args.name is None:
        parser.error('Specify a map name; start with "Late Evening"')
    if not 1024 <= args.port <= 65535:
        parser.error('Use a non-privileged port between 1024 and 65535')
    if args.action == 'server' and not args.server_bin.resolve().is_file():
        parser.error('Server binary missing; build game-server or pass --server-bin')
    row = rows[args.name]
    missing = [name for name in row['external_images'] if not (ROOT / 'data/mapres' / (name + '.png')).is_file()]
    if missing or row['external_sounds']:
        parser.error(f'Missing images or unsupported external sounds: {missing}, {row["external_sounds"]}')
    directory = fetch(row, args.cache.resolve())
    print(f"Verified source SHA-256: {row['sha256']}", flush=True)
    print('Local evaluation only; license/embedded artwork review remains open.', flush=True)
    if args.action == 'fetch':
        print(directory)
        return 0
    prepare_storage(directory)
    print(f'Connect client to 127.0.0.1:{args.port}; Ctrl+C stops the trial.', flush=True)
    try:
        env = {k: v for k, v in os.environ.items() if not k.startswith('NEONRELAY_')}
        env.update(HOME=str(directory), XDG_CONFIG_HOME=str(directory), XDG_DATA_HOME=str(directory))
        return subprocess.run(server_args(args.server_bin.resolve(), args.name, args.port), cwd=directory, env=env).returncode
    except KeyboardInterrupt:
        return 130


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError) as e:
        sys.exit(str(e))
