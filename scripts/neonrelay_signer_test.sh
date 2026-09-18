#!/usr/bin/env bash
# Neon Relay — stage 8 match-event signer test.
#
# Builds the vendored ed25519-donna, src/neonrelay/match_signer.cpp and the
# neonrelay_match_sign tool with plain gcc/g++ (no CMake, no OpenSSL), signs a
# fixed test vector, and cross-verifies everything with Node's node:crypto
# Ed25519 — the same primitive the reward backend uses. Also checks that a
# tampered event fails verification.
#
# The seed below is a fixed TEST-ONLY vector, not a secret and never used in
# production. Production seeds come from sv_neonrelay_signing_key_file.
#
# Usage: scripts/neonrelay_signer_test.sh [output-dir]
# Exit code: 0 on PASS, 1 otherwise.

set -u

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." &> /dev/null && pwd)"
cd "$ROOT_DIR"

BUILD_DIR="${1:-${TMPDIR:-/tmp}/neonrelay-signer-test}"
CC="${CC:-gcc}"
CXX="${CXX:-g++}"

rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

fail() {
	echo "ERROR: $*" >&2
	echo "RESULT: FAIL"
	exit 1
}

command -v "$CC" > /dev/null || fail "$CC not found"
command -v "$CXX" > /dev/null || fail "$CXX not found"
command -v node > /dev/null || fail "node not found"

echo "# Neon Relay match-event signer test"
echo "# date:     $(date -u +%FT%TZ)"
echo "# cc:       $($CC --version | head -1)"
echo "# cxx:      $($CXX --version | head -1)"
echo "# node:     $(node --version)"
echo "# build:    $BUILD_DIR"
echo

# ---------------------------------------------------------------------------
# 1. build (mirrors the CMake rules: neonrelay-ed25519 object lib + tool)
# ---------------------------------------------------------------------------
echo "## build"
# -w: vendored public-domain code, warnings suppressed to keep the log readable
"$CC" -std=c11 -O2 -w -DED25519_REFHASH -DED25519_CUSTOMRANDOM \
	-Isrc -Isrc/engine/external \
	-c src/engine/external/ed25519/ed25519.c -o "$BUILD_DIR/ed25519.o" \
	|| fail "ed25519.c did not compile"
echo "  ok    src/engine/external/ed25519/ed25519.c"

"$CXX" -std=c++20 -O2 -Wall -Wextra -Isrc -Isrc/engine/external \
	-c src/neonrelay/match_signer.cpp -o "$BUILD_DIR/match_signer.o" \
	|| fail "match_signer.cpp did not compile"
echo "  ok    src/neonrelay/match_signer.cpp"

"$CXX" -std=c++20 -O2 -Wall -Wextra -Isrc -Isrc/engine/external \
	-c src/tools/neonrelay_match_sign.cpp -o "$BUILD_DIR/tool.o" \
	|| fail "neonrelay_match_sign.cpp did not compile"
echo "  ok    src/tools/neonrelay_match_sign.cpp"

"$CXX" -std=c++20 -O2 "$BUILD_DIR/tool.o" "$BUILD_DIR/match_signer.o" "$BUILD_DIR/ed25519.o" \
	-o "$BUILD_DIR/neonrelay_match_sign" \
	|| fail "neonrelay_match_sign did not link"
echo "  ok    linked $BUILD_DIR/neonrelay_match_sign"
echo

# ---------------------------------------------------------------------------
# 2. fixed test vector (TEST-ONLY seed, never used outside this harness)
# ---------------------------------------------------------------------------
SEED_HEX="deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
SEED_FILE="$BUILD_DIR/test_seed.hex"
printf '%s\n' "$SEED_HEX" > "$SEED_FILE"
chmod 600 "$SEED_FILE"

cat > "$BUILD_DIR/vectors.mjs" <<'VECTORS'
// Fixed stage-8 test vectors. The player_id deliberately contains quotes,
// backslashes and multi-byte UTF-8 to cross-check JsonEscape against
// JSON.stringify byte-for-byte.
export const seedHex = process.env.NEONRELAY_TEST_SEED_HEX;
export const events = [
	{
		match_id: "6f9b8d2e-1c3a-4b5d-8e7f-0a1b2c3d4e5f:Kobra",
		player_id: "nameless tee",
		event_type: "map_finish",
		amount_micro: 250,
		occurred_at: 1760000000000,
	},
	{
		match_id: "aa00bb11-2233-4455-6677-8899aabbccdd:Multimap",
		player_id: 'Player "One" \\ ünïcode 日本語 🚀',
		event_type: "map_finish",
		amount_micro: 0,
		occurred_at: 1760000000001,
	},
];
export function canonical(event) {
	// same fixed key order as backend/src/rewards.ts canonicalEventBytes()
	return JSON.stringify({
		match_id: event.match_id,
		player_id: event.player_id,
		event_type: event.event_type,
		amount_micro: event.amount_micro,
		occurred_at: event.occurred_at,
	});
}
VECTORS

cat > "$BUILD_DIR/emit.mjs" <<'EMIT'
// Prints the TSV lines the tool consumes on stdin.
import { events } from "./vectors.mjs";
for (const e of events) {
	process.stdout.write([e.match_id, e.player_id, e.event_type, e.amount_micro, e.occurred_at].join("\t") + "\n");
}
EMIT

cat > "$BUILD_DIR/verify.mjs" <<'VERIFY'
// Cross-verifies the tool output with node:crypto — the same Ed25519 the
// reward backend uses to check server_signature on /v1/rewards/events.
import { createPrivateKey, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { events, canonical, seedHex } from "./vectors.mjs";

const [signedPath, reportedPubkey] = process.argv.slice(2);
const seed = Buffer.from(seedHex, "hex");
// PKCS#8 wrapper for a raw 32-byte ed25519 seed (RFC 8410)
const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
const priv = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
const pub = createPublicKey(priv);
const rawPub = pub.export({ format: "der", type: "spki" }).subarray(-32);
const expectedPubkey = rawPub.toString("base64url");

let failures = 0;
function check(name, ok) {
	console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}`);
	if (!ok) failures++;
}

check("public key matches node:crypto derivation", reportedPubkey === expectedPubkey);

const lines = readFileSync(signedPath, "utf8").trim().split("\n");
check(`tool emitted ${events.length} signed line(s)`, lines.length === events.length);

for (let i = 0; i < Math.min(lines.length, events.length); i++) {
	const out = JSON.parse(lines[i]);
	check(`line ${i + 1}: fields round-trip`, out.match_id === events[i].match_id &&
		out.player_id === events[i].player_id && out.event_type === events[i].event_type &&
		out.amount_micro === events[i].amount_micro && out.occurred_at === events[i].occurred_at);
	check(`line ${i + 1}: signature verifies over canonical JSON`,
		verify(null, Buffer.from(canonical(events[i]), "utf8"), pub,
			Buffer.from(out.server_signature, "base64url")));
	// negative test: tamper with the amount
	const tampered = { ...events[i], amount_micro: events[i].amount_micro + 1 };
	check(`line ${i + 1}: tampered amount fails verification`,
		!verify(null, Buffer.from(canonical(tampered), "utf8"), pub,
			Buffer.from(out.server_signature, "base64url")));
}

if (failures > 0) {
	console.error(`RESULT: FAIL (${failures} check(s) failed)`);
	process.exit(1);
}
console.log("RESULT: PASS");
VERIFY

# ---------------------------------------------------------------------------
# 3. sign + cross-verify
# ---------------------------------------------------------------------------
echo "## sign"
PUBKEY_B64URL="$("$BUILD_DIR/neonrelay_match_sign" --seed-file "$SEED_FILE" --pubkey)" \
	|| fail "tool could not print the public key"
echo "  pubkey (base64url, test-only vector): $PUBKEY_B64URL"

NEONRELAY_TEST_SEED_HEX="$SEED_HEX" node "$BUILD_DIR/emit.mjs" > "$BUILD_DIR/events.tsv" \
	|| fail "could not emit test vector"
"$BUILD_DIR/neonrelay_match_sign" --seed-file "$SEED_FILE" < "$BUILD_DIR/events.tsv" > "$BUILD_DIR/signed.jsonl" \
	|| fail "tool failed to sign the test vector"
echo "  signed $(wc -l < "$BUILD_DIR/signed.jsonl") event(s) -> $BUILD_DIR/signed.jsonl"
echo

echo "## cross-verify with node:crypto (same Ed25519 as the reward backend)"
NEONRELAY_TEST_SEED_HEX="$SEED_HEX" node "$BUILD_DIR/verify.mjs" "$BUILD_DIR/signed.jsonl" "$PUBKEY_B64URL" \
	|| exit 1

# Guarded game identity adapter: native C++ -> actual backend HTTP verification.
"$CXX" -std=c++20 -O2 -Wall -Wextra -Isrc -Isrc/engine/external \
  src/neonrelay/game_identity.cpp src/neonrelay/game_identity_test.cpp \
  "$BUILD_DIR/match_signer.o" "$BUILD_DIR/ed25519.o" -o "$BUILD_DIR/game_identity_test" \
  || fail "game identity adapter did not compile"
NEONRELAY_IDENTITY_TEST_BIN="$BUILD_DIR/game_identity_test" \
NEONRELAY_IDENTITY_TEST_SEED_FILE="$SEED_FILE" \
NEONRELAY_IDENTITY_TEST_PUBLIC_KEY="$PUBKEY_B64URL" \
node --experimental-strip-types scripts/test_game_identity_signer.ts || fail "identity adapter parity failed"

"$CXX" -std=c++20 -O2 -Wall -Wextra -Isrc -Isrc/engine/external \
  src/neonrelay/game_identity.cpp src/neonrelay/game_connection_test.cpp \
  "$BUILD_DIR/match_signer.o" "$BUILD_DIR/ed25519.o" -o "$BUILD_DIR/game_connection_test" \
  || fail "game connection lifecycle did not compile"
"$BUILD_DIR/game_connection_test" || fail "game connection lifecycle failed"
echo "PASS: connection identity lifecycle, reconnect, expiry and stale callbacks"
