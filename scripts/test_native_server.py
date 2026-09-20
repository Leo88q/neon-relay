#!/usr/bin/env python3
"""Bounded, local-only boot of the actual linked server, not a gameplay test."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

binary = Path(sys.argv[1]).resolve(strict=True)
root = Path(__file__).resolve().parent.parent
with tempfile.TemporaryDirectory(prefix="neonrelay-boot-") as tmp:
    home = Path(tmp)
    data = home / "data"
    (data / "maps").mkdir(parents=True)
    shutil.copyfile(root / "data/maps/LearnToPlay.map", data / "maps/LearnToPlay.map")
    (data / "autoexec_server.cfg").write_text("# Isolated CI configuration\n")
    (home / "storage.cfg").write_text(f"add_path {data}\n")
    env = {key: value for key, value in os.environ.items() if not key.startswith("NEONRELAY_")}
    env.update(HOME=tmp, XDG_DATA_HOME=tmp, XDG_CONFIG_HOME=tmp)
    args = [str(binary), "bindaddr 127.0.0.1", "sv_register 0",
            "sv_sixup 0", "sv_dnsbl 0", "sv_map LearnToPlay", "sv_name neonrelay-ci-boot",
            "sv_sqlite_file boot-test.sqlite", "sv_shutdown_when_empty 1"]
    def run(arguments):
        result = subprocess.run(arguments, cwd=tmp, env=env, capture_output=True, text=True, timeout=45)
        output = result.stdout + result.stderr
        # Generated rcon credentials must never appear in CI logs.
        safe = "\n".join(line for line in output.splitlines() if "password" not in line.lower())
        return result.returncode, output, safe[-3500:]

    code, output, diagnostic = run(args)
    assert code == 0, diagnostic
    assert "server name is 'neonrelay-ci-boot'" in output, diagnostic
    assert "Found 1 maps for maplist" in output, diagnostic
    assert "No such command" not in output, diagnostic
    # Exercise every generated race map with the actual engine reader/game init.
    names = ['Neon Relay Warmup', 'Neon Relay Basin', 'Chromatic Canyon', 'Vector Spire', 'Midnight Circuit', 'Aurora Ascent', 'LearnToPlay Sound', 'LearnToPlay Sound Heights']
    for name in names:
        shutil.copyfile(root / f'data/maps/{name}.map', data / f'maps/{name}.map')
        code, output, diagnostic = run([arg.replace('sv_map LearnToPlay', f'sv_map "{name}"') for arg in args])
        assert code == 0 and "server name is 'neonrelay-ci-boot'" in output, diagnostic
        assert 'failed to load map' not in output and 'invalid header' not in output, diagnostic
        print(f'PASS: native server loaded {name}')
    # Experimental DM is not in default packaging/rotation. Supply its fixture
    # explicitly and verify the linked executable selects the opt-in controller.
    dm_map = 'Neon Relay Chrome DM Study'
    shutil.copyfile(root / f'docs/dm/{dm_map}.map', data / f'maps/{dm_map}.map')
    dm_args = [arg.replace('sv_map LearnToPlay', f'sv_map "{dm_map}"') for arg in args]
    dm_args += ['sv_gametype neon-dm', 'sv_hit 1', 'sv_solo_server 0',
                'sv_practice_by_default 0', 'sv_neonrelay_signing 0']
    code, output, diagnostic = run(dm_args)
    assert code == 0 and 'combat controller selected;' in output, diagnostic
    assert 'No such command' not in output, diagnostic
    code, output, diagnostic = run(dm_args + ['sv_solo_server 1'])
    assert code != 0 and 'Neon DM requires' in output, diagnostic
    print('PASS: linked Neon DM controller boot and incompatible solo-mode refusal (not a multiplayer test)')
    # Map load is mandatory before server/game initialization. Prove this gate
    # cannot pass merely because the process accepts CLI args and exits zero.
    code, output, diagnostic = run([arg.replace("sv_map LearnToPlay", "sv_map MissingCiMap") for arg in args])
    assert code != 0 and "failed to load map" in output and "MissingCiMap" in output, diagnostic
    print("PASS: full linked server initialized map/game/HTTP and exited cleanly while empty; missing-map negative control; loopback only")
