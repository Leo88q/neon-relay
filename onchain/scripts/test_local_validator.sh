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
# signer. The genesis --bpf-program deploy is performed by the validator's
# default keypair (the identity, since no separate --mint is given), so run
# the validator with a throwaway key as its identity: that key becomes the
# upgrade authority, and the test loads the same key as admin. No persisted
# keys are ever created.
BOOTSTRAP_KEY="$TMP/bootstrap.json"
solana-keygen new --no-bip39-passphrase --force -s -o "$BOOTSTRAP_KEY" > /dev/null
export NEONRELAY_BOOTSTRAP_KEYPAIR="$BOOTSTRAP_KEY"
solana-test-validator --reset --ledger "$TMP/ledger" --bind-address 127.0.0.1 --rpc-port 8899 \
  --identity "$BOOTSTRAP_KEY" \
  --bpf-program FZcLDdUrs6i1HYFFK2NhqNrbVaP6KTvrqzhyoDGT6CV9 \
  "$ROOT/onchain/target/deploy/neonrelay_economy.so" >"$TMP/validator.log" 2>&1 &
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
RUST_LOG=error cargo test --manifest-path onchain/Cargo.toml -p neonrelay-economy \
  --test v2_validator -- --ignored --test-threads=1
node --experimental-strip-types onchain/scripts/verify_validator_rpc.ts
