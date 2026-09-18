#!/usr/bin/env bash
# Run after local_syntax_probe.sh: genuine menu translation-unit syntax checks.
# This does not link/run the native client or supply a visual UI test.
set -euo pipefail
cd "$(dirname "$0")/.."
GEN_DIR="${1:-${TMPDIR:-/tmp}/neonrelay-syntax-probe}"
for file in menus.cpp menus_start.cpp menus_settings.cpp menus_settings_wallet.cpp players.cpp skins.cpp skins7.cpp binds.cpp touch_controls.cpp scoreboard.cpp motd.cpp important_alert.cpp menus_settings_tee.cpp menus_settings_controls.cpp menus_ingame_touch_controls.cpp ghost.cpp menus_settings_appearance.cpp chat.cpp sounds.cpp console.cpp menus_settings_assets.cpp mapimages.cpp; do
  "${CXX:-g++}" -std=c++20 -fsyntax-only -Isrc -I"$GEN_DIR/src" \
    -Isrc/engine/external -Isrc/engine/external/json-parser \
    "src/game/client/components/$file"
  echo "menu syntax: $file PASS"
done

for file in gameclient.cpp render.cpp; do
  "${CXX:-g++}" -std=c++20 -fsyntax-only -Isrc -I"$GEN_DIR/src" -Isrc/engine/external -Isrc/engine/external/json-parser "src/game/client/$file"
done
