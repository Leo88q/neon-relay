#!/usr/bin/env bash
# Offline gates; not a substitute for a native client build or validator tests.
set -euo pipefail
cd "$(dirname "$0")/.."
python3 scripts/test_potato_assets.py
python3 scripts/test_menu_contract.py
python3 scripts/test_map_format.py
python3 scripts/test_reference_maps.py
python3 scripts/test_twmap_pipeline.py
python3 scripts/test_warmup.py
python3 scripts/test_warmup_server_contract.py
python3 scripts/test_potato_assets.py
python3 scripts/build_neon_ui_art.py --check
./scripts/check_assets.sh --licenses
./scripts/check_branding.sh --release --check-translations
python3 scripts/check_secrets.py
python3 scripts/check_config_variables.py
python3 scripts/check_header_guards.py
python3 scripts/tidy_alphabetical.py --dry-run
python3 scripts/check_standard_headers.py
python3 scripts/test_warmup_physics.py --sanitize
./scripts/local_syntax_probe.sh
./scripts/check_menu_syntax.sh
./scripts/neonrelay_signer_test.sh
(cd backend && npm test)
(cd onchain && npm test)
