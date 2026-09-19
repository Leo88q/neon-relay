#!/usr/bin/env python3
"""Two connected native clients + compile-time input-only server driver.

Tests combat on a small deterministic fixture, then entry on the real arena.
Not a manual playtest, load test or proof of visual quality. Never ships driver.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time

import numpy as np
import twmap
from twmap_pipeline import assign_tiles, require_version

ROOT = Path(__file__).resolve().parent.parent
MARKERS = ['SPAWN', 'GUN_KILL', 'RESPAWN', 'RETURN_HIT', 'PICKUPS',
           'SHARED_PICKUP_HIDDEN', 'PICKUP_RESPAWN', 'LASER_KILL_GAMEOVER']
BATTLE_PASS = 'PASS: native gun and laser kills, frags, timed respawn, shared pickups, ammo and round restart'
ARENA_PASS = 'PASS: two native clients entered Chrome DM arena'


def fixture(path):
    require_version()
    m = twmap.Map.empty('DDNet06')
    m.info.author = 'The Neon Relay Authors'
    m.info.license = 'Zlib'
    m.info.version = 'dm-probe-1'
    g = m.groups.new_physics()
    layer = g.layers.new_game(40, 16)
    tiles = np.zeros((16, 40, 2), dtype=np.uint8)
    tiles[12:, :, 0] = 1
    tiles[0, :, 0] = 1
    tiles[:, 0, 0] = tiles[:, -1, 0] = 1
    tiles[11, 5, 0] = tiles[11, 12, 0] = 192
    for x, tile in [(30,198),(31,197),(32,199),(33,200),(34,202)]:
        tiles[11, x, 0] = tile
    assign_tiles(layer, tiles)
    m.save(str(path))


def safe(text):
    return '\n'.join(line for line in text.splitlines() if not any(word in line.lower() for word in ('password','token','secret','rcon')))


def scenario(client, server, name, marker, output):
    with tempfile.TemporaryDirectory(prefix='neon-dm-proof-') as tmp:
        home = Path(tmp)
        (home/'maps').mkdir()
        if name == 'Neon DM Fixture':
            fixture(home/'maps'/f'{name}.map')
        else:
            shutil.copyfile(ROOT/'docs/dm'/f'{name}.map',home/'maps'/f'{name}.map')
        def profile(directory):
            directory.mkdir(exist_ok=True)
            (directory/'storage.cfg').write_text(f'add_path {directory}\nadd_path {home}\nadd_path {ROOT / "data"}\n')
            for f in ('autoexec.cfg','autoexec_server.cfg'):
                (directory/f).write_text('# Isolated native DM proof\n')
        profile(home)
        env = {k:v for k,v in os.environ.items() if not k.startswith('NEONRELAY_')}
        env.update(HOME=tmp,XDG_CONFIG_HOME=tmp,XDG_DATA_HOME=tmp,LIBGL_ALWAYS_SOFTWARE='1')
        with socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as sock:
            sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
        processes=[];handles=[];slog=home/'server.log'
        def logs():
            return slog.read_text(errors='replace') if slog.exists() else ''
        def wait(predicate, seconds, label):
            end=time.monotonic()+seconds
            while not predicate():
                assert all(p.poll() is None for p in processes), f'process exited: {label}'
                assert 'FAIL stage=' not in logs(), safe(logs())[-3500:]
                assert time.monotonic()<end, f'timeout: {label}\n{safe(logs())[-2500:]}'
                time.sleep(.1)
        try:
            sf=slog.open('w');handles.append(sf)
            args=[server,'bindaddr 127.0.0.1',f'sv_port {port}','sv_register 0','sv_sixup 0','sv_dnsbl 0',
                  'sv_test_cmds 0','sv_practice_by_default 0','sv_neonrelay_signing 0','sv_use_sql 0',
                  'sv_solo_server 0','sv_hit 1','sv_gametype neon-dm','sv_neon_dm_score_limit 2',
                  'sv_neon_dm_time_limit 0',f'sv_map "{name}"','sv_sqlite_file dm-proof.sqlite']
            processes.append(subprocess.Popen(args,cwd=home,env={**env,'NEONRELAY_DM_PROBE':'1'},stdout=sf,stderr=subprocess.STDOUT))
            wait(lambda:'server name is' in logs(),30,'server boot')
            for index, who in enumerate(('DmProbeA','DmProbeB')):
                directory=home/who;profile(directory)
                cf=(directory/'client.log').open('w');handles.append(cf)
                ce={**env,'HOME':str(directory),'XDG_CONFIG_HOME':str(directory),'XDG_DATA_HOME':str(directory)}
                processes.append(subprocess.Popen([client,'gfx_fullscreen 0','gfx_vsync 0',
                    'gfx_screen_width 1000','gfx_screen_height 700','cl_show_welcome 0','cl_skip_start_menu 1',
                    f'player_name {who}',f'connect 127.0.0.1:{port}'],cwd=directory,env=ce,stdout=cf,stderr=subprocess.STDOUT))
                # Keep the two native connections distinguishable and let each join.
                wait(lambda:logs().count('player has entered the game.') >= index + 1,30,f'join {who}')
            wait(lambda:marker in logs(),160,'combat proof' if name=='Neon DM Fixture' else 'arena entry')
            if name=='Neon DM Fixture':
                for stage in MARKERS:
                    assert f'{stage} tick=' in logs(),stage
            else:
                # Root capture documents the native session; visual review is a
                # separate action, never inferred from successful PNG creation.
                subprocess.run(['import','-window','root',str(output/'neon-dm-native.png')],check=True,timeout=15)
            return hashlib.sha256((home/'maps'/f'{name}.map').read_bytes()).hexdigest()
        finally:
            for process in reversed(processes):
                if process.poll() is None:
                    process.terminate()
                    try:process.wait(timeout=5)
                    except subprocess.TimeoutExpired:process.kill();process.wait()
            for h in handles:h.close()
            tag='fixture' if name=='Neon DM Fixture' else 'arena'
            text=safe(logs());(output/f'dm-{tag}-server.log').write_text(text+'\n')
            for who in ('DmProbeA','DmProbeB'):
                f=home/who/'client.log'
                if f.exists():(output/f'dm-{tag}-{who}.log').write_text(safe(f.read_text(errors='replace'))+'\n')
            print(text[-3500:])


def main():
    client,server=(str(Path(p).resolve(strict=True)) for p in sys.argv[1:3])
    output=Path(sys.argv[3]).resolve();output.mkdir(parents=True,exist_ok=True)
    fixture_sha=scenario(client,server,'Neon DM Fixture',BATTLE_PASS,output)
    arena_sha=scenario(client,server,'Neon Relay Chrome DM Study',ARENA_PASS,output)
    evidence={'method':'two native clients; compile-time input-only driver; actual server physics/combat',
              'fixture_sha256':fixture_sha,'arena_sha256':arena_sha,'battle_fixture_verified':True,
              'two_client_arena_entry_verified':True,'manual_playthrough_verified':False,
              'visual_review_performed':False,'load_test_performed':False,'platform':'Linux / Xvfb',
              'markers':MARKERS+[BATTLE_PASS,ARENA_PASS]}
    (output/'neon-dm-native-proof.json').write_text(json.dumps(evidence,indent=2)+'\n')
    # Durable CI annotation even when artifact blob transport is unavailable.
    print('::notice title=Neon DM native::'+BATTLE_PASS+'; '+ARENA_PASS)


if __name__=='__main__':main()
