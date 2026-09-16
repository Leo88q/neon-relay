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
./scripts/local_syntax_probe.sh          # C++20 probe: 127 clean / 1 skip / 0 fail
./scripts/neonrelay_signer_test.sh       # C++ signer vs node:crypto: PASS
(cd backend && npm test)                 # 30/30
(cd onchain && npm test)                 # 12/12
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
NEONRELAY_ADMIN_TOKEN=<operator bearer token> \
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
2. At the epoch boundary, seal:
   `POST /v1/rewards/epochs/seal {epoch_id}` with `NEONRELAY_ADMIN_TOKEN`.
   The response contains `merkle_root` and a recomputed `audit_root` — they
   must match, otherwise **stop and investigate** (ledger tampering or bug).
3. Publish the root on-chain:
   `program.methods.publishEpoch(new BN(epochId), hexToBytes(merkleRoot))`
   signed by the operator keypair. One-way: a second publish for the same
   epoch fails by design.

## 7. Player claim ⛓️

1. Player: Settings → Wallet → Connect (MWA on Solana Mobile), then
   `POST /v1/wallet/link` (`docs/WALLET_AUTH.md`).
2. `POST /v1/rewards/claim-intent {epoch_id}` →
   `{amount_micro, leaf_hash, leaf_index, merkle_proof}`.
3. Client pre-verifies the proof with `onchain/src/merkle.ts` before signing
   anything; then submits
   `claim(epochId, amountMicro, leafIndex, proof)` with the player wallet.
4. `POST /v1/rewards/claim-confirmation {intent_id, transaction_id,
   status: "confirmed"}` for audit. A replayed claim fails on-chain (claim PDA
   exists) — that is the guarantee, not the confirmation call.

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
* **Audit**: `GET /v1/rewards/epochs` exposes `audit_root` per epoch; compare
  with the on-chain `EpochState.root` (`anchor shell`:
  `await program.account.epochState.fetch(epochPda)`).

## 9. Known gaps

* No automated e2e test spans backend→chain (BL-03); the pipeline is covered
  segment-wise: backend e2e (✅ 30/30), Merkle parity backend↔client↔program
  source (✅ 12/12), signer C++↔node:crypto (✅ harness).
* The `claim` transaction builder for the mobile client is not implemented
  yet (needs the generated IDL); the Android layer signs transactions via MWA
  (`signTransactions`) and the intent response contains everything required.
* Upgrade authority of the deployed program remains the deploy keypair on
  devnet; hardening is a release-checklist item.
