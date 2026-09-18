#!/usr/bin/env bash
# Run after local_syntax_probe.sh: genuine menu translation-unit syntax checks.
# This does not link/run the native client or supply a visual UI test.
set -euo pipefail
cd "$(dirname "$0")/.."
GEN_DIR="${1:-${TMPDIR:-/tmp}/neonrelay-syntax-probe}"
for file in menus.cpp menus_start.cpp menus_settings.cpp menus_settings_wallet.cpp players.cpp; do
  "${CXX:-g++}" -std=c++20 -fsyntax-only -Isrc -I"$GEN_DIR/src" \
    -Isrc/engine/external -Isrc/engine/external/json-parser \
    "src/game/client/components/$file"
  echo "menu syntax: $file PASS"
done
