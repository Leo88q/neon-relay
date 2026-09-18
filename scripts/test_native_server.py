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
    # Map load is mandatory before server/game initialization. Prove this gate
    # cannot pass merely because the process accepts CLI args and exits zero.
    code, output, diagnostic = run([arg.replace("sv_map LearnToPlay", "sv_map MissingCiMap") for arg in args])
    assert code != 0 and "failed to load map" in output and "MissingCiMap" in output, diagnostic
    print("PASS: full linked server initialized map/game/HTTP and exited cleanly while empty; missing-map negative control; loopback only")
