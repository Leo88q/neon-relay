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

`Anchor.toml`, each `declare_id!` and the TS/backend source constants now hold
one pinned source ID per program. `verify_source_ids.mjs` and the conformance
suite fail on drift. These IDs are **not** proof that a program is live on any
cluster; a concrete environment manifest and finalized RPC verification remain
mandatory:

1. On a connected operator machine, compare `anchor keys list` / the live
   program accounts with the pinned IDs. Do not rewrite source IDs to match an
   unverified deployment.
2. Record the live IDs in `deployment.<cluster>.json` (copy
   `deployment.example.json`), together with genesis hash, real mints and the
   custody authority from §4.
3. Run `verify_source_ids.mjs --strict-manifest` and then the read-only
   `verify_deployment.sh` against that manifest.

Program IDs are never invented by hand and never reused across clusters.

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

## 4. Upgrade authority: custody plus slot-delay policy

No hot wallet may hold a program upgrade authority past the initial devnet
deploy. Custody, signer quorum and wall-clock timelock are operational gates;
this repository does not verify them:

1. Create and approve a concrete multisig or immutable custody policy per environment.
2. `solana program set-upgrade-authority <program-id> --new-upgrade-authority
   <SQUADS_VAULT> --url <cluster> --keypair <current-authority.json>`
   for all four programs.
3. Record the resulting authority in the deployment manifest and re-run
   `verify_deployment.sh` — every program must now report the same expected owner.
4. In-program authority changes additionally respect the configured minimum
   delay of 432,000 slots (`propose_authority_change` → wait for the slot
   condition → `accept_authority_change`). A slot count is not asserted to be
   a fixed number of hours across clusters.

Emergency path: pause the affected program first (`set_paused`, Squads
proposal), then follow the approved upgrade policy. Speed never bypasses the
multisig/custody gate.

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

Production reads chain state through a dual-provider pool
(`backend/src/rpc.ts`): `NEONRELAY_RPC_URL` (primary) plus the optional
`NEONRELAY_RPC_FALLBACK_URL`. Every chain read — tickets, vault pool,
reconciliation, treasury snapshots — tries primary first and fails over
to the fallback on any transport failure, timeout, HTTP error or
JSON-RPC error; a failed endpoint cools down for
`NEONRELAY_RPC_COOLDOWN_MS` (default 30s) and traffic fails back
automatically on recovery. Per-request timeout:
`NEONRELAY_RPC_TIMEOUT_MS` (default 10s).

Chain-identity guard ("config comparison"): the pool pins the first
`getGenesisHash` it learns and rejects any endpoint serving another
chain; with `NEONRELAY_EXPECTED_GENESIS_HASH` set, every endpoint must
match it. A provider pointed at the wrong cluster therefore fails
closed instead of feeding money-path reads. Identity is pinned per
process lifetime; a restart re-verifies.

Requirements:

- HTTPS endpoints with `finalized` commitment support (Helius/Triton or
  self-hosted Agave ≥ 3.0.14); the public `api.*.solana.com` endpoints are
  devnet-convenience only. Primary and fallback SHOULD sit on distinct
  infrastructure (distinct providers, or provider + self-hosted).
- Staging and mainnet MUST set `NEONRELAY_RPC_FALLBACK_URL` and
  `NEONRELAY_EXPECTED_GENESIS_HASH` (the cluster's public genesis hash).

Operability: `GET /v1/admin/rpc-status` shows per-endpoint health
(counters, cooldowns, pinned genesis; URLs are credential-redacted),
`pipeline.rpc` in `GET /v1/admin/metrics` carries the compact summary,
and an on-fallback or chain-rejected state adds a line to stuck-report
digests (`GET /v1/admin/stuck&alert=1`). When *both* providers are down
the pool fails closed — closes and reconciliations return 502/503 and
no distribution is computed. Fallback drill: `docs/DEVNET_RUNBOOK.md`
§8.
