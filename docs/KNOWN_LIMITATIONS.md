# Known limitations and blockers

Honest log of what could **not** be built, run or verified in this environment, and of the
open product/legal questions that gate a release. Every entry names the exact command that
failed (or the decision that is pending) and the workaround or gate that contains it.
Nothing in this repository is presented as verified when it was not run.

## Build / environment blockers

### BL-01 — full native build impossible in the sandbox
`cmake -GNinja ..` on the unmodified upstream tree fails: no Rust/Cargo toolchain, no
SQLite3/libcurl/OpenSSL development packages, and no route to `deb.debian.org`,
`crates.io` or `static.rust-lang.org`.
Raw output: [`baseline/cmake-configure-upstream.log`](baseline/cmake-configure-upstream.log).
*Containment:* [`local_syntax_probe.sh`](../scripts/local_syntax_probe.sh) compiles 124
translation units (server + client, minus SDL/SQLite-dependent ones) with `-std=c++20`
after running the Python codegen; result in
[`baseline/partial-compile-probe-rebrand.log`](baseline/partial-compile-probe-rebrand.log).

### BL-02 — Android / Gradle build impossible in the sandbox
No JDK, no Android SDK/NDK, no route to Maven Central or Google Maven. The Gradle module,
Kotlin wallet layer and unit tests in `android/` are therefore **uncompiled** here.
*Containment:* MWA API usage was written against the upstream sources at tag `v2.2.0`
(commit `25296e124c5fdc30dc89f1ac0622b8cffefc5c8e`); see [`ANDROID_SEEKER.md`](ANDROID_SEEKER.md) §3.

### BL-03 — Solana / Anchor build impossible in the sandbox
No Rust/Solana/Anchor toolchain and no crates.io route, so the stage-9 program in `onchain/`
was **written but never compiled** here: `cargo test`, `anchor build`, `anchor test` and the
devnet deployment are a documented runbook (`onchain/README.md`), not executed procedures.
What *is* executed offline: `cd onchain && npm test` (12/12 — Merkle parity with the backend,
tamper negatives, static conformance of `lib.rs`/`Anchor.toml` against the TS constants) and a
golden leaf vector pinned identically for the Rust unit test, the backend and the TS client.
The pinned `anchor-lang`/`anchor-spl` 0.30.1 coordinates are unverified offline (BL-06). The
`declare_id!` value is a generated PLACEHOLDER to be replaced with `anchor keys list` output
before any deployment.

### BL-06 — dependency coordinates pinned but unverifiable offline
`android/gradle/libs.versions.toml` pins `com.solana:mobile-wallet-adapter-clientlib:2.2.0`
(verified against the Git tag, not against Maven Central, which is unreachable) plus
Kotlin/AGP/androidx versions chosen to match the upstream template. The first real Gradle
build is the verification step; CI (stage 10) must fail loudly if a coordinate moved.

### BL-07 — no update/infrastructure endpoints exist yet
`AUTOUPDATE` is `OFF` and the updater URL points at the reserved `.example` TLD
(`https://update.neonrelay.example/%s`) so nothing can resolve accidentally. Real
infrastructure (update server, info service, master server) is a deployment task.

## Product / legal gates

### BL-04 — upstream Android template superseded, not deleted
`scripts/android/files/**` (rebranded) still ships the upstream SDL activity/server service;
the new `android/` module reuses those two classes as sources. Removing the template
outright happens with the CI rework (stage 10).

### BL-05 — 698 vendored assets are `block-release`
Upstream applies CC-BY-SA 3.0 to `data/audio`, `data/countryflags`, `data/mapres`,
`data/themes`, `data/editor`, `data/shader`, unnamed maps/skins/entities and the whole
`data/skins7` tree **without naming authors**, so the attribution required by CC-BY-SA 3.0
§4(b) cannot be produced from the tree. They are vendored for development and gated by
`./scripts/check_assets.sh --release`, which fails until the rights review in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) §7 chooses: obtain authors, replace the
assets, or ship a good-faith attribution page plus the full license text.

### BL-08 — upstream developer docs kept as reference
`docs/BUILDING*.md`, `docs/DEBUGGING.md`, `docs/CONTRIBUTING.md`, `docs/DATABASE.md` and
`ci/upstream-reference/**` still describe upstream commands/paths. They are excluded from
the branding gate as historical documentation and must be rewritten or removed before
release.

### BL-09 — verbatim CC/OFL legal codes bundled from SPDX, not from the licensors
`licenses/` contains the SPDX license-list-data texts (commit
`16f3aa6c3bdd62e50f8b1cf618f32d2a510250ee`). CreativeCommons.org and scripts.sil.org are
unreachable from the sandbox; the release checklist requires re-fetching the legal codes
from the licensors' sites and diffing before shipping.

### BL-10 — settings migration not implemented
A Neon Relay client starts with default settings (`settings_neonrelay.cfg`) and does not
import an existing `settings_ddnet.cfg`; maps/skins/demos are still found through the
legacy user-directory fallbacks in `src/engine/shared/storage.cpp`. Documented behaviour,
not a defect; a migration wizard is a possible follow-up. The
stage-10 Settings → Wallet tab inserts `SETTINGS_WALLET` into the settings-page enum, which
shifts the meaning of a persisted `ui_settings_page` value for the Credits page (index +1);
an upgrading player who left the menu on Credits lands on Wallet once. Same BL-10 class:
documented, cosmetic, no migration.

### BL-12 — GitHub Actions cannot execute on the repository's account
`.github/workflows/ci.yml` (stage 10) is committed, parses as valid YAML and every gate it runs
was executed green locally in the same tree (11/11 commands, see the stage-10 commit message).
The first real run ([run 35052569158](https://github.com/Leo88q/neon-relay/actions/runs/35052569158),
2026-09-16) failed before any job started with GitHub's billing notice: *"The job was not
started because recent account payments have failed or your spending limit needs to be
increased."* This is an account-level blocker outside the repository. Once billing is fixed in
GitHub → Settings → Billing & plans, re-run with `gh run rerun 35052569158` or push any commit;
no workflow change is expected to be needed.

### BL-13 — features program has no gameplay producer yet; badge metadata is off-chain
The stage-11 `neonrelay-features` program (achievements, badges, leaderboards, tournaments)
is complete as a contract, but nothing in the game server emits achievements yet: an operator
service must derive them from server-verified data (teehistorian/ledger) and call
`record_achievement` — integration is future work. Badge tokens carry no on-chain metadata:
no metaplex/token-metadata crate is vendored because its coordinates could not be verified
offline (same class as BL-06); names/art are served by the backend until a reviewed dependency
is added. The program itself shares BL-03 (written, never compiled in the sandbox).

### BL-11 — signed events identify players by in-game name
Stage-8 match events (`src/game/server/neonrelay_events.cpp`) set `player_id` to the
client's current in-game name, because the game server has no account system. Names are
neither unique nor stable, so the reward backend treats `player_id` only as a correlation
hint: actual payout requires a wallet link (`POST /v1/wallet/link` with a wallet-signed
challenge, see [`WALLET_AUTH.md`](WALLET_AUTH.md)) and caps are enforced per linked
player. A future stage should replace the name with a backend-issued player id fetched
during wallet login. The signing itself is unaffected — signatures cover whatever
`player_id` the server wrote.
