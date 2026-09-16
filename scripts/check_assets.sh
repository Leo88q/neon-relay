#!/usr/bin/env bash
# Neon Relay asset gate.
#
#   ./scripts/check_assets.sh                 verify manifest coverage + hashes
#   ./scripts/check_assets.sh --release       also fail on block-release assets
#   ./scripts/check_assets.sh --licenses      also fail on missing license texts
#   ./scripts/check_assets.sh --regenerate    rewrite docs/ASSET_MANIFEST.csv first
#
# Exit code 0 = clean, 1 = violations, 2 = tool error.
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ "${1:-}" == "--regenerate" ]]; then
	shift
	python3 scripts/gen_asset_manifest.py
fi

python3 scripts/asset_check.py "$@"
