# Third-party notices

Neon Relay is a derivative work. This document records every third-party work that is
present in the tree, its license, its attribution status, and — where the license cannot yet
be satisfied for a commercial release — the release gate that keeps it out of shipped builds.

The machine-readable companion is [`ASSET_MANIFEST.csv`](ASSET_MANIFEST.csv)
(`path,sha256,type,author,copyright,license,source_url,attribution,action`), regenerated with

```bash
./scripts/check_assets.sh --regenerate          # rewrite the manifest
./scripts/check_assets.sh --licenses            # coverage + hashes + license texts
./scripts/check_assets.sh --release --licenses  # release gate (must pass before shipping)
```

Verbatim license texts live in [`../licenses/`](../licenses/).

## 1. Source code

| Work | License | Notice |
| --- | --- | --- |
| DDNet / Teeworlds engine, game, tools, tests | zlib/libpng-style | [`../license.txt`](../license.txt), kept verbatim; upstream authors retain copyright |
| `src/engine/external/glew` | Modified BSD (GLEW license) | `src/engine/external/glew/LICENSE.txt` + `important.txt` |
| `src/engine/external/json-parser` | BSD-2-Clause | `src/engine/external/json-parser/LICENSE` |
| `src/engine/external/md5` | public domain (Colin Plumb) | `important.txt` |
| `src/engine/external/ed25519` | public domain (Andrew Moon, ed25519-donna @ `8757bd4`) | `src/engine/external/ed25519/IMPORTANT.txt`; vendored unmodified, built with `ED25519_REFHASH` (bundled reference SHA-512, no OpenSSL) |
| `src/engine/external/zlib` | zlib license | `important.txt` |
| Rust crates (`src/rust-bridge`, `ddnet_*` crates) | per-crate SPDX ids | `Cargo.toml` / `Cargo.lock` |

Nothing in this repository removes or rewrites those notices; the branding changes are
marked as alterations in [`REBRANDING.md`](REBRANDING.md) as required by clause 2 of the
upstream license.

## 2. Fonts (`data/fonts/`, shipped)

| Font | License | Copyright | Condition we satisfy |
| --- | --- | --- | --- |
| `DejaVuSans.ttf` | Bitstream Vera + Arev + public-domain DejaVu changes | (c) 2003 Bitstream, Inc.; (c) 2006 Tavmjong Bah | license texts bundled; fonts unmodified; not sold standalone |
| `Font_Awesome_6_Free-Solid-900.otf` | SIL OFL 1.1 | (c) 2023 Fonticons, Inc. | OFL bundled; **Reserved Font Name "Font Awesome" is never used for a derivative**; font unmodified |
| `GlowSansJ-Compressed-Book.otf` | SIL OFL 1.1 | (c) 2020 Project Wêlai | OFL bundled; font unmodified |
| `SourceHanSans.ttc` | SIL OFL 1.1 | (c) 2014-2021 Adobe | OFL bundled; **Reserved Font Name "Source" is never used for a derivative**; font unmodified |

OFL permits bundling and selling the fonts *as part of a larger package*, which is exactly
how they ship (embedded in the game client), never standalone.

## 3. Translations (`data/languages/`, shipped)

CC-BY-SA 3.0. Each file names its translators in the final block
(`== <Language> translation by …`); those credits are reproduced verbatim in the manifest's
`attribution` column and in the in-game language screen. The CC-BY-SA 3.0 text ships in
`licenses/CC-BY-SA-3.0.txt`. Translation edits made by this project are marked in
[`REBRANDING.md`](REBRANDING.md) §5.

## 4. Maps

| Map | Author | License | Status |
| --- | --- | --- | --- |
| `Gold Mine.map` | `<BµmM>` | CC-BY-SA 3.0 | ship |
| `LearnToPlay.map` | Tridemy & Cøke | CC-BY-SA 3.0 | ship |
| `Sunny Side Up.map` | Ravie (grass redrawn from Teeworlds `grass_main`, Apache-2.0) | CC-BY-SA 3.0 | ship |
| `Tsunami.map` | louis | CC-BY-SA 3.0 | ship |
| `Tutorial.map` | unique2 & Alisa | CC-BY-SA 3.0 | ship |
| all other `data/maps/*.map`, all `data/maps7/*` | no author named upstream | CC-BY-SA 3.0 (default rule) | **block-release** (attribution gap) |

Share-alike applies to the map files themselves; they are distributed unmodified together
with the license text, which satisfies CC-BY-SA 3.0 §4 once the author is named.

## 5. Skins (`data/skins/`, shipped where the author is named)

| Group | Author | License |
| --- | --- | --- |
| 16 Teeworlds-era skins (`bluekitty`, `default`, `saddo`, …) | Magnus Auvinen | zlib |
| `wartee` | Obst | zlib |
| 28 skins (`beast`, `dino`, `ghost`, `whis`, …) | Whis | CC-BY (version unstated → 3.0 and 4.0 texts bundled) |
| `coala_*`, `santa_*` variants | DanilBest / forsaken | CC-BY-SA 3.0 |
| `kitty_*`, `bomb` | Ravie | CC0 1.0 |
| `kitty_x_ninja` | patwo.* | CC0 1.0 |
| `demonlimekitty`, `nanas`, `nersif` | Miper | CC-BY-SA 3.0 |
| 8 remaining skins (no named author) | unnamed | CC-BY-SA 3.0 → **block-release** |

`data/skins7/**` (Teeworlds 0.7 skin system) ships **no per-file license and no authors**:
every row is `action=block-release` with `license=UNKNOWN` until the rights review resolves it.

## 6. Entity layers

`data/assets/entities/comfort/*` — (c) louis, CC-BY-SA 3.0, named in
`data/assets/entities/license.txt` → ship.
`data/editor/entities/*`, `data/editor/entities_clear/*` — unnamed → **block-release**.

## 7. Unattributed CC-BY-SA 3.0 content (attribution gap → block-release)

`data/audio/`, `data/countryflags/`, `data/mapres/`, `data/themes/`, `data/editor/`,
`data/shader/`, plus the unnamed maps/skins/entities above: upstream applies the CC-BY-SA 3.0
default rule but names no author, so the attribution required by §4(b) cannot be produced
from the tree. Options recorded for the rights review:

1. obtain the author list from upstream contributors, or
2. replace the assets with original artwork, or
3. ship with a good-faith attribution page naming the upstream project plus the full license text.

Until one is chosen, `scripts/check_assets.sh --release` fails, so no commercial build can
include them. This is the single largest release blocker (see `KNOWN_LIMITATIONS.md`, BL-05).

## 8. Upstream artwork that was **removed** and replaced

The following upstream trademark/character artwork was present in the imported snapshot and
has been replaced **in place** with original Neon Relay artwork (same filenames, so no build
rule changed). The replacements are original works of this project; provenance and SHA-256
are in the manifest, masters in `assets-src/brand/`, generator `scripts/build_brand_assets.py`.

| Replaced file(s) | Upstream content | Replacement |
| --- | --- | --- |
| `other/icons/DDNet*`, `DDNet-Server*` (png/ico/icns) | DDNet icons, "Icons by Ravie", **no license grant** | original Neon Relay icons |
| `data/gui_logo.png` | DDNet banner | original mark + wordmark |
| `other/dmgbackground.png`, `other/dmgbackground_single.png` | DDRaceNetwork logo + Teeworlds tees | original layout with the Neon Relay logo |
| `other/emscripten/background.png` | Teeworlds tee characters | original radial-gradient background with the Neon Relay mark |
| `data/menuimages/*.png` (5 files) | Teeworlds character art | original gradient banners with per-section motifs |
| `data/communityicons/none.png` | Teeworlds tee silhouette | original neutral placeholder |

## 9. Trademarks

DDNet, DDRaceNetwork and Teeworlds are the marks of the upstream projects. They appear in
this repository only in provenance, legal and compatibility contexts (this document,
`UPSTREAM_BASE.md`, `REBRANDING.md`, protocol identifiers). Neon Relay claims no rights in
them, and nothing here suggests endorsement by or affiliation with the upstream projects.
The Neon Relay name and logo are original marks of this project.

## 10. Release gate

A release build is produced only when all of the following pass in CI:

```bash
./scripts/check_assets.sh --release --licenses   # no block-release asset, all texts present
./scripts/check_branding.sh --release --check-translations
```

plus the manual sign-off items in `RELEASE_CHECKLIST.md` (rights review of §7, trademark
clearance of the Neon Relay mark, and bundling of the verbatim CC/OFL legal codes listed in
`licenses/README.md`).
