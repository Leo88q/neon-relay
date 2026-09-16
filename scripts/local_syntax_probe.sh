#!/usr/bin/env bash
# Neon Relay — local translation-unit syntax probe.
#
# The full DDNet/Neon Relay build needs Rust/Cargo, SQLite3, libcurl, OpenSSL,
# SDL2, FreeType, PNG, Ogg/Opus and a working package mirror. When those are not
# available (restricted CI runners, sandboxes, a fresh laptop before installing
# the toolchain) this script still verifies a large part of the tree:
#
#   1. it runs the Python code generation step (datasrc/*.py, scripts/wordlist.py)
#      exactly the way CMake does, into a scratch directory;
#   2. it syntax-checks every server-side/base/shared/game C++ translation unit
#      with the same standard the build uses (C++20) and the bundled headers.
#
# It intentionally does NOT try to compile client code (SDL2/Vulkan/FFmpeg) or
# files that need SQLite3/curl/OpenSSL/rust-bridge headers; those are reported as
# "skipped" so the result is honest.
#
# Usage:
#   scripts/local_syntax_probe.sh [output-dir]
#
# Exit code: 0 if every probed file compiles, 1 otherwise.

set -u

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." &> /dev/null && pwd)"
cd "$ROOT_DIR"

GEN_DIR="${1:-${TMPDIR:-/tmp}/neonrelay-syntax-probe}"
GEN_SRC="${GEN_DIR}/src/generated"
rm -rf "$GEN_DIR"
mkdir -p "$GEN_SRC"

CXX="${CXX:-g++}"
STD="${STD:-c++20}"

INCLUDES=(
	-Isrc
	-I"${GEN_DIR}/src"
	-Isrc/engine/external
	-Isrc/engine/external/zlib
	-Isrc/engine/external/json-parser
	-Isrc/engine/external/md5
)

fail() {
	echo "ERROR: $*" >&2
	exit 1
}

command -v "$CXX" > /dev/null || fail "$CXX not found"
command -v python3 > /dev/null || fail "python3 not found"

echo "# Neon Relay local syntax probe"
echo "# date:      $(date -u +%FT%TZ)"
echo "# compiler:  $($CXX --version | head -1)"
echo "# standard:  -std=${STD}"
echo "# codegen:   ${GEN_DIR}"
echo

# ---------------------------------------------------------------------------
# 1. code generation (mirrors the add_custom_command rules in CMakeLists.txt)
# ---------------------------------------------------------------------------
echo "## code generation"
generate() {
	local out="$1"; shift
	if "$@" > "${GEN_SRC}/${out}" 2>"${GEN_DIR}/${out}.err"; then
		echo "  ok    src/generated/${out}"
	else
		echo "  FAIL  src/generated/${out} (see ${GEN_DIR}/${out}.err)"
		head -3 "${GEN_DIR}/${out}.err" | sed 's/^/        /'
		return 1
	fi
}

CODEGEN_FAILED=0
generate protocol.h                   python3 datasrc/compile.py network_header           || CODEGEN_FAILED=1
generate protocol.cpp                 python3 datasrc/compile.py network_source             || CODEGEN_FAILED=1
generate data_types.h                 python3 datasrc/compile.py content_types_header       || CODEGEN_FAILED=1
generate client_data.h                python3 datasrc/compile.py client_content_header      || CODEGEN_FAILED=1
generate client_data.cpp              python3 datasrc/compile.py client_content_source      || CODEGEN_FAILED=1
generate server_data.h                python3 datasrc/compile.py server_content_header      || CODEGEN_FAILED=1
generate server_data.cpp              python3 datasrc/compile.py server_content_source      || CODEGEN_FAILED=1
generate protocol7.h                  python3 -m datasrc.seven.compile network_header       || CODEGEN_FAILED=1
generate protocol7.cpp                python3 -m datasrc.seven.compile network_source       || CODEGEN_FAILED=1
generate client_data7.h               python3 -m datasrc.seven.compile client_content_header || CODEGEN_FAILED=1
generate client_data7.cpp             python3 -m datasrc.seven.compile client_content_source || CODEGEN_FAILED=1
generate protocolglue.h               python3 datasrc/crosscompile.py map_header            || CODEGEN_FAILED=1
generate protocolglue_generated.cpp   python3 datasrc/crosscompile.py map_source            || CODEGEN_FAILED=1
generate wordlist.h                   python3 scripts/wordlist.py                           || CODEGEN_FAILED=1
echo

if [ "$CODEGEN_FAILED" -ne 0 ]; then
	fail "code generation failed — cannot continue"
fi

# ---------------------------------------------------------------------------
# 2. translation unit probe
# ---------------------------------------------------------------------------
# Files that need headers we deliberately do not provide locally.
SKIP_REGEX='hash_openssl|hash_libtomcrypt|http_curl|/databases/|upnp\.cpp|mysql'

PROBE_FILES=$(
	ls src/base/*.cpp src/engine/shared/*.cpp src/engine/server/*.cpp \
		src/game/shared/*.cpp src/game/server/*.cpp src/game/server/*/*.cpp \
		src/neonrelay/*.cpp 2>/dev/null | grep -vE "$SKIP_REGEX"
)

ok=0
fail_count=0
skipped=0
failures=""

echo "## translation units"
for f in $PROBE_FILES; do
	if "$CXX" -std="$STD" -fsyntax-only "${INCLUDES[@]}" "$f" 2>"${GEN_DIR}/last-error.txt"; then
		ok=$((ok + 1))
	else
		if grep -q "rust_version.h\|sqlite3.h\|curl/\|openssl/\|cxx\.h" "${GEN_DIR}/last-error.txt"; then
			skipped=$((skipped + 1))
			reason=$(grep -m1 -E "fatal error" "${GEN_DIR}/last-error.txt" | sed 's/^.*fatal error: //; s/: No such file.*//')
			failures="${failures}SKIP  ${f} (missing external header: ${reason})"$'\n'
		else
			fail_count=$((fail_count + 1))
			reason=$(grep -m1 -E "error:" "${GEN_DIR}/last-error.txt" | sed 's/^ *//')
			failures="${failures}FAIL  ${f} :: ${reason}"$'\n'
		fi
	fi
done

printf "%s" "$failures"
echo
echo "## summary"
echo "  compiled cleanly : $ok"
echo "  skipped (deps)   : $skipped"
echo "  failed           : $fail_count"
echo

if [ "$fail_count" -ne 0 ]; then
	echo "RESULT: FAIL"
	exit 1
fi
echo "RESULT: PASS"
