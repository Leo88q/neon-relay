#!/usr/bin/env bash
# Full Linux server target, separate from offline gates (requires Rust/dev libs).
set -euo pipefail
cd "$(dirname "$0")/.."
BUILD="$(mktemp -d)"
trap 'rm -rf "$BUILD"' EXIT
cmake -S . -B "$BUILD" -GNinja -DCMAKE_BUILD_TYPE=Release \
  -DCLIENT=OFF -DSERVER=ON -DTOOLS=OFF -DVIDEORECORDER=OFF -DVULKAN=OFF \
  -DDOWNLOAD_GTEST=OFF -DPRECOMPILE_HEADERS=OFF -DPREFER_BUNDLED_LIBS=OFF
cmake --build "$BUILD" --target game-server --parallel 2
python3 scripts/test_native_server.py "$BUILD/neonrelay-server"
