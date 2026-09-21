# Upstream audit — DDNet → Neon Relay

Audit of the imported snapshot **before** any modification was made.

| Field | Value |
| --- | --- |
| Upstream | https://github.com/ddnet/ddnet |
| Branch | `master` |
| Commit | `a853d333ac9e61ebfa2899b4641f8b0658ba60d5` (2026-09-15T10:50:29+00:00) |
| Tracked files | 1852 + 1 submodule gitlink (`ddnet-libs` @ `c0e6703`) |
| Worktree size | 69 MiB (`data/` = 54 MiB, `src/` = 13 MiB) |
| Audit date | 2026-09-15 |

Method: every `LICENSE`/`COPYING`/`license.txt`/`readme.txt` file in the tree was opened
and read (`git ls-files | grep -iE 'licen|copying|notice|readme'`). No conclusion in this
document is derived from a GitHub badge or from the repository description.

---

## 1. Provenance: which part comes from where

DDNet is a layer cake. Knowing which layer a file belongs to matters because the copyright
holders and the license texts differ.

| Layer | Period | Copyright holder(s) | Where it lives today |
| --- | --- | --- | --- |
| **Teeworlds** (original game) | 2007–2014 | Magnus Auvinen | `src/base/`, `src/engine/` (client/server/shared), `src/game/gamecore.cpp`, `data/maps7/`, `data/skins7/`, most of `datasrc/`, file headers `/* (c) Magnus Auvinen. See licence.txt ... */` |
| **DDRace** (race mod) | 2010–2011 | Shereef Marzouk | `src/game/server/gamemodes/ddrace.*`, `src/game/server/entities/*`, `ddracechat.cpp`, `ddracecommands.cpp`, `teams.cpp`, `ClShowhudDDRace`-style settings |
| **DDNet** (DDraceNetwork fork) | 2011–today | Dennis Felsing + DDNet contributors | `src/game/server/score*.cpp`, `save*.cpp`, `teehistorian*.cpp`, `src/mastersrv/`, `src/masterping/`, `src/engine/server/databases/`, `src/game/client/components/menus_settings_ddnet.cpp`, most of `data/maps/`, `data/skins/`, `data/languages/` |
| **Bundled third-party code** | — | various | `src/engine/external/{zlib,glew,json-parser,md5}`, `src/rust-bridge/`, `Cargo.toml`/`Cargo.lock` |
| **Prebuilt third-party binaries** | — | various | `ddnet-libs/` submodule (not vendored here, gitlink only) |

The three-layer copyright statement is verbatim at the top of [`license.txt`](../license.txt).

## 2. License inventory (read from the files, not from badges)

### 2.1 Code

| File | License | Notes |
| --- | --- | --- |
| `license.txt` (root) | **zlib/libpng-style** | Teeworlds / DDRace / DDNet copyrights. Explicitly permits commercial use, modification and redistribution under 3 conditions: (1) origin not misrepresented, (2) altered versions plainly marked, (3) notice not removed. This repository satisfies (2) via `docs/REBRANDING.md` and `UPSTREAM_BASE.md`, and (3) by keeping the file untouched. |
| `src/engine/external/zlib` | zlib | Bundled, used when no system zlib is found. |
| `src/engine/external/glew/LICENSE.txt` | BSD-3-Clause-like (GLEW license: BSD + MIT + Khronos) | Bundled. |
| `src/engine/external/json-parser/LICENSE` | BSD-2-Clause ("the json-parser authors") | Bundled. |
| `src/engine/external/md5/md5.h` | zlib-style (Aladdin Enterprises 1999, 2002) | Bundled. |
| `Cargo.toml` / `Cargo.lock` / `deny.toml` | Rust crates, mixed | `deny.toml` is upstream's `cargo-deny` config — reuse it in CI; it is the authoritative list of crate licenses for the Rust bridge. |
| `.gitmodules` → `ddnet-libs` | third-party prebuilt binaries | SDL2, FreeType, libpng, Ogg/Opus/Opusfile, SQLite3, curl, WavPack, FFmpeg, GLEW, Vulkan/glslang, Discord SDK, and the SDL Java bindings (`ddnet-libs/sdl/java/org`). **Each must be reviewed before shipping in a commercial APK/AAB** — see §3. |

**Consequence for Neon Relay:** the code base is *not* GPL. Commercial redistribution is
permitted by the zlib-style license. The obligation is attribution + marking alterations,
not source disclosure. Mixed-in crate and bundled-library licenses are permissive
(BSD/MIT/zlib/Apache-2.0) but must be reproduced in `docs/THIRD_PARTY_NOTICES.md`.

### 2.2 Data / assets

| Path | License (from the actual file) | Attribution present? |
| --- | --- | --- |
| `data/**` (default rule, stated in root `license.txt`) | **CC-BY-SA 3.0**, *except* assets, fonts, languages and skins which have their own licenses | **No named authors** for `data/audio`, `data/countryflags`, `data/mapres`, `data/themes`, `data/editor`, `data/menuimages`, `data/shader`, `data/communityicons` → attribution gap, see §3 |
| `data/maps/license.txt` | CC-BY-SA per map, authors named (`Gold Mine` © `<BµmM>`, `LearnToPlay` © Tridemy & Cøke, `Sunny Side Up` © Ravie (grass_main redrawn from Teeworlds `grass_main` mapres, Apache-2.0), `Tsunami` © louis, `Tutorial` © unique2 & Alisa) | Yes |
| `data/maps7/readme.txt` | Teeworlds 0.7 maps | Partial |
| `data/skins/license.txt` | mixed: zlib © Magnus Auvinen (16 skins), **CC-BY** © Whis (~30 skins), CC-BY-SA © DanilBest (coala_*), CC-BY-SA © forsaken (santa_*), kitty_*/bomb_* (see file) | Yes |
| `data/skins7/*.json` + `body/…` | Teeworlds 0.7 skin system; no per-file license | **No** |
| `data/languages/license.txt` | CC-BY-SA 3.0, authors listed inside each `.txt` | Yes (per file) |
| `data/assets/entities/license.txt` | CC-BY-SA 3.0 © louis ("comfort") | Yes |
| `data/fonts/DejaVuSans.ttf` | Bitstream Vera license + Arev (Tavmjong Bah) license, DejaVu changes public domain | Yes (root `license.txt`) |
| `data/fonts/Font_Awesome_6_Free-Solid-900.otf` | SIL OFL 1.1, © 2023 Fonticons Inc., Reserved Font Name "Font Awesome" | Yes |
| `data/fonts/GlowSansJ-Compressed-Book.otf` | SIL OFL 1.1, © 2020 Project Wêlai | Yes |
| `data/fonts/SourceHanSans.ttc` | SIL OFL 1.1, © 2014–2021 Adobe, Reserved Font Name "Source" | Yes |
| `other/icons/license.txt` | "Icons by Ravie" — **no license grant stated** | Author only → must be replaced |
| `other/dmgbackground*.png`, `other/emscripten/background.png` | no license file | Unknown → replace |
| `data/gui_logo.png`, `other/icons/DDNet*.ico/icns/png`, `data/communityicons/*` | trademark artwork | **Must not be shipped** |

### 2.3 Font sizes

`data/fonts` alone is 30 MiB of the 54 MiB `data/` directory (`SourceHanSans.ttc` dominates).
OFL permits bundling and selling fonts as part of a larger package, but *not* selling the
font by itself, and Reserved Font Names ("Font Awesome", "Source") may not be used by
derivative works. Renaming is not needed since we do not modify the fonts.

## 3. Assets that must NOT ship in a commercial build without further review

Recorded as `action=block-release` in [`ASSET_MANIFEST.csv`](ASSET_MANIFEST.csv) and
enforced by `scripts/check_assets.sh --release`.

1. **Trademark artwork** — `data/gui_logo.png`, `other/icons/DDNet*`, `other/icons/DDNet-Server*`,
   `data/communityicons/`, `other/dmgbackground*.png`, `other/emscripten/background.png`,
   `data/menuimages/*` where they contain the DDNet mark. *Action taken:* replaced in place
   with original Neon Relay artwork (same filenames ⇒ build graph untouched), see
   `docs/REBRANDING.md` §"Binary artwork".
2. **`other/icons/`** — author named (Ravie) but **no license grant** in the file. Not safe
   to redistribute commercially. Replaced.
3. **CC-BY-SA 3.0 content with no named author** (`data/shader/`;
   `data/maps/ctf*.map`, `data/maps/dm*.map`, `data/maps/coverage.map`;
   `assets-src/maps/warm-workshops/`).
   CC-BY-SA 3.0 §4(b) requires attribution of the original author and a copy of the license;
   upstream does not name these authors. Either (a) obtain the author list from upstream
   contributors, (b) replace the assets, or (c) ship with a good-faith attribution page +
   the full CC-BY-SA 3.0 text. Gated until decided. (The original-art pass cleared the
   rest of this item's former scope — `data/audio/*.wv`, `data/mapres/`, `data/themes/`,
   the config/wordlist/font-index files and the emscripten shell — by deletion or by
   original replacement; `data/editor/` is gone with the editor itself.)
4. **CC-BY / CC-BY-SA skins and maps** — usable commercially *if* attribution and license
   text ship with the product and derivatives stay CC-BY-SA. Note the share-alike clause
   applies to the assets, not to the program; do not remix them into proprietary artwork.
5. **`ddnet-libs` prebuilt binaries** — SDL2 (zlib), FreeType (FTL/GPL-2.0 **dual license** →
   must be built/linked under FTL, never GPL, in a commercial product), libpng (libpng),
   Ogg/Opus/Opusfile (BSD), SQLite3 (public domain), curl (MIT-like), WavPack (BSD),
   FFmpeg (LGPL-2.1+ **or** GPL depending on build flags — upstream enables `libx264`, which
   makes FFmpeg GPL; `-DVIDEORECORDER=OFF` is already used for Android), Discord SDK
   (proprietary, only enabled with `-DDISCORD=ON`), glslang/Vulkan (Apache-2.0).
   **Legal review required per library**; recorded in `docs/THIRD_PARTY_NOTICES.md`.
6. **Anything fetched at runtime from `*.ddnet.org`** — not an asset-license problem but a
   branding/privacy one: `info.ddnet.org`, `maps.ddnet.org`, `skins.ddnet.org`,
   `update.ddnet.org`, `master1.ddnet.org`, `wiki.ddnet.org`. Defaults were changed and the
   DDNet info feed is disabled by default (see `docs/REBRANDING.md`).

## 4. User-facing strings that require rebranding

Verified by `rg -n 'Localiz(e|able)\("[^"]*(DDNet|Teeworlds|DDrace)' src/`. Full list with
decisions in [`REBRANDING.md`](REBRANDING.md); highlights:

| Location | String |
| --- | --- |
| `src/game/version.h:7` | `#define GAME_NAME "DDNet"` |
| `src/game/client/components/menus.cpp:1233` | `Localize("Welcome to DDNet")` |
| `src/game/client/components/menus.cpp:1235` | `Localize("DDraceNetwork is a cooperative online game …")` |
| `src/game/client/components/menus.cpp:1743-1744` | `Show DDNet map finishes in server browser` / `transmits your player name to info.ddnet.org` |
| `src/game/client/components/menus.cpp:2555`, `sounds.cpp:31,116`, `skins.cpp:504`, `skins7.cpp:371`, `gameclient.cpp:376` | `Loading DDNet Client` |
| `src/game/client/components/menus_settings.cpp:52,136` | settings tab `DDNet`, `DDNet Client needs to be restarted…` |
| `src/game/client/components/menus_settings_ddnet.cpp:312,325` | `DDNet %s is available:`, `DDNet Client updated!` |
| `src/game/client/components/menus_start.cpp:50,58,204,224,243` | `https://ddnet.org/discord`, `https://wiki.ddnet.org/`, `DDNet %s is out!` |
| `src/game/client/components/menus_ingame.cpp:489`, `menus_ingame_touch_controls.cpp:1061-1062` | `https://wiki.ddnet.org/wiki/Touch_controls`, `Open DDNet Wiki`, `… on the DDNet Wiki.` |
| `src/game/client/components/menus_settings_language.cpp:43` | `English translation by the DDNet Team` |
| `src/game/client/components/menus_settings_appearance.cpp:112,118` | `DDRace HUD`, `Show DDRace HUD` |
| `src/engine/client/backend_sdl.cpp:138,162` | graphics error text mentioning `settings_ddnet.cfg` |
| `src/game/editor/editor.cpp:3710` | `https://wiki.ddnet.org/wiki/Mapping` |
| `src/engine/shared/config.h:19` | `#define CONFIG_FILE "settings_ddnet.cfg"` |
| `src/engine/shared/config_variables.h:149,162,163,275,382,384,474,592,711,712,713` | map/skin download URLs, `sv_gametype` default, `br_indicate_finished` help text, `sv_register_url`, `sv_sqlite_file` default `ddnet-server.sqlite`, `sv_client_suggestion*` broadcasts |
| `src/engine/shared/storage.cpp:264-335` | user dir `DDNet`, legacy dir `Teeworlds`, `/usr/share/ddnet` etc. |
| `src/engine/client/updater.cpp:84` | `https://update.ddnet.org/%s` |
| `src/engine/serverbrowser.h:22` | `DDNET_INFO_URL = "https://info.ddnet.org/info"` |
| `data/languages/*.txt` (40 files, ~1600 lines) | translations of the strings above |
| `other/ddnet.desktop`, `man/DDNet.6`, `man/DDNet-Server.6`, `Dockerfile` | packaging identity |
| `scripts/android/files/**` | `rootProject.name='DDNet'`, `org.ddnet.client`, app label, launcher icon |

## 5. Identifiers that must NOT be rebranded (protocol / compatibility)

Changing these silently breaks network compatibility, demo playback, teehistorian parsing
or the anti-cheat/UUID scheme. They are classified as *code/API identifier* in the branding
scan and intentionally kept:

| Identifier | Why it is frozen |
| --- | --- |
| `GAME_NETVERSION "0.6 626fce9a778df4d4"`, `GAME_NETVERSION7 "0.7 802f1be60a05665f"` | server-browser/client version handshake |
| `GAME_VERSION "0.6, " GAME_RELEASE_VERSION` | "Compatible version" filter in the server browser |
| `CLIENT_VERSION7 0x0705` | protocol constant |
| `UUID(…, "teehistorian-player-finish@ddnet.org")` and all other `*@ddnet.org` UUIDs in `src/engine/shared/teehistorian_ex_chunks.h`, `protocol_ex_msgs.h`, `datasrc/network.py` | name-based UUIDv5 → changing the name changes the UUID and breaks demo/teehistorian/extended-protocol compatibility |
| `SERVERCAPFLAG_DDNET`, `CClient::DDNetVersion()`, `LoadDDNetInfo()` and other internal symbols | internal API; renaming is cosmetic churn with regression risk (they are not shown to users) |
| `sv_gametype` default value `ddnet` | wire value used by the master server / server browser filtering. The *help text* was rebranded, the value was kept; a Neon Relay master server deployment may override it via config. |
| `ddnet-*` map/skin file names inside `data/` | referenced by map metadata and by the asset integrity index |

## 6. Server/client events usable for **authoritative** rewards

The reward system must never trust a client-reported score. Usable server-side signals,
in order of strength:

| Signal | Location | Use for rewards |
| --- | --- | --- |
| **Player finish** (race time recorded by the server) | `CGameContext::TeehistorianRecordPlayerFinish(int ClientId, int TimeTicks)` → `src/game/server/gamecontext.cpp:1952`, emitted from `src/game/server/gamemodes/ddrace.cpp` / `entities/character.cpp` | Primary event: proves the server observed a finish at a tick time |
| **Team finish** | `CGameContext::TeehistorianRecordTeamFinish(int TeamId, int TimeTicks)` (`gamecontext.cpp:1960`) | Team reward splitting |
| **Score/records worker** (SQL-backed ranks, `sv_use_sql`) | `src/game/server/score.cpp`, `scoreworker.cpp`, `src/engine/server/databases/` | Cross-check that a finish was persisted, dedupe per (map, player, time) |
| **Teehistorian stream** | `src/game/server/teehistorian.cpp` (+ `teehistorian_ex.cpp`) | Tamper-evident replay log; can be hashed per match and used as evidence |
| **Player join/leave/spectate** | `CGameContext::OnClientEnter/OnClientDrop`, `src/game/server/player.cpp` | Presence proof ("player was in the match") |
| **Team state** | `src/game/server/teams.cpp` | Team-size based reward rules |
| **Demo recording** | `src/engine/server/server.cpp` (`sv_demo_*`) | Optional evidence artifact |
| **Antibot interface** | `src/antibot/` (`-DANTIBOT=ON`, implementation not provided) | Hook for a cheating verdict that blocks rewards |

Chosen design: the game server emits a **signed match-result record** for finish/team-finish
events (see `src/neonrelay/`), which the reward backend verifies against its own session
state before writing to the ledger. Details and the threat reasoning:
[`REWARD_SECURITY.md`](REWARD_SECURITY.md).

## 7. Places that need changes for Android wallet integration

| Area | Current state | What Neon Relay adds |
| --- | --- | --- |
| Gradle project template | `scripts/android/files/` (`build.gradle`, `settings.gradle`, `AndroidManifest.xml`, `gradle.properties`, `proguard-rules.pro`, `res/`, `java/org/ddnet/client/{ClientActivity,ServerService}.java`) | Moved to a real Gradle project under `android/` (module `app`), package `com.leo88q.neonrelay`, Kotlin plugin, Mobile Wallet Adapter dependency |
| Build driver | `scripts/android/cmake_android.sh` copies `scripts/android/files/*` into a build dir and `sed`s `DDNet`/`org.ddnet.client`; copies `other/icons/DDNet_256x256x32.png` as launcher icon; copies `libDDNet.so`/`libDDNet-Server.so` | Rewritten to build into `android/`, use `libneonrelay*.so`, copy Neon Relay launcher art, and pass `ANDROID_PACKAGE_NAME=com.leo88q.neonrelay` |
| Native entry point | `src/android/android_main.cpp` (SDL2 + JNI via `SDL_AndroidGetJNIEnv()`), CMake `-DANDROID_PACKAGE_NAME_JNI` | New JNI surface `native-lib` that only carries *wallet application events* (no keys, no MWA types) |
| Native libs | `ddnet-libs` submodule provides SDL2 + Java bindings (`ddnet-libs/sdl/java/org`) | Unchanged; wallet code is pure Kotlin and does not enter C++ |
| Asset integrity | `scripts/android/generate_asset_integrity_index.py` hashes `assets/asset_integrity_files/data` | Any replaced artwork must be re-hashed by this script (it runs as part of the Android build) |
| Version metadata | `DDNET_VERSION_NUMBER` / `GAME_RELEASE_VERSION_INTERNAL` in `src/game/version.h` feed `versionCode`/`versionName` | Macro renamed to `NEONRELAY_VERSION_NUMBER`, script updated |
| Permissions | `AndroidManifest.xml`: internet, storage, `FOREGROUND_SERVICE` (local server) | Add `<queries>` for MWA wallet intents; no new dangerous permissions |

## 8. Build systems present in the snapshot

* **CMake ≥ 3.12** (`CMakeLists.txt`, 4000+ lines) — client, server, tools, tests (GTest),
  CPack packaging, iOS/macOS bundles, mingw cross-toolchains under `cmake/toolchains/`.
  Mandatory deps: **Rust/Cargo**, **SQLite3**, **curl**; client additionally SDL2, FreeType,
  PNG, Ogg/Opus/Opusfile, optional Vulkan/FFmpeg/UPnP/MySQL/WebSockets.
* **Cargo** (`Cargo.toml`, `Cargo.lock`, `src/rust-bridge/`, `src/base/lib.rs`,
  `src/engine/console.rs`, `src/masterping/`) — Rust bridge compiled into both binaries.
* **Gradle** (`scripts/android/files/`) — Android APK.
* **Python 3** — code generation (`datasrc/*.py` → `src/generated/`), asset integrity index,
  language tooling, integration tests (`scripts/integration_test.py`).
* **Docker** (`Dockerfile`) — Debian 12 build image for Linux + Windows cross builds.
* **CI** — 9 upstream GitHub workflows + GitLab CI. Relocated to `ci/upstream-reference/`
  in this repository so they do not run against Neon Relay infrastructure; Neon Relay
  workflows live in `.github/workflows/`.

### Baseline build result in this sandbox (blocker BL-01)

`cmake -Bbuild-baseline -GNinja -DCLIENT=OFF -DTOOLS=OFF -DSERVER=ON -DPREFER_BUNDLED_LIBS=ON`
against the **unmodified** tree fails at configure time:

```
CMake Error at CMakeLists.txt:727 (message): You must install Curl to compile DDNet
CMake Error at CMakeLists.txt:733 (message): You must install Rust and Cargo to compile DDNet
CMake Error at CMakeLists.txt:736 (message): You must install SQLite3 to compile DDNet
```

Root cause is the environment, not the code: the sandbox has no route to
`deb.debian.org` (apt), `crates.io` or `static.rust-lang.org` (Rust), and no
`zlib`/`openssl`/`sqlite3`/`curl` development headers are preinstalled.
Full log: [`baseline/cmake-configure-upstream.log`](baseline/cmake-configure-upstream.log).
What *was* verified locally instead is listed in `docs/KNOWN_LIMITATIONS.md`.
