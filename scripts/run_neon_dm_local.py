#!/usr/bin/env python3
"""Start experimental Neon DM on loopback, with an isolated temporary profile.

Requires a freshly built server that contains the opt-in controller. Does not
change packaged maps, default config, user profiles, lobby cards or rewards.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent
MAP_NAME = 'Neon Relay Chrome DM Study'


def server_args(server, port):
    return [str(server), 'bindaddr 127.0.0.1', f'sv_port {port}',
            'sv_register 0', 'sv_sixup 0', 'sv_dnsbl 0',
            'sv_gametype neon-dm', f'sv_map "{MAP_NAME}"',
            'sv_name Neon Relay local DM test', 'sv_test_cmds 0',
            'sv_ddrace_tune_reset 0', 'sv_solo_server 0', 'sv_team 0',
            'sv_hit 1', 'sv_endless_drag 0', 'sv_old_laser 0',
            'sv_practice 0', 'sv_practice_by_default 0', 'sv_rescue 0',
            'sv_neonrelay_signing 0', 'sv_neonrelay_reward_per_match_micro 0',
            'sv_use_sql 0', 'sv_sqlite_file dm-local.sqlite',
            'sv_neon_dm_score_limit 20', 'sv_neon_dm_time_limit 10']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('server', type=Path, help='Freshly built neonrelay-server binary')
    parser.add_argument('--port', type=int, default=8306)
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error('port must be between 1024 and 65535')
    server = args.server.resolve(strict=True)
    if not server.is_file() or not os.access(server, os.X_OK):
        parser.error('server must be an executable file')
    source = ROOT / 'docs/dm' / (MAP_NAME + '.map')
    expected = json.loads((ROOT / 'docs/dm/CHROME_STUDY.json').read_text())['output_sha256']
    if hashlib.sha256(source.read_bytes()).hexdigest() != expected:
        raise RuntimeError('Experimental map differs from its evidence record')
    with tempfile.TemporaryDirectory(prefix='neon-dm-local-') as tmp:
        home = Path(tmp)
        (home / 'maps').mkdir()
        shutil.copyfile(source, home / 'maps' / source.name)
        (home / 'storage.cfg').write_text(f'add_path {home}\nadd_path {ROOT / "data"}\n')
        for name in ('autoexec.cfg', 'autoexec_server.cfg'):
            (home / name).write_text('# Isolated, temporary Neon DM profile\n')
        env = {k:v for k,v in os.environ.items() if not k.startswith('NEONRELAY_')}
        env.update(HOME=tmp, XDG_CONFIG_HOME=tmp, XDG_DATA_HOME=tmp)
        print(f'Experimental local DM: connect 127.0.0.1:{args.port}; Ctrl+C stops it.', flush=True)
        child = subprocess.Popen(server_args(server, args.port), cwd=tmp, env=env)
        try:
            return child.wait()
        except KeyboardInterrupt:
            return 130
        finally:
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()


if __name__ == '__main__':
    raise SystemExit(main())
