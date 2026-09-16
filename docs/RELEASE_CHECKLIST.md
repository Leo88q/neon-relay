# Release checklist

Gating list for the first public release of Neon Relay (Android/Solana Mobile).
Every item is either **verified now** (with the command that proves it),
**blocked** (with the blocker id from
[`KNOWN_LIMITATIONS.md`](KNOWN_LIMITATIONS.md)), or **pending operator action**.
A release may not proceed while any 🔴 item is open.

Legend: ✅ verified in-repo today · 🔴 blocking, not done · 🟠 must be done by
the operator outside the repo · ⛔ blocked by a documented environment
limitation.

## 1. Legal & assets

- [ ] 🔴 **Legal review of the 698 `block-release` assets** (BL-05). The gate
      `./scripts/check_assets.sh --release` fails by design until every row in
      `docs/ASSET_MANIFEST.csv` marked `block-release` is either cleared,
      replaced, or removed. This is the single biggest release blocker.
- [ ] ✅ Attribution preserved: `license.txt`, `docs/THIRD_PARTY_NOTICES.md`,
      `licenses/` verbatim SPDX texts, `UPSTREAM_BASE.md` provenance
      (`./scripts/check_assets.sh --licenses` PASS).
- [ ] ✅ No DDNet/Teeworlds marks in user-facing surfaces
      (`./scripts/check_branding.sh --release --check-translations` PASS;
      `docs/REBRANDING.md`, `docs/branding-scan.csv`).
- [ ] ✅ Original Neon Relay artwork generated in place; upstream logos/promo
      removed (stage 3–4 commits).
- [ ] 🟠 Confirm the `com.leo88q.neonrelay` applicationId and store listing
      copy contain no earning promises (mirrors the in-game Wallet page copy).

## 2. Keys & credentials

- [ ] 🟠 Generate the production game-server signing seed on the server host
      (`openssl rand -hex 32`), mode 600, **never** in the repo; publish the
      pubkey via `NEONRELAY_SERVER_SIGNING_PUBLIC_KEY`
      (`docs/REWARD_SECURITY.md` §8).
- [ ] 🟠 Generate the operator Solana keypair (`config.authority`) offline;
      decide custody (hardware wallet / multisig) — it can publish roots.
- [ ] 🟠 Set `NEONRELAY_ADMIN_TOKEN` (seal route) to a strong secret; store
      outside the repo.
- [ ] 🔴 **Program upgrade authority**: before any non-devnet deployment,
      transfer to a multisig or renounce (`docs/THREAT_MODEL.md` §6 residual).
- [ ] ✅ No secret material in the repository:
      `python3 scripts/check_secrets.py --self-test && python3 scripts/check_secrets.py`.

## 3. Code gates (all ✅ today)

- [ ] ✅ C++ syntax probe: `./scripts/local_syntax_probe.sh`
      (127 clean / 1 skip / 0 fail).
- [ ] ✅ Signer cross-verification: `./scripts/neonrelay_signer_test.sh`
      (log: `docs/baseline/neonrelay-signer-test.log`).
- [ ] ✅ Backend: `cd backend && npm test` (30/30, Node 22).
- [ ] ✅ On-chain offline suite: `cd onchain && npm test` (12/12).
- [ ] ✅ Hygiene: `check_config_variables.py`, `check_header_guards.py`,
      `tidy_alphabetical.py`, `check_standard_headers.py`.

## 4. Builds (all ⛔ in the sandbox — must run on a release machine)

- [ ] ⛔ Full native server/client build (BL-01): follow `docs/BUILDING.md`;
      the reward-signing server config is `sv_neonrelay_signing 1` +
      key/outfile paths (`docs/DEVNET_RUNBOOK.md` §5).
- [ ] ⛔ Android APK/AAB (BL-02): `docs/BUILDING-android.md` +
      `docs/ANDROID_SEEKER.md` §6; verify the MWA dependency resolves
      (BL-06: `com.solana:mobile-wallet-adapter-clientlib:2.2.0` was pinned
      without network verification).
- [ ] ⛔ Anchor program (BL-03): `cd onchain && cargo test -p
      neonrelay-rewards && anchor build && anchor test --provider.cluster
      devnet`; replace the PLACEHOLDER program id in `Anchor.toml`,
      `lib.rs` and `src/constants.ts` with `anchor keys list` output (the
      conformance test enforces agreement).

## 5. CI

- [ ] 🔴 **Fix GitHub billing** (BL-12): the committed workflow
      `.github/workflows/ci.yml` could not execute (run 35052569158 was
      rejected before any job started). After billing is fixed:
      `gh run rerun 35052569158` or push any commit; all five jobs must be
      green on the release commit.

## 6. Devnet rehearsal (before any real deployment)

- [ ] ⛔ Execute `docs/DEVNET_RUNBOOK.md` end to end with a throwaway test
      mint (`onchain/scripts/create_test_mint.sh`): ingest → caps → seal →
      publish → claim → confirmation, plus a pause/resume drill and a key
      rotation drill.
- [ ] ✅ Segment-wise pipeline evidence already in-repo: backend e2e (30/30),
      Merkle parity backend↔client↔program-source (12/12), signer C++↔Node
      (harness PASS).
- [ ] 🔴 No mainnet mint, no official token, nothing named SKR anywhere —
      re-run `grep -ri skr onchain/ backend/ docs/` and keep it empty
      (enforced for `onchain/` by `onchain/test/program.test.ts`).

## 7. Product honesty

- [ ] ✅ In-game Wallet page states: optional wallet, no guaranteed earnings,
      test tokens have no value, seed phrases never requested
      (`src/game/client/components/menus_settings_wallet.cpp`).
- [ ] ✅ Docs never present mocks as production: blockers BL-01…BL-12 with
      exact failing commands (`docs/KNOWN_LIMITATIONS.md`), final report
      (`docs/FINAL_REPORT.md`).
- [ ] 🟠 Privacy policy / ToS for wallet linking and reward data (operator
      legal, outside repo scope).

## 8. Release decision

- [ ] 🟠 All 🔴 above closed; all ⛔ executed green on the release machine
      with logs attached to the release tag.
- [ ] 🟠 Tag the release commit; record the deployed program id, mint address
      (labelled test/official), backend version and signing pubkey in the
      release notes — never the seeds or keypairs themselves.
