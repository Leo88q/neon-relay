# Neon Relay

**Neon Relay** is a standalone, commercially developed 2D multiplayer race game built on a
vendored snapshot of [DDRaceNetwork (DDNet)](https://github.com/ddnet/ddnet) and extended
with a Solana Mobile / Seeker client: on-device wallet connection through the Mobile Wallet
Adapter, server-signed match results, and an audited, epoch-based reward ledger that players
claim on-chain themselves.

This repository is **not** a GitHub fork. It is an independent repository that imported the
upstream tree at a pinned commit and has been diverging since — see
[`UPSTREAM_BASE.md`](UPSTREAM_BASE.md).

| | |
| --- | --- |
| Product name | Neon Relay |
| Repository slug | `neon-relay` |
| Internal identifier | `neonrelay` |
| Client / server binaries | `neonrelay` / `neonrelay-server` |
| Android applicationId | `com.leo88q.neonrelay` |
| Upstream base | `ddnet/ddnet` @ [`a853d33`](https://github.com/ddnet/ddnet/commit/a853d333ac9e61ebfa2899b4641f8b0658ba60d5) |
| License | zlib-style for code ([`license.txt`](license.txt)); `data/` is CC-BY-SA 3.0 except where stated |
| Default branch | `main` (feature work lands via pull requests) |

---

## What this is — and what it is not

* **The gameplay is server-authoritative and completely independent of any blockchain.**
  Match simulation, race timing, teams and physics run in the C++ server exactly as upstream
  does. Solana is used **only** for reward accounting: a player binds a wallet, plays, the
  server signs a match result, the backend enforces caps and idempotency, an epoch publishes
  a Merkle root, and the player claims their own allocation through an Anchor program.
* **No private keys, seed phrases or signing keys ever live in the client or in this
  repository.** The Android client asks the on-device wallet to sign a challenge through the
  Mobile Wallet Adapter; signing happens inside the wallet app and never returns key
  material. Backend signing keys and treasury authority are supplied at deployment time
  through environment/secret stores and are absent from source, tests and CI.
* **There is no token in this repository.** The Solana program is mint-agnostic: a reward
  mint is configured per environment, devnet runs use a throwaway test mint explicitly
  labelled as not official, and no mainnet mint address is hardcoded anywhere. Nothing here
  promises earnings, appreciation or returns.
* **This is not a drop-in replacement for DDNet.** The network protocol version is
  unchanged so Neon Relay clients and servers can talk to each other, but branding,
  packaging, server list and info-service defaults are different, and the Solana features are
  new.

## Project status

The project is delivered in stages; each stage is a separate, reviewable commit. This
snapshot is complete through **stage 3 (assets)**; stages 4–9 are in progress.

| Stage | Content | Status |
| --- | --- | --- |
| 0 | Import upstream `a853d33` verbatim, pin provenance | ✅ committed |
| 1 | Audit: `docs/UPSTREAM_AUDIT.md` | ✅ committed |
| 2 | Baseline build evidence, compile probe, upstream CI relocation | ✅ committed |
| 3 | Rebrand: identity, packaging, user-facing strings, translations, icons | ✅ committed |
| 4 | Assets: manifest, third-party notices, `scripts/check_assets.sh`, artwork replacement | 🚧 in progress |
| 5 | Android/Seeker module + Kotlin Mobile Wallet Adapter layer + JNI bridge | ⬜ |
| 6 | Wallet challenge/verify authentication, session tokens, `docs/WALLET_AUTH.md` | ⬜ |
| 7 | Reward ledger: idempotency, caps, epochs, Merkle root, `docs/REWARD_SECURITY.md`, `docs/API.md` | ⬜ |
| 8 | Server-side match signing (`src/neonrelay/`) | ⬜ |
| 9 | Solana Anchor program + TS client/tests | ⬜ |
| 10 | In-game Wallet UI, CI/CD, remaining docs, final audit | ⬜ |

Everything that could not be built or executed in this environment is recorded honestly in
[`docs/KNOWN_LIMITATIONS.md`](docs/KNOWN_LIMITATIONS.md) with the exact command that failed
and the reason (missing Rust toolchain, Android SDK, no route to crates.io, etc.). Nothing
in the documentation is presented as verified when it was not run.

## Repository layout

| Path | Contents |
| --- | --- |
| `src/engine`, `src/game`, `src/rust-bridge`, `src/mastersrv`, `src/masterping`, `src/tools`, `src/test` | upstream C++/Rust client, server, protocol, tools and tests |
| `src/neonrelay/` | **new** server-side modules: wallet event bridge (stage 5), Ed25519 match-event signer (stage 8; vendored public-domain `ed25519-donna` in `src/engine/external/ed25519`, signed events emitted by `src/game/server/neonrelay_events.cpp`, CLI helper `src/tools/neonrelay_match_sign.cpp`) |
| `android/` | **new** Gradle module for Android / Solana Mobile: wallet adapter, JNI bridge, UI (stage 5) |
| `backend/` | **new** TypeScript (Node 22) API: wallet auth, reward ledger, epochs, claim intents (stages 6–7) |
| `onchain/` | **new** Anchor program + TS client/tests: epochs, Merkle root, claim PDAs, pause (stage 9) |
| `licenses/` | verbatim third-party license texts referenced by `docs/THIRD_PARTY_NOTICES.md` (stage 4) |
| `scripts/android/files/**` | upstream Android template, superseded by `android/` |
| `data/` | game assets: maps, skins, entities, sounds, languages, mapres, themes, editor resources |
| `other/` | packaging helpers: icons, desktop entry, Docker, emscripten shell, vim syntax, Xcode project |
| `docs/` | all project documentation (index below) |
| `ci/upstream-reference/` | the upstream GitHub Actions workflows, kept for reference only |

## Building

The upstream build instructions still apply and were kept intentionally so that divergence
stays reviewable:

* [`docs/BUILDING.md`](docs/BUILDING.md) — Linux, macOS, Windows
* [`docs/BUILDING-android.md`](docs/BUILDING-android.md) — Android
* [`docs/BUILDING-ios.md`](docs/BUILDING-ios.md) — iOS
* [`docs/BUILDING-emscripten.md`](docs/BUILDING-emscripten.md) — WebAssembly
* [`docs/DEBUGGING.md`](docs/DEBUGGING.md), [`docs/DATABASE.md`](docs/DATABASE.md),
  [`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md), [`docs/BENCHMARKING.md`](docs/BENCHMARKING.md)

Quick start (desktop client + server):

```sh
git clone --depth 1 --recursive --shallow-submodules https://github.com/Leo88q/neon-relay
cd neon-relay
mkdir build && cd build
cmake -GNinja ..
ninja neonrelay neonrelay-server
```

Neon Relay adds two verification scripts that need no toolchain beyond Python 3 and a C++
compiler:

```sh
./scripts/check_branding.sh --release --check-translations   # branding classification + gate
./scripts/check_assets.sh                                    # asset manifest integrity
./scripts/local_syntax_probe.sh                              # compile probe for the edited sources
```

## Documentation index

| Document | Purpose |
| --- | --- |
| [`UPSTREAM_BASE.md`](UPSTREAM_BASE.md) | upstream commit, import method, licensing position |
| [`docs/UPSTREAM_AUDIT.md`](docs/UPSTREAM_AUDIT.md) | what upstream contains, where the integration points are |
| [`docs/REBRANDING.md`](docs/REBRANDING.md) | every branding change: old value, new value, path, why safe, what was deliberately kept |
| [`docs/branding-scan.csv`](docs/branding-scan.csv) | machine-readable classification of every remaining upstream identifier |
| [`docs/ASSET_MANIFEST.csv`](docs/ASSET_MANIFEST.csv) | per-file asset provenance: sha256, author, copyright, license, source, action |
| [`docs/THIRD_PARTY_NOTICES.md`](docs/THIRD_PARTY_NOTICES.md) | third-party works shipped in `data/` and their rights status |
| [`docs/ANDROID_SEEKER.md`](docs/ANDROID_SEEKER.md) | Solana Mobile / Seeker build, wallet adapter layer, JNI contract |
| [`docs/WALLET_AUTH.md`](docs/WALLET_AUTH.md) | wallet challenge, Ed25519 verification, session tokens, threat handling |
| [`docs/REWARD_SECURITY.md`](docs/REWARD_SECURITY.md) | server-signed match events, idempotency, caps, epochs |
| [`docs/API.md`](docs/API.md) | backend REST contract |
| [`docs/SOLANA_ARCHITECTURE.md`](docs/SOLANA_ARCHITECTURE.md), [`docs/DEVNET_RUNBOOK.md`](docs/DEVNET_RUNBOOK.md) | Anchor program design and devnet procedure |
| [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md), [`docs/RELEASE_CHECKLIST.md`](docs/RELEASE_CHECKLIST.md), [`docs/KNOWN_LIMITATIONS.md`](docs/KNOWN_LIMITATIONS.md) | risk assessment, release gating, honest blocker log |
| [`docs/baseline/`](docs/baseline) | raw build/probe logs recorded before and after edits |

## License and attribution

Code is under the zlib/libpng-style license in [`license.txt`](license.txt). The game assets
in `data/` are CC-BY-SA 3.0 except `assets`, `fonts`, `languages` and `skins`, which carry
their own terms; see [`docs/THIRD_PARTY_NOTICES.md`](docs/THIRD_PARTY_NOTICES.md).

* Upstream copyright notices are kept verbatim. Nothing was removed to make the project look
  cleaner, and `git filter-repo` was never used to rewrite legally significant content.
* The branding changes are plainly marked as alterations in
  [`docs/REBRANDING.md`](docs/REBRANDING.md), as required by clause 2 of the upstream license.
* DDNet, DDRaceNetwork and Teeworlds are the names of the upstream projects from which this
  work is derived. They are used in this repository only in provenance, legal and
  compatibility contexts, and their trademarks are not claimed by this project.

## Contributing

Report issues and open pull requests against `main`. Any change that touches user-facing
branding must keep `./scripts/check_branding.sh --release` passing, and any change to a
shipped asset must update [`docs/ASSET_MANIFEST.csv`](docs/ASSET_MANIFEST.csv).
