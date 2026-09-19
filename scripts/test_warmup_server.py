#!/usr/bin/env python3
"""Real connected client + test-instrumented server + isolated SQLite results.

The compile-time driver supplies player input only. CCharacter/teams/score
perform movement, return, timer and finish handling. No test commands/teleports.
"""
import hashlib
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parent.parent


def races(path):
    if not path.is_file():
        return []
    try:
        with sqlite3.connect(path, timeout=1) as db:
            tables=[row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")]
            table=next((t for t in tables if t.endswith('_race') and t.replace('_','').isalnum()),None)
            if not table:
                return []
            return list(db.execute(f'SELECT Time FROM "{table}" WHERE Map=? AND Name=? ORDER BY Time',
                ('Neon Relay Warmup','WarmupProbe')))
    except sqlite3.OperationalError:
        return []


def main():
    client,server=(str(Path(p).resolve(strict=True)) for p in sys.argv[1:3])
    out=Path(sys.argv[3]);out.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='warmup-server-') as tmp:
        home=Path(tmp)
        (home/'storage.cfg').write_text(f'add_path {home}\nadd_path {ROOT / "data"}\n')
        for name in ('autoexec.cfg','autoexec_server.cfg'):
            (home/name).write_text('# Isolated Warmup server proof\n')
        env={k:v for k,v in os.environ.items() if not k.startswith('NEONRELAY_')}
        env.update(HOME=tmp,XDG_CONFIG_HOME=tmp,XDG_DATA_HOME=tmp,LIBGL_ALWAYS_SOFTWARE='1')
        with socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as sock:
            sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
        processes=[]
        slog=home/'server.log';clog=home/'client.log';db=home/'warmup.sqlite'
        def logs():
            return slog.read_text(errors='replace') if slog.exists() else ''
        def wait(predicate, seconds, label):
            deadline=time.monotonic()+seconds
            while not predicate():
                assert all(p.poll() is None for p in processes),f'process exited: {label}'
                assert time.monotonic()<deadline,f'timeout: {label}'
                time.sleep(.1)
        try:
            with slog.open('w') as sf,clog.open('w') as cf:
                sv=subprocess.Popen([server,'bindaddr 127.0.0.1',f'sv_port {port}',
                    'sv_register 0','sv_sixup 0','sv_dnsbl 0','sv_test_cmds 0',
                    'sv_sqlite_file warmup.sqlite','sv_save_worse_scores 1',
                    'sv_map "Neon Relay Warmup"'],cwd=tmp,
                    env={**env,'NEONRELAY_WARMUP_PROBE':'1'},stdout=sf,stderr=subprocess.STDOUT)
                processes.append(sv)
                wait(lambda:"server name is" in logs(),30,'server initialization')
                cl=subprocess.Popen([client,'gfx_fullscreen 0','gfx_vsync 0',
                    'gfx_screen_width 1200','gfx_screen_height 760','cl_show_welcome 0',
                    'player_name WarmupProbe',f'connect 127.0.0.1:{port}'],cwd=tmp,
                    env=env,stdout=cf,stderr=subprocess.STDOUT)
                processes.append(cl)
                wait(lambda:'PASS: two finishes' in logs(),240,'two races and all checkpoint returns')
                wait(lambda:len(races(db))>=2,30,'two persistent race results')
                text=logs()
                assert 'FAIL:' not in text
                for run in (1,2):
                    assert f'START run={run}' in text and f'FINISH run={run}' in text
                for pit in range(1,7):
                    assert f'RETURN pit={pit} checkpoint={1 if pit<=3 else 2}' in text
                times=[row[0] for row in races(db)]
                assert len(times)==2 and 0<times[0]<times[1],times
                evidence={
                    'map_sha256':hashlib.sha256((ROOT/'data/maps/Neon Relay Warmup.map').read_bytes()).hexdigest(),
                    'method':'Connected native client; compile-time input driver; real CCharacter and SQLite',
                    'server_race_completion_verified':True,
                    'server_checkpoint_relocation_verified':True,
                    'restart_timer_verified':True,'return_cases':6,
                    'sqlite_finish_times_seconds':times,
                    'manual_client_playthrough_verified':False,
                }
                (out/'warmup-server-proof.json').write_text(json.dumps(evidence,indent=2)+'\n')
                print('PASS: real server Warmup races and SQLite results: '+json.dumps(evidence))
        finally:
            for p in reversed(processes):
                if p.poll() is None:
                    p.terminate()
                    try:p.wait(timeout=5)
                    except subprocess.TimeoutExpired:p.kill();p.wait()
            # Never publish auto-generated rcon credentials with evidence.
            safe='\n'.join(line for line in logs().splitlines() if 'password' not in line.lower())
            (out/'warmup-server.log').write_text(safe+'\n')
            print(safe[-4500:])


if __name__=='__main__':main()
