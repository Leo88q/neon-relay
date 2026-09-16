#!/usr/bin/env bash
# Neon Relay — forbidden branding check.
#
# Spec requirement: after the rebrand, every occurrence of the upstream names must be
# classified, and no occurrence may remain in user-facing branding.
#
#   ./scripts/check_branding.sh            # report + write docs/branding-scan.csv
#   ./scripts/check_branding.sh --release  # same, but exit non-zero if any occurrence is
#                                          # still classified as `user-facing`
#   ./scripts/check_branding.sh --check-translations
#                                          # also verify the language files are rebranded
#
# Categories (see scripts/branding_scan.py and docs/REBRANDING.md):
#   legal-attribution        upstream/third-party notices — MUST stay
#   historical-documentation documents that describe the derivation — allowed
#   code/api-identifier      protocol, UUID, crate, asset or symbol names — MUST stay
#   test-fixture             test data — allowed
#   comment                  source comments — allowed
#   user-facing              branding shown to players — MUST be gone

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." &> /dev/null && pwd)"
cd "$ROOT_DIR"

MODE=""
CHECK_TRANSLATIONS=0
for arg in "$@"; do
	case "$arg" in
		--release) MODE="--release" ;;
		--check-translations) CHECK_TRANSLATIONS=1 ;;
		-h | --help)
			sed -n '2,20p' "${BASH_SOURCE[0]}"
			exit 0
			;;
		*)
			echo "unknown argument: $arg" >&2
			exit 2
			;;
	esac
done

status=0

echo "== branding scan =="
if ! python3 scripts/branding_scan.py --csv docs/branding-scan.csv $MODE; then
	status=1
fi

if [ "$CHECK_TRANSLATIONS" -eq 1 ]; then
	echo
	echo "== translation files =="
	if ! python3 scripts/languages/rebrand_neonrelay.py --check; then
		status=1
	fi
fi

echo
if [ "$status" -eq 0 ]; then
	echo "check_branding: PASS"
else
	echo "check_branding: FAIL"
fi
exit "$status"
