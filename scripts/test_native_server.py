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
    env = {key: value for key, value in os.environ.items() if not key.startswith("NEONRELAY_")}
    env.update(HOME=tmp, XDG_DATA_HOME=tmp, XDG_CONFIG_HOME=tmp)
    result = subprocess.run(
        [str(binary), "-d", str(data), "bindaddr 127.0.0.1", "sv_register 0",
         "sv_sixup 0", "sv_dnsbl 0", "sv_map LearnToPlay", "sv_name neonrelay-ci-boot",
         "sv_sqlite_file boot-test.sqlite", "sv_shutdown_when_empty 1"],
        cwd=tmp, env=env, capture_output=True, text=True, timeout=45,
    )
    output = result.stdout + result.stderr
    # Keep generated rcon credentials out of CI logs, even though they are local
    # test-only credentials for a process that already exited.
    safe_output = "\n".join(line for line in output.splitlines() if "password" not in line.lower())
    assert result.returncode == 0, safe_output[-3500:]
    assert "server name is 'neonrelay-ci-boot'" in output, safe_output[-3500:]
    assert "LearnToPlay" in output, safe_output[-3500:]
    print("PASS: full linked server initialized map/game/HTTP and exited cleanly while empty; loopback only")
