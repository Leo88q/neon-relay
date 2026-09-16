# Final report — Neon Relay

Deliverable report for the staged build of **Neon Relay**: a standalone
commercial fork of DDNet targeting Solana Mobile (Seeker), with a
server-authoritative reward pipeline that settles on Solana. Repository:
`https://github.com/Leo88q/neon-relay`, branch
`arena/01a0a751-neon-relay`. Date of record: 2026-09-16.

This report lists **only real evidence**. Anything that could not be built or
executed in the development sandbox is named as a blocker with the exact
command and reason — nothing is presented as verified when it was not run, and
no mock is presented as production.

## 1. What was built

| Area | Artifact | State |
| --- | --- | --- |
| Standalone base | upstream DDNet `a853d33` imported verbatim, provenance in `UPSTREAM_BASE.md`, no GitHub fork relationship, `upstream` remote only | ✅ |
| Rebrand | identity, packaging, user-facing strings, 39 language files in lockstep, original logo/launcher art over the same filenames; legal attribution untouched (`docs/REBRANDING.md`, `docs/branding-scan.csv`) | ✅ |
| Assets | 878-row provenance manifest (180 `ship` / 698 `block-release`), verbatim SPDX license texts, failing-on-unknown release gate (`docs/ASSET_MANIFEST.csv`, `scripts/check_assets.sh`) | ✅ (legal review pending — BL-05) |
| Android / Solana Mobile | `android/` Gradle module: MWA wallet layer (`WalletManager`, `WalletSession`, `WalletHolder`, bridge activity), sanitized JNI bridge, lifecycle handling (`docs/ANDROID_SEEKER.md`) | ✅ source; ⛔ never compiled (BL-02/BL-06) |
| Wallet auth | challenge/verify with structured challenges (domain+expiry), single-use nonces, Ed25519 verification, hashed session tokens, rate limiting (`docs/WALLET_AUTH.md`, `backend/`) | ✅ tested |
| Reward ledger | server-signed event ingest, idempotency, per-match/daily/weekly caps, epochs, Merkle sealing, claim intents+confirmations, balances (`docs/REWARD_SECURITY.md`, `docs/API.md`) | ✅ tested |
| Game-server signing | vendored public-domain ed25519-donna, `src/neonrelay/match_signer.*`, finish hook in `CScore::SaveScore`, JSONL pickup file, 4 new `sv_neonrelay_*` config vars, CLI signer tool; off by default | ✅ source+probe+harness; ⛔ full server binary not built (BL-01) |
| On-chain | `onchain/` Anchor program (epochs, one-way root publication, claim PDAs, pause, no double claims, no hardcoded mint, devnet-only), TS Merkle mirror, offline suites (`docs/SOLANA_ARCHITECTURE.md`, `docs/DEVNET_RUNBOOK.md`) | ✅ source+offline tests; ⛔ never compiled (BL-03) |
| In-game Wallet UI | Settings → Wallet tab: honest states, connect/disconnect via the bridge, no earning claims | ✅ source+probe; ⛔ not run on device (BL-01/02) |
| CI | `.github/workflows/ci.yml` (5 jobs mirroring locally-evidenced gates) + self-testing secret scanner | ✅ committed; 🔴 never executed on GitHub (BL-12, account billing) |

## 2. Stage → commit map

| Stage | Commit | Content |
| --- | --- | --- |
| 0 | `96c5dad` | import upstream `a853d33` verbatim (base `dd0a63e`) |
| 1–2 | `90d59b8` | audit, baseline evidence, upstream CI relocation |
| 3 | `fb073ad`, `552dfd3` | rebrand part 1/2 (identity+strings; translations+artwork) |
| 4 | `76454f8` | asset manifest, notices, licenses, release gate |
| 5 | `98861a3` | Android module + MWA wallet layer + JNI bridge |
| 6 | `d05c65c` | backend wallet auth (challenges, sessions) |
| 7 | `6abed3c` | reward ledger (caps, epochs, Merkle, claims) |
| 8 | `cb7b53d` | game-server Ed25519 match signing + vendored ed25519-donna |
| 9 | `2985f19` | Anchor program + on-chain offline suites |
| 10 | `d3e1a71`, `7e16de1`, `60859a9`, this commit | CI, BL-12 record, in-game Wallet UI, closing docs |

## 3. Evidence actually executed (sandbox, 2026-09-16)

Every line below was run in the repository tree; reproduce with the same
command.

| # | Command | Result |
| --- | --- | --- |
| 1 | `./scripts/local_syntax_probe.sh` | **127 clean / 1 skipped (sqlite dep) / 0 failed**, RESULT: PASS — codegen + C++20 syntax probe of every server/base/shared/game TU incl. all Neon Relay additions |
| 2 | `./scripts/neonrelay_signer_test.sh` | **PASS** — gcc/g++ build of vendored ed25519-donna + signer + CLI tool; 2 events signed (incl. quotes/backslash/UTF-8/emoji torture); pubkey + both signatures cross-verified with `node:crypto`; tamper negatives fail. Log: `docs/baseline/neonrelay-signer-test.log` |
| 3 | `cd backend && npm test` | **30/30 pass** (Node v22.22.3, zero runtime deps): auth flows, forged-signature rejection, duplicates, caps, epoch sealing, claim intents/confirmations, balances, C++ golden-vector cross-check |
| 4 | `cd onchain && npm test` | **12/12 pass**: TS↔backend Merkle parity on randomized trees, golden leaf pinned identically to the Rust unit-test fixture, tamper negatives, static program conformance (seeds, fold direction, caps, pause/no-double-claim guards, no hardcoded mint, no SKR) |
| 5 | `./scripts/check_branding.sh --release --check-translations` | **PASS** (39 language files rebranded; zero `user-facing` upstream identifiers) |
| 6 | `./scripts/check_assets.sh --licenses` | **PASS** — 878 manifest rows verified (180 ship / 698 block-release), license texts complete |
| 7 | `python3 scripts/check_secrets.py --self-test && python3 scripts/check_secrets.py` | **PASS** — detector fires on all fixture classes; repo scan clean |
| 8 | `python3 scripts/check_config_variables.py` / `check_header_guards.py` / `tidy_alphabetical.py` / `check_standard_headers.py` | all **PASS** |
| 9 | `gh run watch 35052569158` (real GitHub Actions run) | **failed before job start**: account billing notice — recorded as BL-12, workflow itself unexecuted |
| 10 | `docs/baseline/partial-compile-probe*.log`, `cmake-configure-upstream.log` | baseline logs from stage 2 (pre/post-edit comparison) |

## 4. Not executed — blockers (honest list)

Full details with failing commands: [`KNOWN_LIMITATIONS.md`](KNOWN_LIMITATIONS.md).

| ID | Blocker | Consequence |
| --- | --- | --- |
| BL-01 | no full native toolchain (Rust, SDL2, Vulkan, SQLite, curl, OpenSSL…) | server/client binaries never built; C++ verified by syntax probe + targeted harness only |
| BL-02 | no Android SDK/Gradle | `android/` never compiled; wallet flows never ran on a device |
| BL-03 | no Rust/Solana/Anchor, no crates.io | Anchor program never compiled; `cargo test`/`anchor test` are runbook items |
| BL-04 | upstream Android template kept, superseded | reference only |
| BL-05 | 698 assets `block-release` | **release gate fails by design** until legal review |
| BL-06 | Maven coordinate `com.solana:mobile-wallet-adapter-clientlib:2.2.0` pinned offline | resolution unverified |
| BL-07 | no update/infra endpoints | out of scope so far |
| BL-08 | upstream developer docs kept as reference | intentional |
| BL-09 | license texts from SPDX, not licensor sites | verbatim, source pinned |
| BL-10 | no settings migration from DDNet | documented behavior + enum-shift note |
| BL-11 | `player_id` = in-game name in signed events | payouts bound to wallet links, not names |
| BL-12 | GitHub Actions billing rejection | CI committed but never executed |

## 5. Mocks vs production — explicit statements

* **No token exists.** Nothing named SKR was created; no mint is hardcoded
  anywhere; the devnet test mint is created by
  `onchain/scripts/create_test_mint.sh`, is throwaway, and is labelled "no
  value, not official" in every surface that mentions it.
* **The Anchor program is real source, never compiled here.** It is not a
  mock — but it is also not a verified binary. Do not deploy without running
  the BL-03 commands (`docs/DEVNET_RUNBOOK.md` §2).
* **The backend is production-shaped TypeScript with zero runtime deps**
  (node:http/crypto/sqlite). Tests run against ephemeral databases; hosting
  concerns (TLS, backups) are operator items in the checklist.
* **Signing keys in tests are documented public fixtures** (seed
  `deadbeef`×8). No production key material exists in this repository.
* **The declare_id in `lib.rs` and `PROGRAM_ID_PLACEHOLDER` are placeholders**,
  enforced consistent by tests, to be replaced with `anchor keys list` output.
* **The Android identity URI is a `.example` placeholder**
  (`docs/ANDROID_SEEKER.md`).
* **Game-server reward signing ships OFF by default** (`sv_neonrelay_signing
  0`); enabling it is an operator decision with a documented key ceremony.

## 6. One-shot reproduction

```bash
git clone https://github.com/Leo88q/neon-relay && cd neon-relay
git checkout arena/01a0a751-neon-relay
./scripts/local_syntax_probe.sh
./scripts/neonrelay_signer_test.sh
python3 scripts/check_secrets.py --self-test && python3 scripts/check_secrets.py
./scripts/check_branding.sh --release --check-translations
./scripts/check_assets.sh --licenses
python3 scripts/check_config_variables.py
python3 scripts/check_header_guards.py
python3 scripts/tidy_alphabetical.py
python3 scripts/check_standard_headers.py
(cd backend && npm test)
(cd onchain && npm test)
```

Requires: python3, gcc/g++ (C++20), Node ≥ 22. No network access needed.
