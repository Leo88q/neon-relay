# Bundled license texts

Verbatim license texts referenced by [`docs/ASSET_MANIFEST.csv`](../docs/ASSET_MANIFEST.csv)
and [`docs/THIRD_PARTY_NOTICES.md`](../docs/THIRD_PARTY_NOTICES.md).

| File | License | Used by |
| --- | --- | --- |
| `CC-BY-SA-3.0.txt` | Creative Commons Attribution-ShareAlike 3.0 Unported | default rule for `data/`, translations, named maps, `coala_*`/`santa_*`/misc skins, comfort entities |
| `CC-BY-3.0.txt`, `CC-BY-4.0.txt` | Creative Commons Attribution 3.0 / 4.0 | skins by Whis (upstream states "CC-BY" without a version, so both texts ship) |
| `CC0-1.0.txt` | CC0 1.0 Universal public-domain dedication | `kitty_*`/`bomb` skins (Ravie), `kitty_x_ninja` (patwo.*) |
| `OFL-1.1.txt` | SIL Open Font License 1.1 | Font Awesome 6 Free Solid, Glow Sans J, Source Han Sans |
| `Zlib.txt` | zlib/libpng license | Teeworlds-era skins (Magnus Auvinen), `wartee` (Obst); also the license of this repository's code |
| `Bitstream-Vera.txt` | Bitstream Vera font license | base of `data/fonts/DejaVuSans.ttf` |
| `Arev.txt` | Arev Fonts license (Tavmjong Bah) | Arev portion of `data/fonts/DejaVuSans.ttf` |
| `Apache-2.0.txt` | Apache License 2.0 | provenance of the Teeworlds `grass_main` mapres redrawn into `Sunny Side Up.map` |

Provenance of the verbatim texts: SPDX license-list-data, commit
`16f3aa6c3bdd62e50f8b1cf618f32d2a510250ee` (https://github.com/spdx/license-list-data),
files `text/<id>.txt`, copied unmodified except `Arev.txt`, which is transcribed from the
Arev Fonts distribution notice (the Arev license mirrors the Bitstream Vera license with the
names substituted). The repository's own code license is at [`../license.txt`](../license.txt).

`scripts/check_assets.sh --licenses` fails if a `ship` row in the manifest references a
license that has no file here.
