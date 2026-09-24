#!/usr/bin/env bash
# Experimental helper only. It does not prove a production asset path or quote
# rent/CU/SOL/USD values: Bubblegum/MPL Core CPI is disabled in the default build.
# Before running, obtain a separate ABI/validator review and set the explicit
# acknowledgement below. No on-chain instruction is sent by this helper.
# Requires: solana CLI and a deliberately funded throwaway wallet.
# Usage:
#   NEONRELAY_EXTERNAL_ASSET_EXPERIMENT=1 \
#     ./onchain/scripts/create_compressed_tree.sh devnet 14 64 5
set -euo pipefail

if [[ "${NEONRELAY_EXTERNAL_ASSET_EXPERIMENT:-}" != "1" ]]; then
  echo "external asset experiment is disabled; default build is fail-closed" >&2
  echo "set NEONRELAY_EXTERNAL_ASSET_EXPERIMENT=1 only after ABI/validator review" >&2
  exit 1
fi

CLUSTER="${1:-devnet}"
MAX_DEPTH="${2:-14}"
MAX_BUFFER="${3:-64}"
CANOPY="${4:-5}"
echo "== prepare external asset experiment on $CLUSTER depth=$MAX_DEPTH buffer=$MAX_BUFFER canopy=$CANOPY =="
echo "Rent, compute, throughput and SOL/USD values are unverified and must be measured"
echo "against the pinned program build and validator; this helper emits no production approval."
echo "The default neonrelay-assets build returns AssetPathNotConfigured for tree creation."

if ! solana address >/dev/null 2>&1; then
  echo "solana wallet not configured" >&2
  exit 1
fi
solana config set --url "$CLUSTER" >/dev/null

# This is a dry-run keypair/command preparation step only. It deliberately does
# not invoke Anchor, Bubblegum, compression, or any transaction-producing CLI.
TREE_KEYPAIR="$(mktemp)"
trap 'rm -f "$TREE_KEYPAIR"' EXIT
solana-keygen new --outfile "$TREE_KEYPAIR" --force --silent 2>/dev/null || solana-keygen new --outfile "$TREE_KEYPAIR" --force
TREE_PUB="$(solana-keygen pubkey "$TREE_KEYPAIR")"
echo "throwaway tree keypair prepared at: $TREE_KEYPAIR"
echo "tree pubkey: $TREE_PUB"
echo ""
echo "External review must provide the exact ABI/account metas before any invocation."
cat <<TS
// Review-only sketch; do not run until external CPI gates are approved.
await program.methods
  .createTree(new BN($MAX_DEPTH), new BN($MAX_BUFFER), new BN($CANOPY))
  .accounts({ merkleTree: treeKeypair.publicKey, collection: collectionPda })
  .signers([treeKeypair])
  .rpc();
TS
echo ""
echo "Read-only inspection, if separately approved: solana account $TREE_PUB --url $CLUSTER"
echo "== dry-run preparation complete; no transaction sent =="
