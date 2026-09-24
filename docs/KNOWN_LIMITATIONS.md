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
*Containment:* [`local_syntax_probe.sh`](../scripts/local_syntax_probe.sh) compiles the
tree (server + client, minus SDL/SQLite-dependent ones) with `-std=c++20` after running
the Python codegen — 134 clean / 1 skip / 0 fail at the last sandbox run (the 2026-09-16
baseline in [`baseline/partial-compile-probe-rebrand.log`](baseline/partial-compile-probe-rebrand.log)
reported 123).

### BL-02 — Android / Gradle build impossible in the sandbox
No JDK, no Android SDK/NDK, no route to Maven Central or Google Maven. The Gradle module,
Kotlin wallet layer and unit tests in `android/` are therefore **uncompiled** here.
*Containment:* MWA API usage was written against the upstream sources at tag `v2.2.0`
(commit `25296e124c5fdc30dc89f1ac0622b8cffefc5c8e`); see [`ANDROID_SEEKER.md`](ANDROID_SEEKER.md) §3.

### BL-03 — Solana / Anchor build impossible in the sandbox
No Rust/Solana/Anchor toolchain and no crates.io route, so the stage-9 program in `onchain/`
was **written but never compiled** here: `cargo test`, `anchor build`, `anchor test` and the
devnet deployment are a documented runbook (`onchain/README.md`), not executed procedures.
What *is* executed offline: `cd onchain && npm test` (50/50 — 6 Merkle-parity/tamper tests
against the backend mirror, 8 program-conformance tests binding `lib.rs`/`Anchor.toml` to the
TS constants, 8 rewards-claim client-contract tests spec-pinning the Kotlin builder, plus the
economy (15), features (6) and asset-manifest (7) suites) and a golden leaf vector pinned
identically for the Rust unit test, the backend and the TS client.
The source manifests now pin `anchor-lang`/`anchor-spl` to 0.31.1, but the
checked-in `Cargo.lock` still contains the prior 0.30.1 resolution and cannot be
refreshed without the unavailable Rust/crates toolchain. `onchain/scripts/
verify_toolchain_pin.mjs` therefore fails closed; this is an explicit unresolved
locked-build gate, not a production approval. Source IDs are pinned and drift-
checked, while live program IDs still require finalized RPC verification.

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

### BL-04 — upstream Android template still load-bearing
`scripts/android/files/**` (rebranded) still ships the upstream SDL activity/server service:
the `android/` module consumes the two classes plus `res/` as Gradle source dirs
(`android/app/build.gradle.kts`), and `scripts/android/cmake_android.sh` assembles the
CMake-driven APK build by copying the whole template into the build folder. Removing the
template was planned with the stage-10 CI rework, but that CI has no Android job (and BL-12
blocks any execution anyway), so the removal awaits a verified Android build pipeline that
no longer needs the template.

### BL-05 — 48 vendored assets are `block-release`
The original-art pass cut the gated set from 250 to 48: 173 files deleted,
the rest repainted or regenerated as originals (full account in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) §7). What remains is
unattributed CC-BY-SA 3.0 content — `data/shader/*` (32 files),
`data/maps/ctf*.map`, `data/maps/dm*.map`, `data/maps/coverage.map` (14 maps
with no author named anywhere in the tree) and the `warm-workshops` prototype
(2 files) — so the attribution required by CC-BY-SA 3.0 §4(b) cannot be
produced from the tree. They are vendored for development and gated by
`./scripts/check_assets.sh --release`, which fails until the rights review in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) §7 chooses: obtain authors,
replace the assets, or ship a good-faith attribution page plus the full license
text. (The audit also corrected 14 classic maps that the manifest had
mislabeled as BL-14 originals; they were never part of the 250.)

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

### BL-18 — remaining upstream art behind the release gate
Stage 16 replaced every visible sprite sheet (emoticons, particles, gui icons,
HUD, cursor, blob, flags, noise) with procedural originals. Stage 17 (BL-15 3/3)
also replaced every 0.6 skin sheet and every 0.7 mask, so skins are no longer on
this list. What remains upstream: `data/audio/*.wv` (the upstream WavPack
mirrors of every sample; the matching `.wav` is already Neon Relay), `data/maps*`
and `data/mapres/*` (gameplay maps need artists or a map generator),
`data/menuimages/*`, `data/communityicons/*`, `gui_buttons.png`, `extras.png`,
`game.png` and `data/themes/*.map` (BL-14). All stay block-release in
docs/ASSET_MANIFEST.csv until replaced or licensed.

### BL-17 — MWA flows await on-device verification
Stage 17 implemented the on-device builder (EconomyTxBuilder.kt: base58, PDA
with RFC 8032 on-curve test, ATA derivation, Anchor Borsh payloads, legacy
message compilation) plus the match-intent channel and public proof route.
The rewards `claim` builder followed the same pattern (RewardsTxBuilder.kt:
rewards PDAs with big-endian epoch seeds, config/epoch parsing, client-side
proof pre-verification, 9-account claim message; `runRewardsClaim` owns the
backend session, sealed-epoch discovery, intent fetch, send, finality poll and
the single claim-confirmation internally, fired by the in-game Wallet screen
Claim button through `neonrelay_wallet_request_rewards_claim`).
Its contract is pinned offline against the program source
(`onchain/test/rewards_claim.test.ts`, `backend/test/rewards_pda.test.ts`),
and the `signAndSendTransactions` call shape was corrected to the pinned
clientlib-ktx 2.x API (single transactions argument,
`result.signatures: Array<ByteArray>` — verified against upstream sources).
The Kotlin/Android layer still cannot be compiled or device-tested in the
offline sandbox (no Gradle/JVM toolchain, BL-06), so both flows await the
first Gradle build plus a physical Seeker/wallet-app dry run per
docs/DEVNET_RUNBOOK.md §5/§7 before mainnet money (BL-16 gate still
applies).

### BL-16 — SKR mainnet money gated on compliance sign-off
The economy program is mint-agnostic by design: the SKR (Solana Mobile Seeker
token) mint arrives as operator configuration (`NEONRELAY_SKR_MINT`, validated
at backend boot) and via `initialize()` on-chain; devnet uses a labelled test
mint. Real-money mainnet deployment additionally requires the compliance gate
of docs/PLAY_ECONOMY.md §7 (legal review, geo-restricted ToS, age gate, store
policy check). Until signed off, deployments stay devnet/test-mint only.

### BL-15 — vendoring gaps in platform-gated build templates
The initial import missed `cmake/checksummed_extra.txt` (unconditional CMake
input; restored in stage 13 with fork-local identity strings) and three
platform-gated templates: `other/manifest/client.manifest.in`,
`other/versioninfo/versioninfo.rc.in` (Windows builds) and
`scripts/ios/files/Info.plist.in` (iOS builds). macOS/Linux/Android configure
paths do not read the gated three; restoring them exactly is a follow-up once
those targets enter scope. `cmake/checksummed_extra.txt` is committed to the
tree (`git ls-files cmake/checksummed_extra.txt`) and the `checksummed_*`
`.gitignore` pattern does not match the `cmake/checksummed_extra.txt` path, so
the `git add -f` workaround is unnecessary.

The skin sweep (BL-15 3/3, this commit) regenerated every 0.6 sheet and every
0.7 mask with a unique procedural silhouette per name; see §5 of
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for the full list.

### BL-14 — menu theme maps and prefixed skin families are still upstream
Stage 12 generated original art for the gameplay-critical slots (default/ninja/spec
skins, eight neon skins, neon UI accent), but menu background *maps* (`data/themes/*.map`)
cannot be produced procedurally — a background map needs the in-game editor/tool pipeline
(BL-01). The release build therefore falls back to the "no theme" menu background with the
neon `ui_color` accent; original theme maps are a follow-up.

**BL-15 3/3 (skin sweep)**: as of the BL-15 3/3 commit, every prefixed upstream skin family
(`coala_*`, `kitty_*`, `santa_*`, the Whis family, Miper's `demonlimekitty`/`nanas`/`nersif`,
Ravie's `kitty_*`/`bomb`, Magnus Auvinen's 16 originals, `wartee`/Obst, the unnamed rest)
was redrawn with unique procedural silhouettes and per-name hue shifts; the 0.7 mask
tree (17 body silhouettes + 5 eye sets + 50 marking compositions + 7 decorations +
hands/feet mitts + bot chassis + xmas hat + 49 descriptors) was rebuilt as well.
`docs/ASSET_MANIFEST.csv` lists all 235 skin pixels as `ship` (Zlib), and BL-05
no longer mentions skins. The theme `.map` files are deleted; the remaining
art-side blockers are the shader tree and the 14 unattributed classic maps —
see §7 in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

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
