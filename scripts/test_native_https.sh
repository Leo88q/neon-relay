#!/usr/bin/env bash
# Requires Linux curl headers, OpenSSL CLI, and an isolated CI runner with sudo.
# No production keys or external network endpoints; trust is temporary test CA.
set -euo pipefail
cd "$(dirname "$0")/.."
BUILD="$(mktemp -d)"
trap 'rm -rf "$BUILD"' EXIT
CC="${CC:-gcc}"; CXX="${CXX:-g++}"
"$CC" -O2 -w -DED25519_REFHASH -DED25519_CUSTOMRANDOM -Isrc -Isrc/engine/external -c src/engine/external/ed25519/ed25519.c -o "$BUILD/ed25519.o"
"$CC" -O2 -c src/engine/external/json-parser/json.c -o "$BUILD/json.o"
"$CXX" -std=c++20 -O2 -DCONF_OPENSSL -Isrc -c src/neonrelay/game_pairing_seal.cpp -o "$BUILD/seal.o"
"$CXX" -std=c++20 -O2 -ffunction-sections -fdata-sections -Isrc -Isrc/engine/external \
  src/neonrelay/game_https_test.cpp src/neonrelay/game_pairing_http.cpp src/neonrelay/game_pairing_protocol.cpp \
  src/neonrelay/game_identity.cpp src/neonrelay/match_signer.cpp \
  src/engine/http.cpp src/engine/shared/http_curl.cpp \
  src/base/{aio,dbg,fs,hash,hash_libtomcrypt,io,log,mem,secure,sphore,str,thread,time}.cpp \
  "$BUILD/json.o" "$BUILD/ed25519.o" "$BUILD/seal.o" -lcrypto -Wl,--gc-sections -pthread -lcurl -o "$BUILD/test-https"
python3 scripts/test_native_https.py "$BUILD/test-https"
