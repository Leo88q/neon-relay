# BL-16: asset stage (not a release)

## Implemented

- Ten generated potato sheets, RGBA 256x128, body at most 80x80 inside the 96x96 body cell.
- Female character faces kept as approved. New guy_3 without ground clouds; horizontal ninja.
- Six weapon body rects baked in the 1024x512 atlas. All pixels outside those rects match baseline aef3363.
- 512x512 potato sources, 256x256 weapon sources and both collages.
- Normalized sources are never rematted on rebuild. New raw inputs are retained under `raw/`; old originals overwritten in earlier session steps are not recoverable.
- Corrected compositing: copying RGBA into transparent cells no longer multiplies alpha by itself.
- `data/skins/potato_catalog.json`: 5 Common at 500 SKR, 3 Rare at 1000 SKR, 2 Legendary at 2000 SKR, royalty policy 500 bps. This is catalog metadata, NOT an implemented payment/NFT flow.
- Generated C++ allowlist restricts the classic skin list to catalog names. Existing files and rendering of remote legacy skins remain intact. This is not ownership enforcement.
- `scripts/ci-local.sh` collects existing offline gates plus asset regression tests.

## Verification

Asset regression tests: 3/3, including byte-identical repeat builds and atlas boundaries.
Backend: 39/39 existing tests. Onchain: 25/25 existing offline TypeScript tests.
Branding release/translations, asset licenses, secrets, config, local syntax probe and signer passed.
The syntax probe excludes client translation units and external-dependency units; it is not a complete client build.
Asset manifest still contains block-release rows; passing `--licenses` is not release clearance.

## Not implemented / not verified

- Five-button menu, removal of editor code/data and other legacy entry points.
- Protocol 0.7 skin selector/catalog support.
- Dual-mint end-to-end economy, migrations, mint-bound ticket/claim PDAs and Merkle leaves.
- Tournament lobby, ranked per-match fees, Legendary ownership/freeroll verification.
- NFT issuance, SKR transfer to developer and enforced secondary royalties.
- Native client build and movement/weapon attachment visual playtest; validator program tests/deployment.

Graphics do not change the fixed 28x28 core physics. However, legs and eyes are painted into the body and their separate cells are empty: walk/eye animation differs from legacy skins. Weapon attachment origins and muzzle alignment still need visual review. Do not describe these artifacts as gameplay-validated or pixel-identical copies of the user's screenshots; they were generated anew.

## Rebuild

Install Pillow and NumPy in a Python environment, then run:

```sh
python3 scripts/build_potato_skins.py
python3 scripts/build_potato_weapon_sheet.py
python3 scripts/gen_potato_catalog.py
python3 scripts/gen_asset_manifest.py
./scripts/ci-local.sh
```

Do not run destructive matting helpers on already normalized sources. For replacing a source with another normalized RGBA PNG, preserve its canonical dimensions.

## Part 2: read-only dual-currency lobby

- Added validated `NEONRELAY_POTATO_MINT` alongside SKR, distinct-mint validation,
  and a base58 all-zero decode regression fix.
- Added `/v2/economy/lobby`, both categories and five race policies, exact bigint
  pool/share preview helpers and 10 new tests (backend total 49).
- No on-chain PDA/state migration or payment endpoint in this stage. Catalog
  explicitly disables joining/payment even when both mints are configured.
- See `DUAL_CURRENCY_LOBBY.md` for the coordinated backend/Rust/Android migration
  requirements and remaining security checks.
