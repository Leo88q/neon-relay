#!/usr/bin/env bash
# Verify a live deployment against a release manifest. Read-only: it never
# signs, deploys, or changes upgrade authority.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLUSTER=""
MANIFEST=""
ONLY=""
REQUIRED=(neonrelay_rewards neonrelay_features neonrelay_economy neonrelay_assets)

while [ $# -gt 0 ]; do
  case "$1" in
    --cluster) CLUSTER="${2:?--cluster needs a value}"; shift 2 ;;
    --manifest) MANIFEST="${2:?--manifest needs a path}"; shift 2 ;;
    --program) ONLY="${2:?--program needs a name}"; shift 2 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$CLUSTER" ] || { echo "--cluster is required" >&2; exit 2; }
[ -n "$MANIFEST" ] || { echo "--manifest is required" >&2; exit 2; }
[ -f "$MANIFEST" ] || { echo "not a file: $MANIFEST" >&2; exit 2; }
command -v solana >/dev/null || { echo "solana CLI not found" >&2; exit 2; }
command -v jq >/dev/null || { echo "jq not found" >&2; exit 2; }
# `--cluster` accepts either a canonical Solana cluster or an explicit RPC URL.
# A custom URL is still checked against the manifest's canonical cluster below;
# it must not be mistaken for a new cluster name by the offline ID gate.
MANIFEST_CLUSTER="$(jq -er '.cluster | strings' "$MANIFEST")" || { echo "manifest has no string cluster" >&2; exit 2; }
case "$CLUSTER" in
  devnet|testnet|mainnet-beta)
    node "$ROOT/onchain/scripts/verify_source_ids.mjs" --manifest "$MANIFEST" --cluster "$CLUSTER" --strict-manifest >/dev/null ;;
  http://*|https://*|ws://*|wss://*)
    node "$ROOT/onchain/scripts/verify_source_ids.mjs" --manifest "$MANIFEST" --strict-manifest >/dev/null ;;
  *) echo "unknown cluster: $CLUSTER (use devnet|testnet|mainnet-beta|URL)" >&2; exit 2 ;;
esac

GENESIS_HASH="$(jq -er '.genesis_hash | strings' "$MANIFEST")" || { echo "manifest has no genesis_hash" >&2; exit 2; }
REWARD_MINT="$(jq -er '.mints.reward | strings' "$MANIFEST")" || { echo "manifest has no reward mint" >&2; exit 2; }
SKR_MINT="$(jq -er '.mints.skr | strings' "$MANIFEST")" || { echo "manifest has no skr mint" >&2; exit 2; }
EXPECTED_AUTH="$(jq -er '.upgrade_authority | strings' "$MANIFEST")" || { echo "manifest has no string upgrade_authority" >&2; exit 2; }
case "$CLUSTER" in
  devnet|testnet|mainnet-beta)
    [ "$MANIFEST_CLUSTER" = "$CLUSTER" ] || { echo "manifest cluster ($MANIFEST_CLUSTER) != --cluster ($CLUSTER)" >&2; exit 2; } ;;
esac
for label_value in "genesis_hash:$GENESIS_HASH" "reward_mint:$REWARD_MINT" "skr_mint:$SKR_MINT"; do
  value="${label_value#*:}"
  [[ "$value" =~ ^[1-9A-HJ-NP-Za-km-z]{32,44}$ ]] || { echo "$label_value is not canonical base58" >&2; exit 2; }
done
if [ "$EXPECTED_AUTH" != "none" ] && ! [[ "$EXPECTED_AUTH" =~ ^[1-9A-HJ-NP-Za-km-z]{32,44}$ ]]; then
  echo "upgrade_authority is not canonical base58 or none" >&2; exit 2
fi
jq -e '.programs | type == "object" and length >= 4' "$MANIFEST" >/dev/null || {
  echo "manifest programs object is incomplete" >&2; exit 2;
}
for name in "${REQUIRED[@]}"; do
  id="$(jq -er --arg name "$name" '.programs[$name] | strings' "$MANIFEST")" || {
    echo "manifest missing $name" >&2; exit 2;
  }
  if ! [[ "$id" =~ ^[1-9A-HJ-NP-Za-km-z]{32,44}$ ]]; then
    echo "manifest $name id is not canonical base58: $id" >&2; exit 2
  fi
done
case "$CLUSTER" in
  devnet) URL="https://api.devnet.solana.com" ;;
  testnet) URL="https://api.testnet.solana.com" ;;
  mainnet-beta) URL="https://api.mainnet-beta.solana.com" ;;
  http*|ws*) URL="$CLUSTER" ;;
  *) echo "unknown cluster: $CLUSTER (use devnet|testnet|mainnet-beta|URL)" >&2; exit 2 ;;
esac
LIVE_GENESIS="$(solana genesis-hash --url "$URL" 2>/dev/null || true)"
[ "$LIVE_GENESIS" = "$GENESIS_HASH" ] || { echo "live genesis hash does not match manifest" >&2; exit 1; }
[ "$REWARD_MINT" != "$SKR_MINT" ] || { echo "reward and payment mints must be distinct" >&2; exit 2; }
TOKEN_PROGRAM="TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
for label_value in "reward:$REWARD_MINT" "skr:$SKR_MINT"; do
  label="${label_value%%:*}"
  mint="${label_value#*:}"
  account="$(solana account "$mint" --url "$URL" --output json 2>&1)" || {
    echo "FAIL $label mint ($mint): account lookup failed" >&2; echo "$account" | head -n 5 >&2; exit 1;
  }
  owner="$(echo "$account" | jq -er '.account.owner | strings')" || { echo "FAIL $label mint: malformed account response" >&2; exit 1; }
  [ "$owner" = "$TOKEN_PROGRAM" ] || { echo "FAIL $label mint: expected classic SPL Token owner, got $owner" >&2; exit 1; }
  data_b64="$(echo "$account" | jq -er '.account.data[0] | strings')" || { echo "FAIL $label mint: missing account data" >&2; exit 1; }
  if [ "$label" = "reward" ]; then expected_reward_decimals=1; else expected_reward_decimals=0; fi
  mint_check="$(printf '%s' "$account" | NEONRELAY_EXPECT_REWARD_DECIMALS="$expected_reward_decimals" node -e '
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const account = JSON.parse(input);
      const data = account.account?.data;
      if (!Array.isArray(data) || data[1] !== "base64" || typeof data[0] !== "string") throw new Error("non-base64 mint data");
      const bytes = Buffer.from(data[0], "base64");
      if (bytes.length !== 82 || bytes.toString("base64") !== data[0]) throw new Error("not canonical 82-byte classic SPL Mint");
      if (bytes.readUInt32LE(0) !== 0 || bytes[45] !== 1 || bytes.readUInt32LE(46) !== 0) throw new Error("mint authority/freeze authority is not revoked or mint is uninitialized");
      if (process.env.NEONRELAY_EXPECT_REWARD_DECIMALS === "1" && bytes[44] !== 6) throw new Error("reward mint must use 6 decimals");
      process.stdout.write("ok");
    });
  ' )" || {
    echo "FAIL $label mint: $mint_check" >&2; exit 1;
  }
  [ "$mint_check" = "ok" ] || { echo "FAIL $label mint: validation did not complete" >&2; exit 1; }
done
NAMES="$(jq -r '.programs | keys[]' "$MANIFEST")"
if [ -n "$ONLY" ]; then
  echo "$NAMES" | grep -qx "$ONLY" || { echo "no such program in manifest: $ONLY" >&2; exit 2; }
  NAMES="$ONLY"
fi

fail=0
printf '%-22s %-45s %-10s %s\n' "PROGRAM" "PROGRAM_ID" "DATALEN" "UPGRADE_AUTHORITY / SLOT"
for name in $NAMES; do
  id="$(jq -r --arg n "$name" '.programs[$n]' "$MANIFEST")"
  info="$(solana program show "$id" --url "$URL" --output json 2>&1)" || {
    echo "FAIL $name ($id): solana program show failed" >&2; echo "$info" | head -n 5 >&2; fail=1; continue
  }
  authority="$(echo "$info" | jq -r '.authority // "none"')"
  slot="$(echo "$info" | jq -r '.lastDeploySlot // "?"')"
  datalen="$(echo "$info" | jq -r '.dataLen // 0')"
  if [ "$datalen" = "0" ]; then echo "FAIL $name ($id): no deployed bytecode" >&2; fail=1; continue; fi
  if [ "$authority" != "$EXPECTED_AUTH" ]; then
    echo "FAIL $name ($id): upgrade authority $authority != expected $EXPECTED_AUTH" >&2; fail=1; continue
  fi
  printf '%-22s %-45s %-10s %s (slot %s)\n' "$name" "$id" "$datalen" "$authority" "$slot"
done
[ "$fail" -eq 0 ] || { echo "verify_deployment: FAILED" >&2; exit 1; }
echo "verify_deployment: OK ($CLUSTER)"
