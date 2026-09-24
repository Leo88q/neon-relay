#!/usr/bin/env bash
# Non-deploy release gate. It never contacts RPC and never signs a transaction.
# In the sandbox use SOURCE_ONLY=1; production CI must leave it unset so missing
# tsc/cargo/anchor or an external audit artifact fails closed.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SOURCE_ONLY="${SOURCE_ONLY:-0}"
cd "$ROOT"

fail_or_note() {
  if [ "$SOURCE_ONLY" = "1" ]; then echo "UNVERIFIABLE (SOURCE_ONLY=1): $*" >&2
  else echo "RELEASE_GATE_FAILED: $*" >&2; exit 2
  fi
}

node onchain/scripts/verify_source_ids.mjs
if ! node onchain/scripts/verify_toolchain_pin.mjs; then
  fail_or_note "Anchor.toml and all on-chain crates are not pinned to the required production Anchor version"
fi
(cd backend && npm test)
(cd backend && npm run typecheck)
(cd onchain && npm test && npm run typecheck && npm run verify:ids)

# Generate audit evidence only into a temporary directory; never overwrite the
# legacy report in the audited checkout.
AUDIT_TMP="$(mktemp -d)"
trap 'rm -rf "$AUDIT_TMP"' EXIT
NEONRELAY_AUDIT_REPORT_DIR="$AUDIT_TMP" node scripts/generate_neonrelay_audit_report.mjs >/dev/null
node -e 'const r=require(process.argv[1]); if(r.findings?.length || r.files_scanned !== r.files_parsed) process.exit(1); console.log(`static audit: ${r.files_parsed}/${r.files_scanned}, ${r.source_digest}`)' "$AUDIT_TMP/neon-relay-audit.json"

if [ -n "${AUDIT_REPORT_PATH:-}" ]; then
  AUDIT_REPORT_ABS="$(readlink -f -- "$AUDIT_REPORT_PATH" 2>/dev/null || true)"
  if [ -z "$AUDIT_REPORT_ABS" ]; then
    fail_or_note "AUDIT_REPORT_PATH cannot be resolved"
  elif [[ "$AUDIT_REPORT_ABS" == "$ROOT"/* || "$AUDIT_REPORT_ABS" == "$ROOT" ]]; then
    fail_or_note "AUDIT_REPORT_PATH must be outside the audited checkout"
  else
    node scripts/check_audit_report_drift.mjs "$AUDIT_REPORT_ABS"
  fi
else
  fail_or_note "AUDIT_REPORT_PATH is not set; committed legacy reports are not evidence"
fi

if ! command -v tsc >/dev/null; then
  fail_or_note "tsc is unavailable; backend type safety is unverified"
else
  (cd backend && REQUIRE_TSC=1 npm run typecheck)
fi
for tool in cargo rustc anchor; do
  command -v "$tool" >/dev/null || fail_or_note "$tool is unavailable; on-chain build/test is unverified"
done
if command -v cargo >/dev/null && command -v rustc >/dev/null; then
  (cd onchain && cargo test --workspace --locked)
fi
if command -v anchor >/dev/null && command -v cargo >/dev/null; then
  (cd onchain && anchor build --no-idl)
fi

echo "release validation passed"
