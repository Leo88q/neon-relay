#!/usr/bin/env bash
# Isolated local network only. No persistent keys or operator wallet required.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
TMP="$(mktemp -d)"
PID=""
cleanup() {
  if [[ -n "$PID" ]]; then kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; fi
  rm -rf "$TMP"
}
trap cleanup EXIT
export NEONRELAY_LOCAL_VALIDATOR=1
export NEONRELAY_PUBLIC_FIXTURE="$TMP/public-accounts.json"
# The legacy bootstrap only accepts the program's UPGRADE AUTHORITY as
# signer. So deploy the ELF explicitly with a disposable key (it becomes
# the upgrade authority), and make that same key the test's admin.
# SOLANA_CONFIG points the CLI — and thus the deployer — at the
# throwaway keypair only; no persisted keys are ever created.
BOOTSTRAP_KEY="$TMP/bootstrap.json"
solana-keygen new --no-bip39-passphrase --force -s -o "$BOOTSTRAP_KEY" > /dev/null
export NEONRELAY_BOOTSTRAP_KEYPAIR="$BOOTSTRAP_KEY"
export SOLANA_CONFIG="$TMP/solana-config"
mkdir -p "$SOLANA_CONFIG"
cp "$BOOTSTRAP_KEY" "$SOLANA_CONFIG/id.json"
solana-test-validator --reset --ledger "$TMP/ledger" --bind-address 127.0.0.1 --rpc-port 8899 \
  >"$TMP/validator.log" 2>&1 &
PID=$!
export VALIDATOR_PID="$PID"
if ! python3 - <<'PY'
import json, os, time, urllib.request
for _ in range(120):
    os.kill(int(os.environ['VALIDATOR_PID']), 0)
    try:
        req = urllib.request.Request('http://127.0.0.1:8899', data=b'{"jsonrpc":"2.0","id":1,"method":"getHealth"}', headers={'Content-Type':'application/json'})
        with urllib.request.urlopen(req, timeout=1) as response:
            if json.load(response).get('result') == 'ok':
                break
    except (OSError, ValueError):
        pass
    time.sleep(1)
else:
    raise RuntimeError('isolated validator did not become healthy')
PY
then
  tail -40 "$TMP/validator.log"
  exit 1
fi
# Fund the bootstrap key (rent for the program account + the airdrops it
# will pay for) and deploy the economy ELF as that key.
BOOT_PUBKEY="$(solana-keygen pubkey "$BOOTSTRAP_KEY" 2>/dev/null | awk '{print $NF}')"
[ -n "$BOOT_PUBKEY" ] || { echo "could not derive bootstrap pubkey"; exit 1; }
solana config set --url http://127.0.0.1:8899 >"$TMP/deploy.log" 2>&1
solana request-airdrop 25 "$BOOT_PUBKEY" >>"$TMP/deploy.log" 2>&1 || {
  tail -40 "$TMP/deploy.log"; tail -20 "$TMP/validator.log"; exit 1; }
for _ in $(seq 1 90); do
  bal="$(solana balance "$BOOT_PUBKEY" 2>/dev/null | awk '{print $2}')"
  if [ -n "$bal" ] && python3 -c "import sys; sys.exit(0 if float('${bal:-0}') >= 1.0 else 1)"; then
    break
  fi
  sleep 1
done
solana balance "$BOOT_PUBKEY" >>"$TMP/deploy.log" 2>&1 || { tail -40 "$TMP/deploy.log"; exit 1; }
solana program deploy --program-id FZcLDdUrs6i1HYFFK2NhqNrbVaP6KTvrqzhyoDGT6CV9 \
  "$ROOT/onchain/target/deploy/neonrelay_economy.so" >>"$TMP/deploy.log" 2>&1 || {
  tail -40 "$TMP/deploy.log"; tail -20 "$TMP/validator.log"; exit 1; }
RUST_LOG=error cargo test --manifest-path onchain/Cargo.toml -p neonrelay-economy \
  --test v2_validator -- --ignored --test-threads=1
node --experimental-strip-types onchain/scripts/verify_validator_rpc.ts
