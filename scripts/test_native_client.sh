#!/usr/bin/env bash
# Linux/Xvfb full client link and bounded UI boot, not a mobile gameplay test.
set -euo pipefail
cd "$(dirname "$0")/.."
BUILD="$(mktemp -d)"
trap 'rm -rf "$BUILD"' EXIT
cmake -S . -B "$BUILD" -GNinja -DCMAKE_BUILD_TYPE=Release \
  -DCLIENT=ON -DSERVER=ON -DTOOLS=OFF -DVIDEORECORDER=OFF -DVULKAN=OFF \
  -DDOWNLOAD_GTEST=OFF -DPRECOMPILE_HEADERS=OFF -DPREFER_BUNDLED_LIBS=OFF
cmake --build "$BUILD" --target game-client game-server --parallel 2
xvfb-run -a -s '-screen 0 1400x1200x24' python3 scripts/test_native_client.py "$BUILD/neonrelay" "${RUNNER_TEMP:-/tmp}/client-preview"

xvfb-run -a -s '-screen 0 1400x1200x24' python3 scripts/test_native_worlds.py "$BUILD/neonrelay" "$BUILD/neonrelay-server" "${RUNNER_TEMP:-/tmp}/client-preview"
