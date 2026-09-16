# Upstream base

This repository is a **standalone derivative work** of DDNet. It is not a GitHub
"fork" (no `fork` relationship is registered on GitHub); it is an independent
repository that vendors a snapshot of the upstream source tree and then diverges.

| Field | Value |
| --- | --- |
| Upstream repository | https://github.com/ddnet/ddnet |
| Upstream branch | `master` (upstream default branch at import time) |
| Upstream commit SHA | `a853d333ac9e61ebfa2899b4641f8b0658ba60d5` |
| Upstream commit date | 2026-09-15T10:50:29+00:00 |
| Upstream commit subject | `Feature/UX: Add scoreboard cursor hint (#12847)` |
| Import date | 2026-09-15 (UTC) |
| Import method | `git clone --depth 1 --single-branch --branch master`, tracked files copied into a fresh history |
| Tracked files imported | 1852 (+ 1 submodule gitlink) |
| Worktree size at import | 69 MiB |
| Upstream submodule | `ddnet-libs` → https://github.com/ddnet/ddnet-libs @ `c0e6703fbcdbe03df2f26875427ec3951ce4ec21` (gitlink preserved, content **not** vendored) |
| This repository | https://github.com/Leo88q/neon-relay |
| `origin` | `https://github.com/Leo88q/neon-relay.git` |
| `upstream` remote | `https://github.com/ddnet/ddnet.git` (fetch only — **never** push to upstream) |

## Licensing position

* Upstream **code** is under the zlib/libpng-style license in [`license.txt`](license.txt),
  which explicitly permits commercial use, modification and redistribution, subject to
  three conditions: no misrepresentation of origin, altered versions plainly marked,
  and the notice must not be removed.
* Upstream **`data/`** content is CC-BY-SA 3.0 except assets/fonts/languages/skins,
  which carry their own licenses (see [`docs/UPSTREAM_AUDIT.md`](docs/UPSTREAM_AUDIT.md)
  and [`docs/ASSET_MANIFEST.csv`](docs/ASSET_MANIFEST.csv)).
* Nothing in this repository removes or rewrites upstream copyright notices. Branding
  changes are marked as alterations in [`docs/REBRANDING.md`](docs/REBRANDING.md), as
  required by clause 2 of the upstream license.

## How the import was produced

```bash
# 1. inspect upstream and pin the exact commit
git clone --depth 1 --single-branch --branch master https://github.com/ddnet/ddnet.git /tmp/ddnet-upstream
cd /tmp/ddnet-upstream
git rev-parse HEAD            # a853d333ac9e61ebfa2899b4641f8b0658ba60d5
git log -1 --format='%H %cI %s'

# 2. copy the tracked files of that commit into the standalone repository
git ls-files -z | tar --null -T - -cf - | (cd /path/to/neon-relay && tar -xf -)

# 3. preserve the ddnet-libs submodule gitlink without vendoring its content
cd /path/to/neon-relay
git update-index --add --cacheinfo 160000,c0e6703fbcdbe03df2f26875427ec3951ce4ec21,ddnet-libs

# 4. remotes
git remote add upstream https://github.com/ddnet/ddnet.git   # fetch only
git remote -v
```

`git filter-repo` was **not** used, and no legally required notice was stripped to
make the repository look cleaner.

## Baseline build status at import

The unmodified upstream tree was configured with CMake before any edit was made.
The configure step fails in the sandbox because the toolchain is missing
(`cargo`/Rust, SQLite3, libcurl, OpenSSL development packages) and the sandbox has no
route to `deb.debian.org`, `crates.io` or `static.rust-lang.org`.
Raw output: [`docs/baseline/cmake-configure-upstream.log`](docs/baseline/cmake-configure-upstream.log).
See [`docs/KNOWN_LIMITATIONS.md`](docs/KNOWN_LIMITATIONS.md) — blocker `BL-01`.

## Major changes since import

Ordered by stage; each stage is a separate commit on branch `arena/01a0a751-neon-relay`.

| # | Stage | What changed |
| --- | --- | --- |
| 0 | Baseline import | Verbatim snapshot of upstream `a853d33`, plus this file. |
| 1 | Repository metadata & audit | `docs/UPSTREAM_AUDIT.md`, baseline logs, CI relocation to `ci/upstream-reference/`. |
| 2 | Rebrand | Project/executable/Docker/CI/desktop-entry names, `GAME_NAME`, translated strings, `docs/REBRANDING.md`, `scripts/check_branding.sh`. |
| 3 | Assets | `docs/ASSET_MANIFEST.csv`, `docs/THIRD_PARTY_NOTICES.md`, `licenses/`, `scripts/check_assets.sh`, replacement of trademark artwork. |
| 4 | Android wallet layer | `android/` Gradle module, `wallet/*.kt` (Mobile Wallet Adapter), JNI bridge, C++ event surface. |
| 5 | Wallet authentication | `backend/` challenge/verify flow, Ed25519 verification, session tokens, `docs/WALLET_AUTH.md`. |
| 6 | Reward ledger | `backend/` idempotent ledger, caps, epochs, Merkle root, `docs/REWARD_SECURITY.md`, `docs/API.md`. |
| 7 | Server-signed match events | `src/neonrelay/` (server-side signing module, off by default) + local unit test harness. |
| 8 | Solana program | `onchain/` Anchor program, TS client/tests, `docs/SOLANA_ARCHITECTURE.md`, `docs/DEVNET_RUNBOOK.md`. |
| 9 | UI, CI/CD, docs, audit | Menu/settings wallet screens, `.github/workflows/`, remaining docs, final audit. |

## Assets: removed / replaced / kept

Full per-file detail lives in [`docs/ASSET_MANIFEST.csv`](docs/ASSET_MANIFEST.csv)
(columns: `path,sha256,type,author,copyright,license,source_url,attribution,action`).

* **Replaced in place** (same filenames, so the build graph is untouched): trademark
  artwork — `data/gui_logo.png`, the `other/icons/DDNet*` / `DDNet-Server*` raster icons.
  Replacements are original Neon Relay artwork generated for this project; provenance is
  recorded in the manifest.
* **Kept, but release-gated** (`action=block-release` in the manifest until a rights
  review is completed): upstream maps, skins, entities, country flags, sounds, themes,
  mapres, editor resources. These are third-party works under CC-BY-SA / CC-BY / zlib;
  they may not ship in a commercial build before the review recorded in
  [`docs/THIRD_PARTY_NOTICES.md`](docs/THIRD_PARTY_NOTICES.md).
* **Kept as-is** (legally required): `license.txt`, `data/*/license.txt`,
  `other/icons/license.txt`, font licenses, `src/engine/external/*/LICENSE*`, `.mailmap`.
* **Removed**: nothing at import time. Removals/replacements are listed in
  [`docs/REBRANDING.md`](docs/REBRANDING.md) with the reason for each change.
