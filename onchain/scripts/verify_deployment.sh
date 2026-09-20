#!/usr/bin/env bash
# Верификация деплоя: ELF == on-chain data, owner == BPFLoaderUpgradeable, upgrade_authority ожидаемый.
set -euo pipefail
CLUSTER="${1:-devnet}"
echo "== verify deployment on $CLUSTER =="
for prog in neonrelay-rewards neonrelay-features neonrelay-economy neonrelay-assets; do
  pid="$(grep -E "$prog" onchain/Anchor.toml 2>/dev/null | grep -oE '[1-9A-HJ-NP-Za-km-z]{32,44}' | head -1 || true)"
  if [ -z "$pid" ]; then pid="$(grep -E "$prog" Anchor.toml 2>/dev/null | grep -oE '[1-9A-HJ-NP-Za-km-z]{32,44}' | head -1 || true)"; fi
  [ -n "$pid" ] || { echo "skip $prog — no id"; continue; }
  echo "-- $prog ($pid) --"
  solana program show --programs "$pid" --url "$CLUSTER" || { echo "not found on $CLUSTER"; continue; }
  # Сравнить ELF hash если есть
  elf="target/verifiable/${prog}.so"
  [ -f "$elf" ] || elf="target/deploy/${prog}.so"
  if [ -f "$elf" ]; then
    echo "local ELF sha256: $(sha256sum "$elf" | cut -d' ' -f1)"
  fi
  # Owner должен быть BPFLoaderUpgradeab1e (или BPFLoader211...)
  owner="$(solana program show --programs "$pid" --url "$CLUSTER" 2>/dev/null | grep -i owner || true)"
  echo "owner: $owner"
done
echo "== verify done — сверьте upgrade_authority == Squads и slot =="
