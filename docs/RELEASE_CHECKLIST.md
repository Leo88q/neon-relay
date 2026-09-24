# Release checklist

Gating list for the first public release of Neon Relay (Android/Solana Mobile).
The source IDs are pinned and drift-checked; they are not live deployment
proof. Use `docs/PRODUCTION_DEPLOY_GATE.md` and a concrete external manifest for
current source/toolchain/RPC evidence.
Every item is either **verified now** (with the command that proves it),
**blocked** (with the blocker id from
[`KNOWN_LIMITATIONS.md`](KNOWN_LIMITATIONS.md)), or **pending operator action**.
A release may not proceed while any 🔴 item is open.

Legend: ✅ verified in-repo today · 🔴 blocking, not done · 🟠 must be done by
the operator outside the repo · ⛔ blocked by a documented environment
limitation.

## 1. Legal & assets

- [ ] 🔴 **Legal review of the 250 `block-release` assets** (BL-05). The gate
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
- [ ] 🟠 Set `NEONRELAY_OPERATOR_TOKEN` and `NEONRELAY_SUPERADMIN_TOKEN`
      (distinct strong secrets; proposal workflow, constant-time auth,
      append-only audit) and store them outside the repo. The legacy single
      `NEONRELAY_ADMIN_TOKEN` is devnet-only.
- [ ] 🟠 Copy SQLite snapshots from `POST /v1/admin/backup`
      (`NEONRELAY_BACKUP_DIR`) off-site on a schedule, and run a restore
      drill before the first paid epoch.
- [ ] 🟠 Set `NEONRELAY_RPC_FALLBACK_URL` (distinct provider/infra from the
      primary) and `NEONRELAY_EXPECTED_GENESIS_HASH` for staging/mainnet,
      and run the RPC fallback drill (`docs/DEVNET_RUNBOOK.md` §8).
- [ ] 🔴 **Program upgrade authority**: before any non-devnet deployment,
      transfer all four programs to the Squads multisig vault and verify with
      `onchain/scripts/verify_deployment.sh`; staging/mainnet promotion path
      in `docs/DEPLOYMENT_POLICY.md` (BL-16 gate for real mints). The transfer
      itself is operator action on the release machine.
- [ ] ✅ No secret material in the repository:
      `python3 scripts/check_secrets.py --self-test && python3 scripts/check_secrets.py`.

## 3. Code gates (all ✅ today)

- [ ] ✅ C++ syntax probe: `./scripts/local_syntax_probe.sh`
      (134 clean / 1 skip / 0 fail).
- [ ] ✅ Signer cross-verification: `./scripts/neonrelay_signer_test.sh`
      (log: `docs/baseline/neonrelay-signer-test.log`).
- [ ] ✅ Backend: `cd backend && npm test` (257/257 incl. Tranche-B
      reconcile/stuck/game-events/metrics/alerts suites + dual-RPC
      failover (10 rpc + 2 config) + rewards PDA goldens (4), Node 22).
- [ ] ✅ On-chain offline suite: `cd onchain && npm test` (50/50 incl.
      the rewards-claim client contract suite (8)).
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
      devnet`; compare the live program accounts with the pinned IDs in
      `Anchor.toml`, `lib.rs` and `src/constants.ts`, then record the finalized
      result in an external deployment manifest (the conformance test enforces
      source agreement).

## 5. CI

- [ ] 🔴 **Fix GitHub billing** (BL-12): the committed workflow
      `.github/workflows/ci.yml` could not execute (run 35052569158 was
      rejected before any job started). After billing is fixed:
      `gh run rerun 35052569158` or push any commit; all seven jobs must be
      green on the release commit.

## 6. Devnet rehearsal (before any real deployment)

- [ ] ⛔ Execute `docs/DEVNET_RUNBOOK.md` end to end with a throwaway test
      mint (`onchain/scripts/create_test_mint.sh`): ingest → caps → seal →
      publish → claim → confirmation, plus a pause/resume drill and a key
      rotation drill.
- [ ] ✅ Segment-wise pipeline evidence already in-repo: backend 257/257
      (incl. 26 reconcile + 14 game-events + 5 metrics + 4 alerts = 49
      Tranche-B tests + 12 dual-RPC failover tests + 4 rewards PDA goldens),
      Merkle parity backend↔client↔program-source plus the 8-test
      rewards-claim client contract suite,
      signer C++↔Node (harness PASS), plus live shipper idempotence smoke
      (`scripts/ship_game_events.sh` run1 accepted / run2 duplicates).
- [ ] 🟠 Rehearse the new beta-operations layer on devnet: batch game events
      through the shipper, `GET /v1/admin/metrics`, `GET /v1/admin/stuck`,
      reconcile every sealed epoch, snapshot the treasury after publish/claim
      (`docs/API.md` "Beta operations"), and deliver
      `POST /v1/admin/alerts/test` to the operator channel.
- [ ] 🔴 No mainnet mint, no official token, nothing named SKR anywhere —
      re-run `grep -ri skr onchain/ backend/ docs/` and keep it empty
      (enforced for `onchain/` by `onchain/test/program.test.ts`).

## 7. Product honesty

- [ ] ✅ In-game Wallet page states: optional wallet, no guaranteed earnings,
      test tokens have no value, seed phrases never requested
      (`src/game/client/components/menus_settings_wallet.cpp`).
- [ ] ✅ Docs never present mocks as production: blockers BL-01…BL-18 with
      exact failing commands (`docs/KNOWN_LIMITATIONS.md`), final report
      (`docs/FINAL_REPORT.md`).
- [ ] 🟠 Game event privacy: 90-day rolling purge + per-player deletion are
      implemented and audited (`docs/PRIVACY_GAME_EVENTS.md`); schedule the
      weekly purge cron and record the backup rotation actually used.
- [ ] 🟠 Privacy policy / ToS for wallet linking and reward data (operator
      legal, outside repo scope).
- [ ] 🟠 Incident response: staff the on-call roster and confirm alert
      delivery before mainnet (`docs/INCIDENT_RESPONSE.md`).

## 8. Release decision

- [ ] 🟠 All 🔴 above closed; all ⛔ executed green on the release machine
      with logs attached to the release tag.
- [ ] 🟠 Tag the release commit; record the deployed program id, mint address
      (labelled test/official), backend version and signing pubkey in the
      release notes — never the seeds or keypairs themselves.
