#!/usr/bin/env bash
# Neon Relay — create a THROWAWAY devnet test mint for reward-program testing.
#
# Policy (spec §on-chain):
#   * devnet only — this script hard-codes the devnet RPC and refuses overrides;
#   * the mint it creates is NOT an official token and must be labelled as a
#     test mint wherever it is shown; there is no official Neon Relay token and
#     no token named SKR may be created;
#   * no mainnet mint is ever hardcoded in the repository — the mint address
#     travels via the NEONRELAY_TEST_MINT environment variable / deployment
#     config only.
set -euo pipefail

CLUSTER_URL="https://api.devnet.solana.com"

command -v spl-token > /dev/null || {
	echo "ERROR: spl-token CLI not found. Install the Solana toolchain first:" >&2
	echo "  sh -c \"\$(curl -sSfL https://release.anza.xyz/stable/install)\"" >&2
	echo "  cargo install spl-token-cli   # or: solana-install init spl-token" >&2
	exit 1
}

echo "Creating 6-decimal test mint on devnet (${CLUSTER_URL}) ..."
OUTPUT="$(spl-token create-token --url "$CLUSTER_URL" --decimals 6)"
echo "$OUTPUT"
MINT="$(printf '%s\n' "$OUTPUT" | awk '/^Creating token/ {print $3}')"

if [ -z "$MINT" ]; then
	echo "ERROR: could not parse the mint address from spl-token output" >&2
	exit 1
fi

cat <<EOF

NEONRELAY_TEST_MINT=${MINT}

This is a DEVNET TEST MINT — not an official token, no value, do not display
it as a reward currency in any user-facing surface without the "test" label.

Next steps (operator wallet must have devnet SOL: solana airdrop 1):
  export NEONRELAY_TEST_MINT=${MINT}
  # fund a player account for a claim dry-run:
  spl-token create-account --url ${CLUSTER_URL} ${MINT}
  spl-token mint --url ${CLUSTER_URL} ${MINT} 1000000
EOF
