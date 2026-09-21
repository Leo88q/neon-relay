# Devnet runbook (operator)

End-to-end procedure for running the full Neon Relay reward pipeline on
**Solana devnet**: signed game-server events → backend ledger → sealed epochs →
on-chain root → player claims.

> **Honest status.** Everything marked ⛓️ below requires Rust, Solana CLI and
> Anchor CLI and was **never executed** in the development sandbox
> (`docs/KNOWN_LIMITATIONS.md` BL-03; GitHub Actions that could have run parts
> of it are blocked by account billing, BL-12). Everything marked ✅ was
> executed and evidenced locally. Treat ⛓️ steps as a reviewed runbook, and
> re-verify each command's output before trusting it.
>
> **Cluster policy: devnet only.** No mainnet deployment, no official token,
> no token named SKR. Test mints are throwaway and must be labelled as such
> wherever they appear.

## 0. Prerequisites ⛓️

* Rust stable, `solana-install` (CLI + keygen + airdrop), Anchor CLI **0.30.1**
  (matches `onchain/Anchor.toml` and the pinned `anchor-lang`).
* Node ≥ 22 for the backend and the offline test suites.
* Two distinct operator credentials, generated on the operator machine and
  **never committed**:
  * game-server signing seed: `openssl rand -hex 32 > signing_seed.hex`
    (64 hex chars; consumed by `sv_neonrelay_signing_key_file`);
  * Solana operator keypair (`solana-keygen new`) — becomes the program's
    `config.authority` (publishes roots, pauses).

## 1. Verify the tree ✅

```bash
./scripts/local_syntax_probe.sh          # C++20 probe: 134 clean / 1 skip / 0 fail
./scripts/neonrelay_signer_test.sh       # C++ signer vs node:crypto: PASS
(cd backend && npm test)                 # 159/159
(cd onchain && npm test)                 # 49/49
./scripts/check_secrets.py --self-test && ./scripts/check_secrets.py
./scripts/check_branding.sh --release --check-translations
./scripts/check_assets.sh --licenses
```

## 2. Build and deploy the program ⛓️

```bash
cd onchain
cargo test -p neonrelay-rewards -p neonrelay-features   # pure-logic unit tests + golden leaf
anchor keys list                         # → real program ids (BOTH programs)
# put each id into Anchor.toml [programs.devnet], the matching lib.rs
# declare_id!, and onchain/src/constants.ts (PROGRAM_ID_PLACEHOLDER /
# FEATURES_PROGRAM_ID_PLACEHOLDER) — the conformance tests enforce that all
# three agree per program
anchor build                             # builds the whole workspace
./scripts/create_test_mint.sh            # → NEONRELAY_TEST_MINT=<devnet mint>
export NEONRELAY_TEST_MINT=...
solana airdrop 2                         # devnet SOL for the operator wallet
anchor deploy --provider.cluster devnet
```

## 3. Initialize on-chain state ⛓️

Via `anchor shell --provider.cluster devnet` (or a small TS client once the
IDL exists at `onchain/target/idl/neonrelay_rewards.json`):

```js
// program.initialize(): sets authority = wallet pubkey, creates the vault
await program.methods.initialize()
  .accounts({ mint: new PublicKey(process.env.NEONRELAY_TEST_MINT) })
  .rpc();
// fund the vault so claims can pay (test mint only!):
//   spl-token create-account $NEONRELAY_TEST_MINT   (vault ATA is a PDA —
//   use: spl-token mint ... after transfer, or mint directly to the vault PDA)
```

The mint must have **6 decimals** (`create_test_mint.sh` does); the program
rejects anything else so that `amount_micro` equals SPL base units.

The features program (stage 11) needs no mint at `initialize` — its authority
may be the same operator keypair; see `docs/SOLANA_ARCHITECTURE.md` §7.

## 4. Run the reward backend ✅ (locally) / ⛓️ (hosted)

```bash
cd backend
NEONRELAY_SERVER_SIGNING_PUBLIC_KEY=<base64url pubkey of the stage-8 seed> \
NEONRELAY_OPERATOR_TOKEN=<propose + read bearer token> \
NEONRELAY_SUPERADMIN_TOKEN=<approve + backup bearer token> \
NEONRELAY_EPOCH_MS=604800000 \
NEONRELAY_DB=var/neonrelay.db \
npm start
```

Without `NEONRELAY_SERVER_SIGNING_PUBLIC_KEY` the ingest route answers **503**
— events are never accepted on trust. `GET /v1/health` must be green. API
contract: `docs/API.md`.

The pubkey for the config comes from the signer itself:

```bash
build/neonrelay_match_sign --seed-file signing_seed.hex --pubkey   # ⛓️ needs the tool built
# or, from the harness (fixed TEST-ONLY seed, to rehearse the plumbing): ✅
./scripts/neonrelay_signer_test.sh   # prints the vector pubkey in its log
```

## 5. Run a game server that signs ✅ (config) / ⛓️ (binary)

Server config (`docs/REWARD_SECURITY.md` §8):

```
sv_neonrelay_signing 1
sv_neonrelay_signing_key_file /secure/path/signing_seed.hex   # mode 600
sv_neonrelay_signing_outfile  /var/lib/neonrelay/signed_events.jsonl
sv_neonrelay_reward_per_match_micro 250000
```

Each accepted race finish appends one JSONL line
(`match_id = <game uuid>:<map>`, `event_type = map_finish`). Building the
server binary itself is BL-01 (no full native toolchain in the sandbox).

## 6. Ingest → seal → publish ⛓️ (pipeline rehearsal ✅ via tests)

1. Ship JSONL lines to `POST /v1/rewards/events` (operator-controlled
   transport; the game server makes no network calls for rewards). Responses
   carry statuses `accepted | duplicate | rejected_*` (`docs/API.md`).
2. At the epoch boundary, seal through the two-person workflow: an operator
   proposes (`POST /v1/admin/proposals {type:"seal-reward-epoch",
   params:{epoch_id}}` with `NEONRELAY_OPERATOR_TOKEN`) and a superadmin
   approves (`POST /v1/admin/proposals/approve {proposal_id}` with
   `NEONRELAY_SUPERADMIN_TOKEN`). The approval result contains `merkle_root`
   and a recomputed `audit_root` — they must match, otherwise **stop and
   investigate** (ledger tampering or bug). Economy closes work the same way
   (`close-economy-epoch`); the pool is derived from vault state automatically.
3. Publish the root on-chain:
   `program.methods.publishEpoch(new BN(epochId), hexToBytes(merkleRoot), leafCount)`
   signed by the operator keypair (`leaf_count` comes from the sealed epoch).
   One-way: a second publish for the same epoch fails by design.
4. Snapshot the ledger: `POST /v1/admin/backup` (superadmin) and copy the
   file from `NEONRELAY_BACKUP_DIR` off-site before any paid epoch.

## 7. Player claim ⛓️

1. Player: Settings → Wallet → Connect (MWA on Solana Mobile), then
   `POST /v1/wallet/link` (`docs/WALLET_AUTH.md`), then tap **Claim
   rewards** (needs the backend URL, RPC URL and rewards program id
   configured; config alone never moves money).
2. The wallet layer owns the whole flow (`WalletManager.runRewardsClaim`,
   fed operator configuration only through
   `neonrelay_wallet_request_rewards_claim` — no session token crosses
   JNI): backend session (challenge → wallet signs → verify, cached in
   memory with a 60s expiry skew), sealed-epoch discovery over the public
   `GET /v1/rewards/epochs` list (recent first, at most 8 intent attempts,
   skipping epochs with no allocation for the wallet), then
   `POST /v1/rewards/claim-intent {epoch_id}` for the first claimable
   epoch.
3. The mobile client pre-verifies before signing anything:
   `RewardsTxBuilder.verifyClaim` (paused flag, exact proof depth and index
   bound from the on-chain leaf count, indexed Merkle fold against the epoch
   root — the same rule `onchain/src/merkle.ts` and the program enforce)
   plus a best-effort already-claimed check; then it submits
   `claim(epochId, amountMicro, leafIndex, proof)` via MWA. The base58
   transaction signature comes back in the
   `NEONRELAY_WALLET_EVENT_REWARDS_CLAIM` bridge event.
4. The wallet layer polls `getSignatureStatuses` (≤30s) and posts exactly
   one `POST /v1/rewards/claim-confirmation {intent_id, transaction_id,
   status}` for audit with the observed outcome (`confirmed`/`failed`, or
   `submitted` when finality times out so the backend watches it). A
   replayed claim fails on-chain (claim PDA exists) — that is the
   guarantee, not the confirmation call.

## 8. Operations

* **Pause**: `program.methods.setPaused(true)` — claims stop immediately;
  ingest/seal/publish continue so history stays consistent. Resume with
  `setPaused(false)`.
* **Rotate the game-server signing key**: new seed file on the server, update
  `NEONRELAY_SERVER_SIGNING_PUBLIC_KEY`, restart the backend. Events signed
  with the old key and already ingested stay valid; events arriving after the
  switch with old signatures are rejected (`rejected_signature`).
* **Vault top-ups**: operator-only, test mint only; the program can never
  mint.
* **RPC fallback drill** (after configuring `NEONRELAY_RPC_FALLBACK_URL`):
  point `NEONRELAY_RPC_URL` at a dead address, restart the backend and
  confirm a ticket read still succeeds (`GET /v1/economy/ticket`) while
  `GET /v1/admin/rpc-status` reports `active: "fallback"` with
  `failovers_total` 1; restore the primary URL, wait out
  `NEONRELAY_RPC_COOLDOWN_MS`, and confirm reads fail back
  (`last_failback_at` set, `active: "primary"`). Also verify both
  endpoints report the same `genesis` before any paid epoch.
* **Audit**: `GET /v1/rewards/epochs` exposes `audit_root` per epoch; compare
  with the on-chain `EpochState.root` directly, or run the automated compare
  `GET /v1/admin/reconcile/rewards` / `.../prizes` (per-epoch verdicts +
  persisted snapshots, `docs/API.md` "Beta operations"). Snapshot the treasury
  after every publish and claim (`POST /v1/admin/treasury/snapshot`) so
  movement deltas are reviewable in `GET /v1/admin/treasury`.
* **Health review**: `GET /v1/admin/metrics` (DAU/sessions, finish rate,
  failed-tx rate, pipeline age) and `GET /v1/admin/stuck` every ops shift;
  append `&alert=1` to either reconcile call or the stuck report to push a
  digest to the configured alert channel on non-clean results.
* **Game event shipper**: batch the game server's signed JSONL with
  `scripts/ship_game_events.sh --file events.jsonl --backend $BACKEND`
  (idempotent: re-runs collapse to `duplicate`; see the logrotate note at the
  top of the script). Game event privacy/retention:
  `docs/PRIVACY_GAME_EVENTS.md`.
* **Deployment check**: after every deploy or authority change, re-run
  `onchain/scripts/verify_deployment.sh --cluster devnet --manifest
  onchain/deployment.devnet.json` (manifest copied from
  `deployment.example.json`); promotion policy, Squads + 48h timelock rules
  and incident runbooks live in `docs/DEPLOYMENT_POLICY.md` and
  `docs/INCIDENT_RESPONSE.md`.

## 9. Known gaps

* No automated e2e test spans backend→chain (BL-03); the pipeline is covered
  segment-wise: backend (✅ 159/159, incl. the e2e auth/claim flows), Merkle
  parity + rewards-claim client contract vs the program source (onchain ✅
  49/49), signer C++↔node:crypto (✅ harness).
* The mobile `claim` flow is implemented end to end in the client
  (`RewardsTxBuilder.kt` + `runRewardsClaim`, spec-pinned by
  `onchain/test/rewards_claim.test.ts` and `backend/test/rewards_pda.test.ts`
  against the program source) and the in-game Wallet screen has the Claim
  button firing `neonrelay_wallet_request_rewards_claim`; like the rest of
  the Kotlin layer, it awaits the first Gradle build and an on-device dry
  run (BL-17).
* Upgrade authority of the deployed program remains the deploy keypair on
  devnet; hardening is a release-checklist item.

## 4. Economy program dry-run (devnet, test mint only)

1. `anchor deploy --provider.cluster devnet` includes `neonrelay_economy`
   (placeholder id in Anchor.toml → replace with `anchor keys list`).
2. Test mint: `./onchain/scripts/create_test_mint.sh` — labelled NOT official
   SKR; the official SKR mint is mainnet-only operator config (BL-16 gate).
3. `anchor shell`: `initialize(rake_bps = 1000, fee_match, fee_tournament)`
   with the treasury ATA of the operator devnet wallet; verify config PDA
   fields (`neonrelay_economy_config`).
4. Pay: `pay_entry(reference = sha256("match-1"), kind = 0)` from a second
   wallet; assert treasury/vault ATA deltas = rake/prize and the ticket PDA
   exists; a repeat with the same reference must fail (idempotence).
5. Prizes: build a 10-leaf tree with `onchain/src/merkle.ts`
   (`PRIZE_TABLE_BPS` shares), `publish_prizes(epoch = 1, root, total)`,
   then `claim_prize` for place 1 and assert a second claim fails.
6. `set_paused(true)` → `pay_entry` must fail with `Paused`.

## 5. On-device MWA payment flow (Seeker device, stage 17)

1. Client config: set `cl_neonrelay_backend_url`, `cl_neonrelay_economy_program`
   (from `anchor keys list`), `cl_neonrelay_rpc_url` (devnet) and
   `cl_neonrelay_skr_mint` (test mint label).
2. Settings → Wallet → Economy: "Pay ranked epoch entry" opens the wallet app
   via MWA; the transaction is compiled on-device (EconomyTxBuilder.kt) and
   sent with `signAndSendTransactions`; the ticket PDA appears at
   `GET /v1/economy/ticket`.
3. Claims: "Claim my epoch prize" fetches the proof from the public proof
   route and sends `claim_prize`; a second claim fails (Claim PDA).
4. Verify on-chain: vault ATA delta = fee − rake, treasury delta = rake,
   ticket/claim PDAs exist (`solana confirm` / explorer on devnet).
