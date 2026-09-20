# Deployment policy (devnet → staging → mainnet)

How Neon Relay programs reach a cluster, who can change them afterwards, and
what gates each promotion. This is the Tranche-B answer to "which program is
actually deployed": every environment has a manifest, and the manifest is
verified against RPC — never trusted from a chat message.

## 1. Environments

| Environment | Cluster | Money | Purpose |
| --- | --- | --- | --- |
| `devnet` | Solana devnet | throwaway test mints only (`onchain/scripts/create_test_mint.sh`) | integration testing, Seeker dry runs, audit rehearsal |
| `staging` | Solana devnet, separate keypairs/mints | throwaway test mints only | release-candidate verification: same bytecode + config shape as mainnet, different authority |
| `mainnet-beta` | Solana mainnet | real SKR/POTATO (BL-16 compliance gate) | production; enabled only after every gate in §3 |

Staging and mainnet share everything except the cluster, the mint addresses
and the authority keypairs. A release is promoted devnet → staging →
mainnet; skipping staging is not allowed.

## 2. Program identities

`Anchor.toml` and every `declare_id!` in this repository hold PLACEHOLDER ids
until the first real deployment (BL-03). Replacing them is a mechanical,
reviewed step:

1. `anchor keys list` (or `solana-keygen new` for fresh keypairs) produces
   one program id per program: rewards, features, economy, assets.
2. Update in one commit: `declare_id!` in each `lib.rs`, the
   `[programs.<cluster>]` table in `Anchor.toml`, and the
   `*_PROGRAM_ID_PLACEHOLDER` constants in `onchain/src/constants.ts`.
   `cd onchain && npm test` fails loudly on any drift (program/economy/
   features/assets conformance suites).
3. Record the ids in `onchain/deployment.<cluster>.json` (copy
   `deployment.example.json`), together with the Squads vault from §4.

Program ids are never invented by hand and never reused across clusters.

## 3. Promotion gates

A release moves forward only when all of these hold:

- [ ] `cd backend && npm test` and `cd onchain && npm test` green on the
      release commit; secret/branding/asset gates green.
- [ ] `anchor build --verifiable` reproduces the deployed bytecode
      (`anchor verify <program-id>`); the build image + commit are recorded.
- [ ] `onchain/scripts/verify_deployment.sh --cluster <env> --manifest
      onchain/deployment.<env>.json` reports OK: bytecode present, upgrade
      authority equals the expected Squads vault.
- [ ] Backend migration check: `GET /v1/health` reports the expected
      migration count; `POST /v1/admin/backup` succeeds before any paid epoch.
- [ ] Reconciliation clean: every sealed epoch `match`es via
      `GET /v1/admin/reconcile/{rewards,prizes}`; `GET /v1/admin/stuck` empty.
- [ ] Staging soak: at least one full epoch (seal → publish → claim) on
      staging with the release bytecode before mainnet.
- [ ] Mainnet additionally: BL-16 compliance sign-off recorded in
      `docs/RELEASE_CHECKLIST.md`, alerts configured
      (`POST /v1/admin/alerts/test` delivered), on-call roster staffed
      (`docs/INCIDENT_RESPONSE.md`).

## 4. Upgrade authority: Squads + 48h timelock

No hot wallet may hold a program upgrade authority past the initial devnet
deploy:

1. Create a Squads multisig (3-of-5 recommended) per environment.
2. `solana program set-upgrade-authority <program-id> --new-upgrade-authority
   <SQUADS_VAULT> --url <cluster> --keypair <current-authority.json>`
   for all four programs.
3. Record the vault in the deployment manifest and re-run
   `verify_deployment.sh` — every program must now report the vault.
4. In-program authority changes additionally respect the 48h timelock
   (`propose_authority_change` → wait 432,000 slots → `accept_authority_change`).

Emergency path: if an upgrade must land faster than the timelock allows, the
incident commander pauses the affected program first (`set_paused`, Squads
proposal), then upgrades. Speed never bypasses the multisig.

## 5. Rollback

Solana programs have no downgrade: rollback means fix-forward.

1. Pause the affected surface (`set_paused` / backend proposal freeze).
2. Deploy the fixed bytecode through the same §3 gates (expedited review,
   still multisig-signed).
3. Reconcile: re-run `verify_deployment.sh`, reconcile every affected epoch,
   snapshot the treasury, and attach all three to the incident record.

Data (ledger, snapshots, audit) is never rolled back — forward-only
migrations plus `POST /v1/admin/backup` restores are the recovery story.

## 6. RPC configuration

Production reads chain state through `NEONRELAY_RPC_URL`. Requirements:

- HTTPS endpoint with `finalized` commitment support (Helius/Triton or
  self-hosted Agave ≥ 3.0.14); the public `api.*.solana.com` endpoints are
  devnet-convenience only.
- Dual-provider failover (primary + fallback with config comparison) is the
  documented follow-up; until it lands, an RPC outage fails closed — closes
  and reconciliations return 502/503 and no distribution is computed.
