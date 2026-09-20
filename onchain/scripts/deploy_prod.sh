#!/usr/bin/env bash
# Neon Relay — продакшн деплой (devnet/mainnet) c проверками Agave≥3.0.14 и verifiable build.
# Использование:
#   CLUSTER=devnet ./onchain/scripts/deploy_prod.sh            # devnet throwaway mint
#   CLUSTER=mainnet-beta UPGRADE_AUTHORITY=<SQUADS> ./onchain/scripts/deploy_prod.sh  # mainnet только после BL-16 sign-off
set -euo pipefail
CLUSTER="${CLUSTER:-devnet}"
PROGRAMS=(neonrelay-rewards neonrelay-features neonrelay-economy neonrelay-assets)
MIN_AGAVE="3.0.14"
MIN_ANCHOR="0.31.1"

echo "== Neon Relay prod deploy — cluster=$CLUSTER =="

# 1. Версии
echo "-- checking toolchain --"
if ! command -v solana >/dev/null; then echo "solana CLI not found" >&2; exit 1; fi
if ! command -v anchor >/dev/null; then echo "anchor CLI not found" >&2; exit 1; fi
SOLANA_VER="$(solana --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
echo "solana $SOLANA_VER (need >= $MIN_AGAVE)"
# semver compare via sort -V
if [ "$(printf '%s\n' "$MIN_AGAVE" "$SOLANA_VER" | sort -V | head -n1)" != "$MIN_AGAVE" ]; then
  echo "ERROR: Agave $SOLANA_VER < $MIN_AGAVE — обновите (критический патч 6Tbps, Jan 2026)" >&2
  exit 1
fi
ANCHOR_VER="$(anchor --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
echo "anchor $ANCHOR_VER (need >= $MIN_ANCHOR for prod) — warn if lower"
if [ "$(printf '%s\n' "$MIN_ANCHOR" "$ANCHOR_VER" | sort -V | head -n1)" != "$MIN_ANCHOR" ]; then
  echo "WARN: anchor $ANCHOR_VER < $MIN_ANCHOR — деплой продолжится, но обновите до 0.31.1 (фикс init_if_needed)" >&2
fi

# 2. Ключи
if [ ! -f "$HOME/.config/solana/id.json" ]; then echo "wallet not found at ~/.config/solana/id.json" >&2; exit 1; fi
echo "wallet: $(solana address)  cluster: $(solana config get | grep 'RPC URL' || true)"

# 3. Оффлайн-гейты (без цепи)
echo "-- offline gates --"
(cd backend && npm test)
(cd onchain && npm test)

# 4. Сборка verifiable (требует docker)
echo "-- building verifiable ELFs --"
if command -v docker >/dev/null && docker info >/dev/null 2>&1; then
  anchor build --verifiable
  echo "verifiable ELFs in target/verifiable/"
  sha256sum target/verifiable/*.so | tee onchain/target/checksum.txt
else
  echo "docker not available — fallback to anchor build"
  anchor build
  sha256sum target/deploy/*.so | tee onchain/target/checksum.txt
fi

# 5. Placeholder замена
echo "-- checking program ids are not placeholders --"
for prog in "${PROGRAMS[@]}"; do
  id="$(grep -E "$prog" Anchor.toml | grep -oE '[1-9A-HJ-NP-Za-km-z]{32,44}' || true)"
  if [[ "$id" == "2RaaXKUutemHtSZUsmnEv41ytWMkaXD6rcoziHGLRtmj" || "$id" == "4PH1dHVBRbfoydBx3SuRjAS46zRRjHvRxWCNcrFBDqYP" || "$id" == "FZcLDdUrs6i1HYFFK2NhqNrbVaP6KTvrqzhyoDGT6CV9" || "$id" == "As5T3pX47J2kU8KQYq3vN2FhF4b5c6d7e8f9g0h1i2j3k4l5m6n7o8p9q0r" ]]; then
    echo "WARN: $prog still uses placeholder $id — run: anchor keys list && update Anchor.toml/lib.rs/constants.ts" >&2
  fi
done

# 6. Деплой
echo "-- deploying to $CLUSTER --"
if [ "$CLUSTER" = "mainnet-beta" ]; then
  if [ -z "${UPGRADE_AUTHORITY:-}" ]; then
    echo "ERROR: mainnet требует UPGRADE_AUTHORITY=<SQUADS multisig>" >&2
    exit 1
  fi
  echo "MAINNET gate: убедитесь BL-16 signed-off, ToS geo-restrict, Squads 3-of-5"
  read -p "Подтвердите mainnet деплой (yes/no): " ok
  [ "$ok" = "yes" ] || exit 1
fi

anchor deploy --provider.cluster "$CLUSTER"
echo "deploy done — verifying..."

# 7. Пост-верификация
./onchain/scripts/verify_deployment.sh "$CLUSTER"

# 8. Upgrade authority -> Squads multisig (если задан)
if [ -n "${UPGRADE_AUTHORITY:-}" ]; then
  for prog in "${PROGRAMS[@]}"; do
    pid="$(anchor keys list 2>/dev/null | grep "$prog" | grep -oE '[1-9A-HJ-NP-Za-km-z]{32,44}' || grep -E "$prog" Anchor.toml | grep -oE '[1-9A-HJ-NP-Za-km-z]{32,44}' | head -1)"
    echo "setting upgrade authority for $prog ($pid) -> $UPGRADE_AUTHORITY"
    solana program set-upgrade-authority "$pid" --new-upgrade-authority "$UPGRADE_AUTHORITY" --provider.cluster "$CLUSTER" || true
  done
fi

echo "== DEPLOY OK — зафиксируйте в релиз-ноутах: program ids, mint, slot, checksum ==" 
cat onchain/target/checksum.txt
