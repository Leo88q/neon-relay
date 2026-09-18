#!/usr/bin/env bash
# Offline gates; not a substitute for a native client build or validator tests.
set -euo pipefail
cd "$(dirname "$0")/.."
python3 scripts/test_potato_assets.py
python3 scripts/test_menu_contract.py
./scripts/check_assets.sh --licenses
./scripts/check_branding.sh --release --check-translations
python3 scripts/check_secrets.py
python3 scripts/check_config_variables.py
./scripts/local_syntax_probe.sh
./scripts/check_menu_syntax.sh
./scripts/neonrelay_signer_test.sh
(cd backend && npm test)
(cd onchain && npm test)
