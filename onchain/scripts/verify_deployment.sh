#!/usr/bin/env bash
# verify_deployment.sh — verify deployed Anchor programs against a manifest.
#
# For every program in the manifest this checks, via `solana program show`:
#   * the program account exists and parses as JSON;
#   * it holds bytecode (dataLen > 0);
#   * the upgrade authority equals the expected Squads vault (or is
#     explicitly marked immutable with expected authority "none").
# It then prints the last-deploy slot for the rollout record.
#
# Usage:
#   onchain/scripts/verify_deployment.sh --cluster devnet \
#       --manifest onchain/deployment.devnet.json [--program neonrelay_rewards]
#
# Manifest shape (see deployment.example.json):
#   { "cluster": "devnet",
#     "upgrade_authority": "<SQUADS_VAULT_PUBKEY>" | "none",
#     "programs": { "<name>": "<program id>", ... } }
#
# Requires: solana CLI, jq. Run from the repository root.
set -euo pipefail

CLUSTER=""
MANIFEST=""
ONLY=""

while [ $# -gt 0 ]; do
  case "$1" in
    --cluster) CLUSTER="${2:?--cluster needs a value}"; shift 2 ;;
    --manifest) MANIFEST="${2:?--manifest needs a path}"; shift 2 ;;
    --program) ONLY="${2:?--program needs a name}"; shift 2 ;;
    -h|--help)
      sed -n '2,20p' "$0"
      exit 0
      ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ -n "$CLUSTER" ] || { echo "--cluster is required" >&2; exit 2; }
[ -n "$MANIFEST" ] || { echo "--manifest is required" >&2; exit 2; }
command -v solana >/dev/null || { echo "solana CLI not found" >&2; exit 2; }
command -v jq >/dev/null || { echo "jq not found" >&2; exit 2; }
[ -f "$MANIFEST" ] || { echo "not a file: $MANIFEST" >&2; exit 2; }

MANIFEST_CLUSTER="$(jq -r '.cluster // empty' "$MANIFEST")"
EXPECTED_AUTH="$(jq -r '.upgrade_authority // empty' "$MANIFEST")"
[ -n "$MANIFEST_CLUSTER" ] || { echo "manifest has no cluster" >&2; exit 2; }
[ -n "$EXPECTED_AUTH" ] || { echo "manifest has no upgrade_authority" >&2; exit 2; }
[ "$MANIFEST_CLUSTER" = "$CLUSTER" ] || {
  echo "manifest cluster ($MANIFEST_CLUSTER) != --cluster ($CLUSTER)" >&2
  exit 2
}

case "$CLUSTER" in
  devnet) URL="https://api.devnet.solana.com" ;;
  testnet) URL="https://api.testnet.solana.com" ;;
  mainnet-beta) URL="https://api.mainnet-beta.solana.com" ;;
  http*|ws*) URL="$CLUSTER" ;; # explicit RPC endpoint
  *) echo "unknown cluster: $CLUSTER (use devnet|testnet|mainnet-beta|URL)" >&2; exit 2 ;;
esac

NAMES="$(jq -r '.programs | keys[]' "$MANIFEST")"
[ -n "$NAMES" ] || { echo "manifest has no programs" >&2; exit 2; }
if [ -n "$ONLY" ]; then
  echo "$NAMES" | grep -qx "$ONLY" || { echo "no such program in manifest: $ONLY" >&2; exit 2; }
  NAMES="$ONLY"
fi

fail=0
printf '%-22s %-45s %-10s %s\n' "PROGRAM" "PROGRAM_ID" "DATALEN" "UPGRADE_AUTHORITY / SLOT"
for name in $NAMES; do
  id="$(jq -r --arg n "$name" '.programs[$n]' "$MANIFEST")"
  info="$(solana program show "$id" --url "$URL" --output json 2>&1)" || {
    echo "FAIL $name ($id): solana program show failed" >&2
    echo "$info" | head -n 5 >&2
    fail=1
    continue
  }
  authority="$(echo "$info" | jq -r '.authority // "none"')"
  slot="$(echo "$info" | jq -r '.lastDeploySlot // "?"')"
  datalen="$(echo "$info" | jq -r '.dataLen // 0')"
  if [ "$datalen" = "0" ]; then
    echo "FAIL $name ($id): no deployed bytecode (dataLen 0)" >&2
    fail=1
    continue
  fi
  if [ "$authority" != "$EXPECTED_AUTH" ]; then
    echo "FAIL $name ($id): upgrade authority $authority != expected $EXPECTED_AUTH" >&2
    fail=1
    continue
  fi
  printf '%-22s %-45s %-10s %s (slot %s)\n' "$name" "$id" "$datalen" "$authority" "$slot"
done

if [ "$fail" -ne 0 ]; then
  echo "verify_deployment: FAILED" >&2
  exit 1
fi
echo "verify_deployment: OK ($CLUSTER)"
echo "hint: follow up with 'anchor verify <program-id>' for a reproducible-build check"
