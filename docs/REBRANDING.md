# Rebranding: DDNet → Neon Relay

This document is the **alteration record** required by clause 2 of the upstream license
("Altered source versions must be plainly marked as such"). It lists every branding
change, why each one is safe, and which upstream notices were deliberately left alone.

* Upstream: https://github.com/ddnet/ddnet @ `a853d333ac9e61ebfa2899b4641f8b0658ba60d5`
* Product name: **Neon Relay** · repository slug `neon-relay` · internal id `neonrelay`
* Android applicationId: `com.leo88q.neonrelay`
* Server binary / service: `neonrelay-server` · client binary: `neonrelay`

Verification tools (both run in CI):

```bash
./scripts/check_branding.sh --release --check-translations   # classification + gate
./scripts/local_syntax_probe.sh                              # 123 TUs compile after the rebrand
```

---

## 1. Identity and packaging

| Old value | New value | Path | Why it is safe |
| --- | --- | --- | --- |
| `project(DDNet …)` | `project(NeonRelay …)` | `CMakeLists.txt:44,46` | `PROJECT_NAME` only feeds package/artifact names and the `${CMAKE_PROJECT_NAME}` text in configure errors. No source file depends on the literal project name. |
| `CLIENT_EXECUTABLE DDNet` | `neonrelay` | `CMakeLists.txt:210` | Used as `OUTPUT_NAME` for the client target and for the macOS bundle name; all consumers go through the variable. Android `android.app.lib_name` and `scripts/android/cmake_android.sh` were updated to match (`libneonrelay.so`). |
| `SERVER_EXECUTABLE DDNet-Server` | `neonrelay-server` | `CMakeLists.txt:209` | Same mechanism; matches the required service name. macOS launcher (`src/macos/server.mm`, `src/game/client/components/local_server.cpp`) updated to `neonrelay-server`. |
| `IOS_BUNDLE_IDENTIFIER "org.ddnet.client"` | `"com.leo88q.neonrelay"` | `CMakeLists.txt:211` | iOS only; no code reads it. |
| `CPACK_PACKAGE_NAME ${PROJECT_NAME}` | follows automatically | `CMakeLists.txt:3660` | Artifact names become `NeonRelay-<version>-<system>`. |
| install dirs `/usr/share/ddnet`, `${CMAKE_INSTALL_LIBDIR}/ddnet` | `…/neonrelay` | `CMakeLists.txt:3810-3836` | Kept in sync with `INSTALL_RPATH "$ORIGIN/../lib/neonrelay"` (`CMakeLists.txt:483`) and with the data-directory search list in `src/engine/shared/storage.cpp`, which now checks `/usr/share/neonrelay` … `/opt/neonrelay` **before** the legacy upstream paths. |
| `other/ddnet.desktop` | `other/neonrelay.desktop` (`Name=Neon Relay`, `Exec=neonrelay %u`, `Icon=neonrelay`, `MimeType=x-scheme-handler/neonrelay`) | `other/neonrelay.desktop`, `CMakeLists.txt:3825` | Desktop entry is packaging metadata; icon name matches the installed `neonrelay.png`. |
| `other/icons/DDNet*`, `DDNet-Server*` | `other/icons/NeonRelay*`, `NeonRelay-Server*` | `other/icons/`, `CMakeLists.txt:2099,2956,3201,3829,3832`, `other/icons/*.rc`, `scripts/android/cmake_android.sh` | File renames plus every reference; `.rc` contents updated to the new `.ico` names. |
| `man/DDNet.adoc`, `man/DDNetServer.adoc`, `man/DDNet.6`, `man/DDNet-Server.6` | `man/NeonRelay.adoc`, `man/NeonRelayServer.adoc`, `man/neonrelay.6`, `man/neonrelay-server.6` | `man/`, `man/generate.sh` | Man pages are not installed by CMake; they are distro packaging input. The `.6` files were rewritten by hand (asciidoc/`a2x` is unavailable in this environment) and say so in their generator comment. The upstream pages also claimed an MIT license — the new pages state the actual zlib-style license. |
| `docker build -t ddnet`, `/ddnet` mount | `neonrelay-builder`, `/neonrelay` | `Dockerfile` | Build image only; dependency list unchanged (upstream needs it). |
| `PROJECT_NAME "DDNet documentation"`, `PROJECT_LOGO other/icons/DDNet_48x48x32.png` | `"Neon Relay documentation"`, `NeonRelay_48x48x32.png` | `Doxyfile` | Documentation generator metadata. |
| `rootProject.name='DDNet'`, `org.ddnet.client`, `android:value="DDNet"`/`"DDNet-Server"` | `NeonRelay`, `com.leo88q.neonrelay`, `neonrelay`/`neonrelay-server` | `android/**` (see `docs/ANDROID_SEEKER.md`) | Application ID and native library names must match the CMake output names. |
| `other/emscripten/index.html`: title, `<h1>`, favicon `DDNet.ico`, `DDNet.js`, `~/.local/share/ddnet` | `Neon Relay Web`, `NeonRelay.ico`, `neonrelay.js`, `~/.local/share/neonrelay` | `other/emscripten/index.html` | `neonrelay.js` follows `CLIENT_EXECUTABLE`; the icon follows the renamed file. |
| `other/vim/{ftdetect,syntax}/ddnet-cfg.vim` | `neonrelay-cfg.vim` | `other/vim/` | Editor support files for the renamed settings file. |

## 2. Runtime identity (what a player sees)

| Old value | New value | Path | Why it is safe |
| --- | --- | --- | --- |
| `#define GAME_NAME "DDNet"` | `"Neon Relay"` | `src/game/version.h` | `GAME_NAME` is used for window titles, shell registration and version strings. It is **not** part of the network handshake (that is `GAME_NETVERSION`/`GAME_VERSION`, which stay untouched). |
| `DDNET_VERSION_NUMBER 20010` | `NEONRELAY_VERSION_NUMBER 20010` (value unchanged) | `src/game/version.h`, `src/game/client/gameclient.cpp`, `src/engine/server/server.cpp` (×2), `scripts/android/cmake_android.sh` | Internal macro, 4 call sites, value preserved so the client-version handshake and Android `versionCode` behave identically. |
| Window title / graphics backend name `"DDNet Client"` | `"Neon Relay"` | `src/engine/client/graphics_threaded.cpp:2208` | Passed to the SDL/Vulkan backend as the window/application title. |
| Vulkan `pApplicationName "DDNet"`, `pEngineName "DDNet-Vulkan"` | `"Neon Relay"`, `"Neon Relay-Vulkan"` | `src/engine/client/backend/vulkan/backend_vulkan.cpp:3679-3681` | Informational only (driver diagnostics). |
| `#define CONFIG_FILE "settings_ddnet.cfg"` | `"settings_neonrelay.cfg"` | `src/engine/shared/config.h:19` | Settings file name. No migration is performed: a Neon Relay client starts with defaults and writes its own file (documented limitation). |
| user dir `fs_storage_path("DDNet", …)` | `"NeonRelay"` with **fallbacks** to `DDNet` then `Teeworlds` | `src/engine/shared/storage.cpp:264-283` | Players keep access to maps/skins/demos from an existing installation; nothing is deleted or moved. |
| `ddnet-serverlist-urls.cfg` | `neonrelay-serverlist-urls.cfg` | `src/engine/client/serverbrowser_http.cpp:557` | Optional operator file. |
| `ddnet-cache.sqlite3`, `ddnet-saves.txt`, `ddnet-server.sqlite` | `neonrelay-cache.sqlite3`, `neonrelay-saves.txt`, `neonrelay-server.sqlite` | `src/engine/client/serverbrowser_ping_cache.cpp`, `src/game/client/components/chat.h`, `src/engine/shared/config_variables.h`, `scripts/move_sqlite.py`, `scripts/import_file_score.py` | Local cache/save file names. Existing upstream files are simply not picked up (documented limitation). |
| connect link `ddnet://`, `ddnet:` | `neonrelay://`, `neonrelay:` **+ legacy acceptance of `ddnet://`** | `src/engine/client.h:21-26`, `src/engine/client/client.cpp` (4 call sites), `other/emscripten/index.html` | Links shared by players keep working; the protocol handler registered with Windows/macOS is the new scheme. |
| notification icon `"ddnet"`, `Notify("DDNet Chat"/"DDNet Vote")` | `"neonrelay"`, `"Neon Relay chat"/"Neon Relay vote"` | `src/engine/client/notifications.cpp:32`, `src/game/client/components/chat.cpp:889`, `src/game/client/components/voting.cpp:270` | Matches the installed icon name; notification titles are user-visible. |
| `Welcome to DDNet`, the `DDraceNetwork is a cooperative…` first-launch text | `Welcome to Neon Relay`, `Neon Relay is a cooperative…` | `src/game/client/components/menus.cpp:1233-1235` | First-launch popup copy. |
| `Loading DDNet Client` (5 call sites) | `Loading Neon Relay` | `menus.cpp`, `gameclient.cpp`, `sounds.cpp` (×2), `skins.cpp`, `skins7.cpp` | Loading screen caption. |
| settings tab `DDNet` | `Neon Relay` | `src/game/client/components/menus_settings.cpp:52` | Tab label only; the file name `menus_settings_ddnet.cpp` is an internal identifier and was kept. |
| `DDNet %s is out!`, `DDNet %s is available:`, `DDNet Client updated!`, `DDNet Client needs to be restarted…` | `Neon Relay …` | `menus_start.cpp`, `menus_settings_ddnet.cpp`, `menus_settings.cpp` | Update notifications. |
| `Show DDNet map finishes in server browser` / `transmits your player name to info.ddnet.org` | `Show map finishes in server browser` / `transmits your player name to the configured info service` | `src/game/client/components/menus.cpp:1743-1744` | Matches the new behaviour: the info service is opt-in (see §4). |
| `DDRace HUD`, `Show DDRace HUD` | `Race HUD`, `Show race HUD` | `src/game/client/components/menus_settings_appearance.cpp:112-118` | Label text; the config variable `cl_showhud_ddrace` keeps its name so existing config files still work. |
| `Open DDNet Wiki`, `…on the DDNet Wiki.`, `https://wiki.ddnet.org/...`, `https://ddnet.org/discord`, `https://ddnet.org/skins/`, `https://ddnet.org/downloads/` | `Open documentation`, `…in the Neon Relay documentation.`, links to this repository | `menus_ingame_touch_controls.cpp`, `menus_ingame.cpp`, `menus_start.cpp`, `menus_settings_tee.cpp`, `editor.cpp`, `client.cpp` (graphics troubleshooting) | Buttons now open pages that actually exist for this product. |
| `Discord` button | `Community` button | `src/game/client/components/menus_start.cpp:48` | The link target changed, so the label had to change too. |
| `English translation by the DDNet Team` | `English translation by the Neon Relay Team` | `src/game/client/components/menus_settings_language.cpp:43` | Language-screen credit line. |
| `"%s" is not compatible with pnglite and cannot be loaded by old DDNet versions:` | `… old Neon Relay versions:` | `src/engine/client/graphics_threaded.cpp:540` | Warning text. |
| `ddnet://<addr>` in the "copy server info" clipboard text | `neonrelay://<addr>` | `menus_ingame.cpp:703`, `menus_browser.cpp:1189` | Must match the scheme the client registers. |
| editor tooltip `[F1] Open the DDNet Wiki page…`, entity explanations `…in DDRace`, `settings(ddnet)` position label | Neon Relay wording | `src/game/editor/editor.cpp:3695`, `quick_actions.h:18`, `explanations.cpp:350-362`, `proof_mode.cpp:45` | Editor UI text; the `POS_SETTINGS_DDNET` enum name is kept (internal). |

## 3. Server-side text

| Old value | New value | Path |
| --- | --- | --- |
| `sv_client_suggestion` / `_old` / `_bot` defaults mentioning DDNet.org | Neon Relay wording | `src/engine/shared/config_variables.h:711-713`, `data/autoexec_server.cfg` |
| `sv_name "My DDNet server"`, `sv_motd "Testserver with DDraceNetwork Features!…"` | `"My Neon Relay server"`, `"Neon Relay test server with race features!…"` | `data/autoexec_server.cfg` |
| `DDraceNetwork Mod. Version: …`, `Official site: DDNet.org`, `Or visit DDNet.org` | `Neon Relay server. Version: …`, `Project: https://github.com/Leo88q/neon-relay` (third line removed) | `src/game/server/ddracechat.cpp:22-31` |
| `please visit DDNet.org or say /info …` | `say /info for server information and /rules for the server rules` | `src/game/server/gamemodes/ddnet.cpp:201-202` |
| `Happy DDNet birthday …` | `Happy Neon Relay birthday …` | `src/game/server/player.cpp:1079,1083` |
| `ban error (use a more recent DDNet client)`, `Use a more recent DDNet client.` (rcon + log + kick) | `… Neon Relay client` | `src/engine/server/server.cpp:159,2281`, `src/game/server/gamecontext.cpp:3586,3611` |
| `Old Teeworlds 0.6 versions are unsupported. Use DDNet client or Teeworlds 0.7` | `Old 0.6 clients are unsupported. Use the Neon Relay client or a 0.7 client.` | `src/game/server/gamecontext.cpp:1238` |
| `You can see other players. To disable this use DDNet client and type /showothers` | `You can see other players. To disable this, type /showothers` | `src/game/server/gamecontext.cpp:1757` |
| `On official DDNet servers this will automatically be inserted…` | `It will be inserted into the database automatically on the next scheduled import.` | `src/game/server/gamecontext.cpp:4868` |
| `Demo version incremented, but not by DDNet`, `client %d wants to reconnect (ddnet)`, `new client (ddnet token)`, `dropped weird ddnet ex object`, `Set ddrace team for a player`, UPnP model `DDNet Server <version>` | Neon Relay / neutral wording | `src/engine/shared/demo.cpp:1385`, `network_server.cpp:518,528`, `src/game/client/sixup_translate_snapshot.cpp:50`, `gamecontext.cpp:3959`, `src/engine/server/upnp.cpp:49` |
| macOS server launcher `Run DDNet Server`, window title `DDNet Server` | `Run Neon Relay Server`, `Neon Relay Server` | `src/macos/server.mm:64,100` |

## 4. Network defaults: no third-party services out of the box

A commercial standalone product must not send player data to somebody else's
infrastructure by default. These defaults were changed; each feature still works when an
operator configures an endpoint.

| Setting | Old default | New default | Effect |
| --- | --- | --- | --- |
| `cl_info_url` (**new**) | hardcoded `https://info.ddnet.org/info` | `""` | `CClient::RequestDDNetInfo()` returns immediately when empty, so no player name, IP or version is transmitted. Cache file renamed `ddnet-info.json` → `neonrelay-info.json`. |
| `br_indicate_finished` | `1` (on) | `0` (off) | The "did I finish this map" lookup that transmits the player name is opt-in now. |
| `cl_map_download_url` | `https://maps.ddnet.org` | `""` | HTTP map downloads only happen if an operator configures a URL or the info service provides one; otherwise the client falls back to the in-game map transfer. The comparison against the old hardcoded default in `client.cpp` was replaced accordingly. |
| `cl_skin_download_url`, `cl_skin_community_download_url` | `https://skins.ddnet.org/...` | `""` | Skin downloads disabled unless configured. |
| `sv_register_url`, `sv_register` | `https://master1.ddnet.org/ddnet/15/register`, `1` | `""`, `0` | A server never registers itself with the upstream master server. `CChooseMaster::Refresh()` returns early when no URL is configured, so the server browser does not spam errors. |
| `DEFAULT_SERVERLIST_URLS[]` | four `masterN.ddnet.org` URLs | empty (`NUM_DEFAULT_SERVERLIST_URLS = 0`) | The server browser starts empty and is populated from `neonrelay-serverlist-urls.cfg`, LAN discovery or direct connect. |
| Discord rich presence `client_id` | `752165779117441075` (upstream application) | `0` + `TODO(release)` | `DISCORD` is `OFF` by default; reusing somebody else's Discord application id would be wrong. Assets renamed `ddnet_logo` → `neonrelay_logo`. |
| updater URL | `https://update.ddnet.org/%s` | `https://update.neonrelay.example/%s` | `AUTOUPDATE` is `OFF` by default; `.example` is a reserved TLD, so nothing can resolve until real infrastructure exists (blocker BL-07). |

## 5. Translations

`data/languages/*.txt` (38 files, ~2 700 lines each) were rebranded **in lockstep with the
C++ keys** by `scripts/languages/rebrand_neonrelay.py`:

* 613 blocks changed (key and/or translation),
* 266 blocks dropped where a mechanically patched translation would have been misleading
  (e.g. `Discord` → `Community`, `Open DDNet Wiki` → `Open documentation`); those strings
  fall back to English,
* result: 622 blocks changed / 266 dropped after the second pass for case variants
  (`DDnet`, `DDRaceNetwork`, `DDRace`), and `scripts/languages/rebrand_neonrelay.py --check`
  is clean.

`data/languages/license.txt` (CC-BY-SA 3.0) and the per-file author lists were left
untouched, including translator handles such as `TeeWorlds-org` in `czech.txt`, which is a
person's name and therefore attribution, not branding.

Known upstream translation bugs were **not** silently fixed (they predate this fork and are
visible in the diff): e.g. `galician.txt` has the translation of "Use DDRace scoreboard"
attached to the restart-warning key, `belarusian.txt` has a pistol-sound translation under
"Enable gun sound".

## 6. Binary artwork

Trademark artwork is replaced **in place** (identical file names, so no build rule, map or
asset-integrity index has to change):

| Path | Upstream content | Neon Relay content |
| --- | --- | --- |
| `data/gui_logo.png` | DDNet banner (`Image("banner", …)` in `datasrc/content.py`) | original Neon Relay banner |
| `other/icons/NeonRelay_{16,32,48,256}x…x32.png` | DDNet client icons (author "Ravie", **no license grant** in `other/icons/license.txt`) | original Neon Relay icons |
| `other/icons/NeonRelay.ico`, `.icns` | DDNet Windows/macOS icons | regenerated from the new artwork |
| `other/icons/NeonRelay-Server_*`, `.ico`, `.icns` | DDNet server icons | original Neon Relay server icons |

Provenance, license and SHA-256 of every replacement are recorded in
[`ASSET_MANIFEST.csv`](ASSET_MANIFEST.csv). Gameplay assets (maps, skins, sounds, fonts,
country flags, mapres, themes, editor resources) are still the upstream ones and are marked
`action=block-release` until the rights review in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)
is completed — they are not shipped in a release build until then
(`scripts/check_assets.sh --release` fails on them).

## 7. Deliberately **not** changed

| Item | Reason |
| --- | --- |
| `license.txt`, `data/*/license.txt`, `other/icons/license.txt`, `src/engine/external/*/LICENSE*`, `.mailmap` | Legally required notices. Removing them would violate the upstream license. |
| `GAME_NETVERSION`, `GAME_NETVERSION7`, `GAME_VERSION`, `CLIENT_VERSION7` | Protocol handshake constants; changing them isolates the client from every existing server. |
| `UUID(…, "*@ddnet.org")`, `*@ddnet.tw`, `*@netobj.ddnet.*`, `*@netmsg.ddnet.*`, `*@netevent.ddnet.*` in `datasrc/network.py`, `src/engine/shared/protocol_ex_msgs.h`, `teehistorian_ex_chunks.h`, `src/game/mapitems.h` | Name-based UUIDv5 values. Renaming the name changes the UUID and breaks extended protocol, teehistorian and demo compatibility. |
| `m_DDNetVersion`, `DDNetVersion()`, `SERVERCAPFLAG_DDNET`, `VERSION_DDNET_*`, `CNetObj_DDNet*`, `LoadDDNetInfo()`, `GetDDRaceTeam`, `m_DDRaceState`, `DDRaceInit/Tick/PostCoreTick`, `ClDDRaceBindsSet`, `sv_ddrace_rules`, `sv_ddrace_tune_reset`, `menus_settings_ddnet.cpp`, `ddracechat.cpp`, `gamemodes/ddnet.cpp` | Internal symbols and saved-config variable names. Not shown to players; renaming them is churn with regression risk and would invalidate existing config files. |
| `sv_gametype` default `"ddnet"`, gametype detection (`"ddracenet"`, `"ddrace"`, `"f-ddrace"`, `"mkrace"`), entities image names (`"ddnet"`, `"ddrace"`, `"f-ddrace"`), `COMMUNITY_DDNET` | Wire/asset identifiers shared with servers, maps and the server browser. |
| `ddnet-libs` submodule path, `ddnet_base`/`ddnet_engine`/`ddnet_test` crate names, `DDNET_TEST_NO_LINK`, `DDNET_TEST_LIBRARIES`, `DDNET_GTEST_VERSION`, `libddnet_<target>.a` | Build-system identifiers. The Rust env vars are read by `src/rust-bridge/test/build.rs`. |
| Data asset file names (`mapres/ddnet_grass.png`, `editor/automap/ddnet_*.rules`, `editor/entities/DDNet.png`, `assets/entities/comfort/ddnet.png`, `mapres/font_teeworlds*.png`) | Referenced by shipped maps, automap rules and the Android asset-integrity index. Renaming would break existing maps. |
| Legacy fallback paths (`$APPDATA/DDNet`, `Application Support/DDNet`, `/usr/share/ddnet`, `~/.teeworlds`) | Read-only compatibility so players keep their data. |
| `ci/upstream-reference/**`, `docs/BUILDING*.md`, `docs/DEBUGGING.md`, `docs/CONTRIBUTING.md`, `docs/DATABASE.md`, `src/mastersrv/**`, `src/masterping/**`, `scripts/languages/README.md` | Historical/upstream documentation and master-server wire paths. Marked for rewrite before release (see `docs/KNOWN_LIMITATIONS.md`, BL-08). |
| `src/test/**`, `scripts/integration_test.py`, `src/rust-bridge/test/**` | Test fixtures that assert protocol behaviour. |

## 8. Classification of the full scan

`./scripts/check_branding.sh` runs `scripts/branding_scan.py`, which classifies **every**
occurrence of `DDNet|DDraceNetwork|DDrace|Teeworlds|ddnet|teeworlds` (case-insensitive) in
the tree and writes the full report to [`branding-scan.csv`](branding-scan.csv).

Latest run (after stage 3, before the Android restructure):

| Category | Count | Meaning |
| --- | --- | --- |
| `code/api-identifier` | 1545 | protocol, UUID, crate, asset or symbol names — must stay |
| `historical-documentation` | 307 | documents describing the derivation, upstream docs kept for reference |
| `comment` | 163 | source comments, not shown to users |
| `test-fixture` | 118 | tests asserting upstream protocol behaviour |
| `legal-attribution` | 23 | license/copyright notices — must stay |
| `user-facing` | 75 | **all of them inside `scripts/android/files/**`** (the upstream Gradle template) plus one backwards-compatibility list in `scripts/parse_crashlog_drmingw.py` |

The Android template is restructured and rebranded in stage 5 (`android/`), after which
`./scripts/check_branding.sh --release` is expected to pass; until then it fails and CI
reports it (see `docs/KNOWN_LIMITATIONS.md`, BL-04).

The classifier is a *tool*, not a proof: `docs/branding-scan.csv` is the reviewable output,
and every rule that suppresses a match is visible in `scripts/branding_scan.py` with a
comment explaining why the identifier must not be renamed.
