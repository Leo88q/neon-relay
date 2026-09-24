#!/usr/bin/env bash
# Neon Relay — one-shot release pipeline for the operator MacBook.
#
# Stages (run in this order):
#   preflight  toolchain checks (Rust, Node >= 22.6, Agave >= 3.0.14, Anchor 0.31.1, Docker, jq)
#   update     git pull --ff-only + submodules (dirty worktree aborts unless FORCE_UPDATE=1)
#   lockfile   refresh onchain/Cargo.lock if the Anchor 0.31.1 pin gate fails (needs crates.io)
#   test       backend + onchain offline suites, cargo test --workspace --locked
#   build      anchor build (full workspace: .so + IDL)
#   deploy     onchain/scripts/deploy_prod.sh with an auto-generated devnet manifest
#              (FAIL-CLOSED: requires ALLOW_LIVE_DEPLOY=1, mirrors deploy_prod.sh)
#
# Usage:
#   ./scripts/macbook_release.sh all
#   ALLOW_LIVE_DEPLOY=1 ./scripts/macbook_release.sh deploy
#   ./scripts/macbook_release.sh <stage...>      # any subset of the stages above
#
# Environment:
#   BRANCH=main                    branch to update
#   FORCE_UPDATE=1                 stash local changes around the pull (auto-pop after)
#   CLUSTER=devnet                 deploy cluster (auto manifest generation: devnet only)
#   NEONRELAY_TEST_MINT=...        devnet reward test mint (created automatically if unset)
#   NEONRELAY_PAYMENT_TEST_MINT=.. devnet payment-slot test mint (created automatically if unset)
#   UPGRADE_AUTHORITY=...          manifest upgrade authority (default: operator wallet)
#   NO_AIRDROP=1                   skip `solana airdrop` in the deploy stage
#   AUDIT_ARTIFACT_DIR=~/neonrelay-release-artifacts   where the fresh audit artifact is stored
#   CONFIRM_MAINNET=YES            only for CLUSTER=mainnet-beta (see docs/PRODUCTION_DEPLOY_GATE.md)
#
# The script itself is always excluded from the dirty-worktree check, so installing
# it via `git checkout <branch> -- scripts/macbook_release.sh` does not block the pull.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLUSTER="${CLUSTER:-devnet}"
BRANCH="${BRANCH:-main}"
MANIFEST="onchain/deployment.${CLUSTER}.json"
MIN_AGAVE="3.0.14"
ANCHOR_PIN="0.31.1"
CANON_STAGES=(preflight update lockfile test build deploy)

if [ -t 1 ]; then
  C_STAGE=$'\033[1;36m'; C_OK=$'\033[1;32m'; C_WARN=$'\033[1;33m'; C_ERR=$'\033[1;31m'; C_OFF=$'\033[0m'
else
  C_STAGE=""; C_OK=""; C_WARN=""; C_ERR=""; C_OFF=""
fi
log()  { printf '\n%s== %s ==%s\n' "$C_STAGE" "$*" "$C_OFF"; }
ok()   { printf '%s  ok%s  %s\n' "$C_OK" "$C_OFF" "$*"; }
warn() { printf '%s  !%s  %s\n' "$C_WARN" "$C_OFF" "$*" >&2; }
die()  { printf '%s  x%s  %s\n' "$C_ERR" "$C_OFF" "$*" >&2; exit 1; }

usage() {
  sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

# ---------------------------------------------------------------- helpers ----
semver_ge() { # semver_ge A B -> 0 if A >= B
  [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n1)" = "$2" ]
}

solana_version() { solana --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1 || true; }
anchor_version() { anchor --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1 || true; }

need_cmd() { # need_cmd <tool> <install hint>
  command -v "$1" >/dev/null 2>&1 || die "$1 not found. Install: $2"
}

restore_stash() {
  if [ "${STASHED:-0}" = "1" ]; then
    cd "$ROOT"
    if git stash pop; then ok "local changes restored (git stash pop)"; else warn "git stash pop failed — run it manually"; fi
    STASHED=0
  fi
}
STASHED=0
trap restore_stash EXIT

# --------------------------------------------------------------- preflight --
stage_preflight() {
  log "preflight — toolchain"
  need_cmd git "xcode-select --install (or: git)"
  need_cmd node "brew install node   # requires Node >= 22.6"
  node -e 'const [M,m]=process.versions.node.split(".").map(Number); process.exit(M>22||(M===22&&m>=6)?0:1)' \
    || die "Node $(node --version) < 22.6 — backend/onchain suites need Node >= 22.6"
  need_cmd cargo "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
  need_cmd rustc "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
  ok "git / node $(node --version) / cargo $(cargo --version | awk '{print $2}')"

  local need_agave=0 need_anchor=0
  for s in "${STAGES[@]}"; do case "$s" in build|deploy) need_agave=1 need_anchor=1;; esac; done
  if [ "$need_agave" = "1" ]; then
    need_cmd solana 'sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"  # Agave >= '"$MIN_AGAVE"
    local sv; sv="$(solana_version)"
    semver_ge "${sv:-0.0.0}" "$MIN_AGAVE" || die "Agave $sv < required $MIN_AGAVE — upgrade the solana CLI"
    ok "Agave/Solana $sv (>= $MIN_AGAVE)"
    need_cmd anchor "sh -c \"\$(curl -sSfL https://release.anza.xyz/anchor-cli/$ANCHOR_PIN/install)\"   # or: avm install $ANCHOR_PIN"
    local av; av="$(anchor_version)"
    [ "$av" = "$ANCHOR_PIN" ] || die "Anchor $av != pinned $ANCHOR_PIN (Anchor.toml) — install exactly $ANCHOR_PIN"
    ok "Anchor $av"
  fi
  if [ "${DEPLOY_REQUESTED:-0}" = "1" ]; then
    need_cmd jq "brew install jq"
    need_cmd tsc "npm install -g typescript   # deploy_prod.sh requires a verified tsc"
    command -v docker >/dev/null 2>&1 || die "docker not found — the verifiable build is mandatory (deploy_prod.sh hard-fails without it)"
    docker info >/dev/null 2>&1 || die "Docker is not running — start Docker Desktop or colima (verifiable build)"
    ok "docker + jq + tsc present"
  fi
}

# ------------------------------------------------------------------ update --
stage_update() {
  log "update — git fetch/pull on branch '$BRANCH'"
  cd "$ROOT"
  git rev-parse --is-inside-work-tree >/dev/null || die "not a git repository: $ROOT"
  local cur; cur="$(git branch --show-current || true)"
  if [ "$cur" = "$BRANCH" ]; then
    local dirty
    dirty="$(git status --porcelain -- . ':(exclude)scripts/macbook_release.sh' || true)"
    if [ -n "$dirty" ]; then
      if [ "${FORCE_UPDATE:-0}" = "1" ]; then
        git stash push -u -m "macbook_release auto-stash $(date +%s)"
        STASHED=1
        warn "worktree was dirty — changes stashed (auto-restored on exit)"
      else
        printf '%s\n' "$dirty" >&2
        die "worktree has local changes — commit/stash them, or re-run with FORCE_UPDATE=1 (auto stash+restore)"
      fi
    fi
    git fetch origin
    git pull --ff-only origin "$BRANCH"
    ok "updated to $(git rev-parse --short HEAD) on $BRANCH"
  else
    warn "current branch '$cur' != '$BRANCH' — skipping pull (set BRANCH=$cur to update this branch)"
    git fetch origin || true
  fi
  git submodule update --init --recursive
  ok "submodules up to date"
}

# ---------------------------------------------------------------- lockfile --
stage_lockfile() {
  log "lockfile — Anchor $ANCHOR_PIN pin gate"
  cd "$ROOT/onchain"
  if node scripts/verify_toolchain_pin.mjs >/dev/null; then
    ok "onchain/Cargo.lock pinned to Anchor $ANCHOR_PIN"
  else
    # The committed lock predates the 0.31.1 migration. A blanket `cargo update`
    # re-resolves the whole graph to newest and hits solana/spl conflicts, so
    # regenerate from scratch: the manifests pin anchor-* = 0.31.1 and the
    # dev-deps pin the Solana 2.1.0 SDK family, which is a consistent set.
    warn "stale lockfile (expected: Anchor 0.30.x entry) — regenerating: rm Cargo.lock && cargo generate-lockfile (needs crates.io access)"
    rm -f Cargo.lock
    cargo generate-lockfile
    # The manifests declare caret requirements ("0.31.1"), so a fresh resolve lands
    # on the newest 0.31.x patch (0.31.2). The pin gate is exact, so walk the anchor
    # family back to 0.31.1. anchor-spl first: its 0.31.1 manifest re-pulls
    # spl-token-2022 ^6 and the whole step is atomic — on a registry where 0.31.1
    # is unresolvable the lock simply stays 0.31.2 and we report it.
    local pkg
    for pkg in anchor-attribute-access-control anchor-attribute-account anchor-attribute-constant \
               anchor-attribute-error anchor-attribute-event anchor-attribute-program \
               anchor-derive-accounts anchor-derive-serde anchor-derive-space \
               anchor-syn anchor-lang anchor-spl; do
      if grep -A1 "^name = \"$pkg\"$" Cargo.lock | grep -q 'version = "0.31.2"'; then
        echo "  -- downgrading $pkg 0.31.2 -> 0.31.1"
        cargo update -p "$pkg@0.31.2" --precise 0.31.1 \
          || { echo "FAILED at $pkg — the 0.31.1 manifest is not resolvable here; see docs/ANCHOR_MIGRATION_0_31.md" >&2; break; }
      fi
    done
    node scripts/verify_toolchain_pin.mjs || die "regenerated lock still does not match the $ANCHOR_PIN pin — inspect 'cargo tree -p anchor-lang -p anchor-spl'"
    ok "onchain/Cargo.lock regenerated to Anchor $ANCHOR_PIN"
    cd "$ROOT"
    if ! git diff --quiet --exit-code -- onchain/Cargo.lock; then
      warn "commit the refreshed lockfile: git add onchain/Cargo.lock && git commit -m 'onchain: refresh Cargo.lock to Anchor 0.31.1 (Solana 2.1.0 SDK)'"
    fi
  fi
}

# -------------------------------------------------------------------- test --
# The repo intentionally ships no node_modules; the tsc type gate needs
# @types/node (tsconfig "types": ["node"]). Install it locally without saving
# to package.json so the source tree stays untouched.
ensure_node_types() {
  if command -v tsc >/dev/null 2>&1 && [ ! -d "$1/node_modules/@types/node" ]; then
    echo "  -- $(basename "$1"): installing @types/node (npm --no-save, source untouched)"
    (cd "$1" && npm install --no-save --no-package-lock --no-audit --no-fund @types/node >/dev/null) \
      || warn "@types/node install failed in $1 — the typecheck gate will report TS2688"
  fi
}

stage_test() {
  log "test — backend + onchain + cargo (this is the long part on first run)"
  cd "$ROOT"
  ensure_node_types "$ROOT/backend"
  ensure_node_types "$ROOT/onchain"
  (cd backend && npm test && npm run typecheck)
  ok "backend: npm test + typecheck"
  (cd onchain && npm test && npm run typecheck && npm run verify:ids && npm run verify:toolchain)
  ok "onchain: npm test + typecheck + verify:ids + verify:toolchain"
  (cd onchain && cargo test --workspace --locked)
  ok "onchain: cargo test --workspace --locked"
}

# ------------------------------------------------------------------- build --
stage_build() {
  log "build — anchor build (whole workspace: .so + IDL)"
  cd "$ROOT/onchain"
  anchor build
  ok "anchor build finished — artifacts:"
  ls -1 target/deploy 2>/dev/null || true
  ls -1 target/idl 2>/dev/null || true
}

# ------------------------------------------------------------------ deploy --
stage_deploy() {
  log "deploy — cluster=$CLUSTER (official path: onchain/scripts/deploy_prod.sh)"
  [ "${ALLOW_LIVE_DEPLOY:-0}" = "1" ] || die "deploy is fail-closed. Re-run with: ALLOW_LIVE_DEPLOY=1 ./scripts/macbook_release.sh deploy"
  cd "$ROOT"

  case "$CLUSTER" in
    devnet|testnet) RPC_URL="https://api.$CLUSTER.solana.com" ;;
    mainnet-beta)   RPC_URL="https://api.mainnet-beta.solana.com" ;;
    *) die "unsupported CLUSTER: $CLUSTER" ;;
  esac

  # Operator wallet
  if [ ! -f "$HOME/.config/solana/id.json" ]; then
    solana-keygen new
    ok "created operator wallet ~/.config/solana/id.json"
  fi
  solana config set --url "$CLUSTER"
  [ -n "$(solana address)" ] || die "solana address returned nothing — check the wallet config"
  ok "operator wallet: $(solana address)"

  if [ "${NO_AIRDROP:-0}" != "1" ]; then
    solana airdrop 2 || warn "airdrop failed (faucet rate limit?) — if deploy fails on fees, fund the wallet manually"
  fi

  # Mints (devnet rehearsal only: throwaway test mints, labelled as such)
  local reward_mint="${NEONRELAY_TEST_MINT:-}" payment_mint="${NEONRELAY_PAYMENT_TEST_MINT:-}"
  create_test_mint() { # -> stdout: the new mint address
    ./onchain/scripts/create_test_mint.sh | sed -n 's/^NEONRELAY_TEST_MINT=//p' | head -n1
  }
  if [ -z "$reward_mint" ]; then
    warn "creating devnet reward test mint (throwaway, 6 decimals — NOT an official token)"
    reward_mint="$(create_test_mint)"; [ -n "$reward_mint" ] || die "could not create the reward test mint"
    ok "reward test mint: $reward_mint"
  fi
  if [ -z "$payment_mint" ]; then
    warn "creating devnet payment-slot test mint (throwaway — NOT an official token, no SKR exists)"
    payment_mint="$(create_test_mint)"; [ -n "$payment_mint" ] || die "could not create the payment test mint"
    ok "payment test mint: $payment_mint"
  fi
  [ "$reward_mint" != "$payment_mint" ] || die "reward and payment mints must be distinct"

  local genesis auth manifest="$ROOT/$MANIFEST"
  genesis="$(solana genesis-hash --url "$RPC_URL")"; [ -n "$genesis" ] || die "could not read the genesis hash from $CLUSTER"
  auth="${UPGRADE_AUTHORITY:-$(solana address)}"

  if [ -f "$manifest" ]; then
    warn "reusing existing manifest: $MANIFEST (delete it to regenerate)"
  elif [ "$CLUSTER" = "devnet" ]; then
    warn "no manifest yet — auto-generating $MANIFEST (devnet rehearsal; mints are labelled test mints)"
    node - "$ROOT" "$manifest" "$CLUSTER" "$genesis" "$auth" "$reward_mint" "$payment_mint" <<'EOF'
const [ , root, out, cluster, genesis, auth, reward, skr ] = process.argv;
const fs = require("node:fs");
const example = JSON.parse(fs.readFileSync(`${root}/onchain/deployment.example.json`, "utf8"));
const manifest = {
  _comment: "Auto-generated by scripts/macbook_release.sh. Devnet rehearsal manifest: both mints are throwaway devnet TEST mints (6 decimals), not an official token; no token named SKR exists.",
  manifest_kind: "devnet-rehearsal",
  cluster, genesis_hash: genesis, upgrade_authority: auth,
  mints: { reward, skr },
  programs: example.programs,
};
fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify(manifest, null, 2));
EOF
  else
    die "auto manifest generation is devnet-only. For $CLUSTER fill $MANIFEST by hand from onchain/deployment.example.json (see docs/PRODUCTION_DEPLOY_GATE.md)"
  fi

  # Fresh audit artifact OUTSIDE the checkout (the gate refuses reports inside it)
  local audit_dir="${AUDIT_ARTIFACT_DIR:-$HOME/neonrelay-release-artifacts}" audit_path
  if [ -n "${AUDIT_REPORT_PATH:-}" ]; then
    audit_path="$AUDIT_REPORT_PATH"
    ok "using provided audit artifact: $audit_path"
  else
    mkdir -p "$audit_dir"
    NEONRELAY_AUDIT_REPORT_DIR="$audit_dir" node scripts/generate_neonrelay_audit_report.mjs >/dev/null
    audit_path="$audit_dir/neon-relay-audit.json"
    [ -f "$audit_path" ] || die "failed to generate the audit artifact"
    ok "fresh audit artifact: $audit_path (keep it with the release records, outside the repo)"
  fi

  ok "manifest authority: $auth"
  ALLOW_LIVE_DEPLOY=1 \
  CLUSTER="$CLUSTER" \
  DEPLOYMENT_MANIFEST="$manifest" \
  AUDIT_REPORT_PATH="$audit_path" \
  onchain/scripts/deploy_prod.sh

  log "DEPLOY stage finished"
  cat <<EOF
  Next steps (docs/DEVNET_RUNBOOK.md §3-4, docs/PRODUCTION_DEPLOY_GATE.md 'Boot/unpause order'):
   1. initialize every program (rewards needs the reward test mint; configs start PAUSED)
   2. fund the rewards vault with the TEST mint only
   3. verify finalized RPC state, then explicitly unpause
   4. keep manifest + checksums + audit artifact in release storage, NOT in the source tree
EOF
}

# ------------------------------------------------------------------ main ----
STAGES=()
DEPLOY_REQUESTED=0
if [ "$#" -eq 0 ] || [ "${1:-}" = "all" ]; then
  STAGES=(preflight update lockfile test build)
elif [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage 0
else
  for a in "$@"; do
    case "$a" in
      all) STAGES+=(preflight update lockfile test build); continue ;;
      cpp) warn "'cpp' is not part of this pipeline — run ./scripts/local_syntax_probe.sh and ./scripts/neonrelay_signer_test.sh manually"; continue ;;
      deploy) DEPLOY_REQUESTED=1 ;;
      preflight|update|lockfile|test|build) : ;;
      *) die "unknown stage: $a (valid: ${CANON_STAGES[*]} all)" ;;
    esac
    STAGES+=("$a")
  done
  if ! printf '%s\n' "${STAGES[@]}" | grep -qx preflight; then
    STAGES=(preflight "${STAGES[@]}")
  fi
fi

printf '%sNeon Relay release pipeline%s — root: %s\n' "$C_STAGE" "$C_OFF" "$ROOT"
STARTED_AT="$(date +%s)"
for s in "${STAGES[@]}"; do
  case "$s" in
    preflight) stage_preflight ;;
    update)    stage_update ;;
    lockfile)  stage_lockfile ;;
    test)      stage_test ;;
    build)     stage_build ;;
    deploy)    stage_deploy ;;
  esac
done
ELAPSED=$(( $(date +%s) - STARTED_AT ))
printf '\n%sPipeline finished in %dm %02ds.%s\n' "$C_OK" $((ELAPSED/60)) $((ELAPSED%60)) "$C_OFF"
