#!/usr/bin/env bash
# Neon Relay live deployment. This script is intentionally fail-closed: it
# performs no RPC transaction unless ALLOW_LIVE_DEPLOY=1 is set explicitly.
# Source-only validation is available as release_validate.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLUSTER="${CLUSTER:-devnet}"
MANIFEST="${DEPLOYMENT_MANIFEST:-$ROOT/onchain/deployment.${CLUSTER}.json}"
case "$MANIFEST" in /*) ;; *) MANIFEST="$ROOT/$MANIFEST" ;; esac
MIN_AGAVE="3.0.14"
MIN_ANCHOR="0.31.1"
PROGRAMS=(neonrelay-rewards neonrelay-features neonrelay-economy neonrelay-assets)

if [ "${ALLOW_LIVE_DEPLOY:-0}" != "1" ]; then
  echo "live deployment is disabled by default; run release_validate.sh for offline gates" >&2
  echo "to intentionally deploy, set ALLOW_LIVE_DEPLOY=1 and provide DEPLOYMENT_MANIFEST" >&2
  exit 2
fi
[ -f "$MANIFEST" ] || { echo "deployment manifest not found: $MANIFEST" >&2; exit 2; }
command -v jq >/dev/null || { echo "jq not found" >&2; exit 2; }

cd "$ROOT"
echo "== Neon Relay live deploy — cluster=$CLUSTER =="

# The project pin must agree with the production toolchain requirement before
# any build or RPC action is attempted.
node onchain/scripts/verify_toolchain_pin.mjs

# Offline identity gate before any toolchain or network action.
node onchain/scripts/verify_source_ids.mjs --manifest "$MANIFEST" --cluster "$CLUSTER" --strict-manifest
[ -n "${AUDIT_REPORT_PATH:-}" ] || { echo "AUDIT_REPORT_PATH is required for live deployment" >&2; exit 2; }
AUDIT_REPORT_PATH="$AUDIT_REPORT_PATH" onchain/scripts/release_validate.sh

# Toolchain gates are hard failures; a lower Anchor version is not a warning.
command -v solana >/dev/null || { echo "solana CLI not found" >&2; exit 2; }
command -v anchor >/dev/null || { echo "anchor CLI not found" >&2; exit 2; }
command -v cargo >/dev/null || { echo "cargo not found" >&2; exit 2; }
command -v rustc >/dev/null || { echo "rustc not found" >&2; exit 2; }
command -v tsc >/dev/null || { echo "tsc not found; deploy requires verified type safety" >&2; exit 2; }
SOLANA_VER="$(solana --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
ANCHOR_VER="$(anchor --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
[ "$(printf '%s\n' "$MIN_AGAVE" "$SOLANA_VER" | sort -V | head -n1)" = "$MIN_AGAVE" ] || {
  echo "Agave/Solana $SOLANA_VER < required $MIN_AGAVE" >&2; exit 2;
}
[ "$(printf '%s\n' "$MIN_ANCHOR" "$ANCHOR_VER" | sort -V | head -n1)" = "$MIN_ANCHOR" ] || {
  echo "Anchor $ANCHOR_VER < required $MIN_ANCHOR" >&2; exit 2;
}

# Local tests and type/syntax gates must pass before build/deploy.
(cd "$ROOT/backend" && npm test && REQUIRE_TSC=1 npm run typecheck)
(cd "$ROOT/onchain" && npm test && npm run typecheck && npm run verify:ids)

[ -f "$HOME/.config/solana/id.json" ] || { echo "operator wallet not found" >&2; exit 2; }
[ "$(jq -r '.cluster // empty' "$MANIFEST")" = "$CLUSTER" ] || {
  echo "manifest cluster does not match CLUSTER" >&2; exit 2;
}

# The manifest authority must be concrete before a live deploy. The first
# `anchor deploy` uses the operator wallet, then the script transfers every
# program to this authority before the final read-only verification.
MANIFEST_AUTH="$(jq -r '.upgrade_authority // empty' "$MANIFEST")"
AUTH="${UPGRADE_AUTHORITY:-$MANIFEST_AUTH}"
[ -n "$AUTH" ] && [ "$AUTH" != "none" ] || { echo "manifest upgrade_authority must be concrete" >&2; exit 2; }
[ "$AUTH" = "$MANIFEST_AUTH" ] || {
  echo "UPGRADE_AUTHORITY must equal manifest upgrade_authority" >&2; exit 2;
}
if [ "$CLUSTER" = "mainnet-beta" ] && [ "${CONFIRM_MAINNET:-}" != "YES" ]; then
  echo "mainnet requires CONFIRM_MAINNET=YES" >&2; exit 2
fi
case "$CLUSTER" in
  devnet) RPC_URL="https://api.devnet.solana.com" ;;
  testnet) RPC_URL="https://api.testnet.solana.com" ;;
  mainnet-beta) RPC_URL="https://api.mainnet-beta.solana.com" ;;
  *) echo "unsupported deployment cluster: $CLUSTER" >&2; exit 2 ;;
esac

cd "$ROOT/onchain"
if command -v docker >/dev/null && docker info >/dev/null 2>&1; then
  anchor build --verifiable
  mkdir -p target
  sha256sum target/verifiable/*.so | tee target/checksum.txt
else
  echo "docker unavailable; verifiable build cannot be claimed" >&2
  exit 2
fi

anchor deploy --provider.cluster "$CLUSTER"

# Transfer every upgrade authority only when the manifest gives a concrete,
# canonical authority. Never continue after a failed transfer. This happens
# before verification because the manifest records the post-transfer owner.
for name in "${PROGRAMS[@]}"; do
  pid="$(jq -r --arg name "$name" '.programs[$name] // empty' "$MANIFEST")"
  [ -n "$pid" ] || { echo "manifest missing $name" >&2; exit 2; }
  solana program set-upgrade-authority "$pid" --new-upgrade-authority "$AUTH" --url "$RPC_URL"
done

# Reproducible-build verification is read-only but mandatory before declaring
# the deployment complete.
for name in "${PROGRAMS[@]}"; do
  pid="$(jq -r --arg name "$name" '.programs[$name] // empty' "$MANIFEST")"
  anchor verify "$pid" --provider.cluster "$CLUSTER"
done
"$ROOT/onchain/scripts/verify_deployment.sh" --cluster "$CLUSTER" --manifest "$MANIFEST"
echo "DEPLOY OK — record manifest, finalized slot, and target/checksum.txt outside the audited source tree"
cat target/checksum.txt
