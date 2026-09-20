#!/usr/bin/env bash
# Создаёт Merkle-дерево для Bubblegum cNFT (дешёвые бейджи) и выводит стоимость rent.
# Требует: solana CLI, funded wallet, Anchor.
# Использование:
#   ./onchain/scripts/create_compressed_tree.sh devnet 14 64 5   # 16k capacity ~0.34 SOL
#   ./onchain/scripts/create_compressed_tree.sh devnet 20 256 13 # 1M capacity ~8.5 SOL
set -euo pipefail
CLUSTER="${1:-devnet}"
MAX_DEPTH="${2:-14}"
MAX_BUFFER="${3:-64}"
CANOPY="${4:-5}"
echo "== create compressed tree on $CLUSTER depth=$MAX_DEPTH buffer=$MAX_BUFFER canopy=$CANOPY =="
echo "Rent ориентир (Metaplex docs 20.09.26):"
echo "  14/64/8  ~0.34 SOL  (16k cNFT)"
echo "  20/256/13 ~8.5 SOL (1M cNFT)"
echo "  24/512/15 ~26 SOL (16M cNFT)"
echo "Требует DAS RPC (Helius) для getAssetProof в mint_badge_compressed."

# Проверка кошелька
if ! solana address >/dev/null 2>&1; then echo "solana wallet not configured" >&2; exit 1; fi
solana config set --url "$CLUSTER" >/dev/null

# В реале: вызвать `create_tree` инструкцию neonrelay-assets:
# anchor shell:
#   await program.methods.createTree(new BN(maxDepth), new BN(maxBuffer), new BN(canopy))
#     .accounts({ merkleTree: treeKeypair.publicKey(), collection: collectionPda })
#     .signers([treeKeypair]).rpc()
#
# Упрощённый dry-run: генерируем keypair дерева и показываем команду.
TREE_KEYPAIR="$(mktemp)"
solana-keygen new --no-outfile --silent || true
# Генерим новый keypair для дерева
solana-keygen new --outfile "$TREE_KEYPAIR" --force --silent 2>/dev/null || solana-keygen new --outfile "$TREE_KEYPAIR" --force
TREE_PUB="$(solana-keygen verify $(solana-keygen pubkey "$TREE_KEYPAIR") "$TREE_KEYPAIR" 2>/dev/null | grep -oE '[1-9A-HJ-NP-Za-km-z]{32,44}' | head -1 || solana address -k "$TREE_KEYPAIR")"
echo "tree keypair: $TREE_KEYPAIR  pubkey: $TREE_PUB"
echo ""
echo "Далее выполните (anchor shell):"
cat <<TS
import { PublicKey } from "@solana/web3.js";
const treeKeypair = /* load $TREE_KEYPAIR */;
await program.methods
  .createTree(new BN($MAX_DEPTH), new BN($MAX_BUFFER), new BN($CANOPY))
  .accounts({
    merkleTree: treeKeypair.publicKey,
    collection: collectionPda, // из create_collection
  })
  .signers([treeKeypair])
  .rpc();
console.log("tree", treeKeypair.publicKey.toBase58());
TS
echo ""
echo "После создания проверьте: solana account $TREE_PUB --url $CLUSTER"
echo "И проиндексируйте DAS: curl -X POST https://your-helius-rpc -d '{\"method\":\"getAsset\",\"params\":[\"<cNFT>\"]}'"
rm -f "$TREE_KEYPAIR"
echo "== done =="
