# Additive economy program v2 (BL-16 part 6)

> **HISTORICAL / SUPERSEDED:** paragraphs below that cite GitHub CI, SBF,
> validator or local suite counts describe an older revision and are not
> evidence for the current checkout. Re-run the gates from
> `docs/PRODUCTION_DEPLOY_GATE.md`; unavailable tooling is not silently treated
> as a pass.

**Source-contract and offline TypeScript checks pass locally; Rust/Anchor
compilation, validator execution and deployment remain unverified. Backend v2
payments are fail-closed until the production gate passes.**

Source: `onchain/programs/neonrelay-economy/src/lib.rs`.
Host tests: `onchain/programs/neonrelay-economy/tests/v2_unit.rs`.
Historical CI links are not evidence for the current checkout; use
`docs/PRODUCTION_DEPLOY_GATE.md` for release status.

The v1 entry points and account layouts remain separate. Two existing Anchor
compile issues were corrected without changing v1 serialization: token account
`owner` field and the writable payer on legacy prize publication.

## Administration and mint isolation

Initialize one v2 config for each operator-approved mint, using the seed scheme
in ECONOMY_V2_LEDGER.md. Each config creates its own associated-token vault and
stores a treasury token account belonging to its authority and mint. There are
no hardcoded token mints. The backend must still restrict requests to the two
configured product currencies; the program is intentionally mint-agnostic.

`initialize_v2` requires the signer to match the existing legacy config's
operator authority. This prevents an arbitrary caller from claiming an
uninitialized v2 market. It relies on correct prior initialization and trusted
ownership of that legacy config; it does not replace the v1 bootstrap policy.
V2 authority rotation is a separate pending-authority PDA with a slot-delay
policy and requires a signer-owned replacement treasury ATA.

Mint decimals determine the four fixed whole-token entry fees 50/100/500/2000.
Overflow rejects initialization (e.g. 16 decimals cannot represent the largest
fee as u64). Ranked and tournament kinds both require a paid tier. There is no
free-entry instruction until Legendary-holder verification is implemented.
Rake is chosen at initialization, <=2000 bps; product default is 1000 bps.

## Instructions and ABI

All names have distinct Anchor discriminators from v1. Instruction integer
arguments are Borsh little-endian. Merkle **amount** bytes remain big-endian.

| Instruction | Arguments | Account order |
| --- | --- | --- |
| initialize_v2 | rake_bps u16 | authority, legacy_config, mint, config, treasury_ata, vault_ata, token_program, associated_token_program, system_program |
| set_paused_v2 | paused bool | authority, config |
| pay_entry_v2 | reference [u8;32], kind u8, tier u8 | player, config, player_ata, vault_ata, treasury_ata, ticket, token_program, system_program |
| publish_prizes_v2 | epoch u64, root [u8;32], total u64, leaf_count u32 | authority, config, vault_ata, prizes, system_program |
| claim_prize_v2 | epoch u64, amount u64, leaf_index u32, proof Vec<[u8;32]> | player, config, player_ata, vault_ata, prizes, claim, token_program, system_program |

New Borsh account sizes, INCLUDING the 8-byte discriminator:
config 180; ticket 123; prize epoch 109; claim 97. They must not be decoded by
the v1 parsers/builders. Account field order is explicitly defined in Rust and
pinned by host tests using `INIT_SPACE`.

`pay_entry_v2` binds mint/player/reference in the Ticket PDA, stores kind/tier/
amount and transfers rake+prize atomically. The payer cannot alias the vault or
treasury source. It does NOT authenticate a race reference or enforce race
capacity: the backend must validate reference, player, kind, tier and expected
fee before admitting anyone. Wallet ownership of a ticket alone is insufficient.

## Publication, reservations and claims

- All entry/publication/claim paths honor that mint's pause flag.
- Publication is authority-only and init-only. Root cannot be replaced.
- Nonzero root/total and 1..10 leaves are required.
- `reserved + new_total <= vault.amount` prevents two epochs committing the
  same funds. Reservation arithmetic is checked. A claim decreases both the
  epoch remaining amount and aggregate reservation by the transfer amount.
- Claim PDA includes mint/epoch/player and uses init, so a second claim fails.
- The claim binds `SHA256(wallet || amount_u64be || mint)`, exact padded-tree
  depth for the published leaf count, valid index and at most 32 proof hashes.
- Destination owner/mint, vault key/owner/mint and epoch mint are constrained.
- Token CPI failure rolls back state along with the transaction; this property
  still needs validator-backed integration coverage for the new instructions.

There is no arbitrary close or withdrawal instruction. An invalid operator
root still requires review before publication, while an expired epoch can be
swept exactly once through the authority-only, time-gated
`sweep_expired_prizes_v2` path; the remaining reservation is reduced only by
that sweep or by a successful claim. A cancelled paid v2 ticket has a separate
`refund_entry_v2` instruction: the authority must approve it, the ticket is
closed atomically, and the exact rake/prize split is paid from the corresponding
classic-SPL treasury and vault balances. Neither path is an operator-controlled
instant withdrawal.

## Remaining release gates

1. SBF build and validator-backed tests using two SPL mints: cross-mint account
   substitution, duplicate ticket/claim/root, insufficient funds, pause,
   overreservation, CPI rollback and exact token balance conservation.
2. Update backend RPC validation, expected fee/tier checks and publication flow;
   database budget is not an RPC-verified vault balance.
3. Update Android v2 account derivation/serialization and proof verification;
   current mobile transaction methods still target v1.
4. Live lobby/join integration, race capacity, NFT ownership and freeroll funding.
5. Operator review of program identity, bootstrap authority and configured mints.

The TypeScript source-contract checks only inspect Rust source. The dedicated
Rust workflow compiles account constraints and runs pure host tests; neither
should be reported as a validator test or proof of deployed fund safety.

## Part 7: backend read-only RPC inspection

`backend/src/economy_v2_rpc.ts` parses v2 accounts separately from v1. It
first discovers the treasury through the config PDA, then rereads config, mint,
vault, treasury and optional ticket in one finalized `getMultipleAccounts`
response with `minContextSlot`. Immutable market addresses must not change
between discovery and the snapshot. RPC transport has a ten-second timeout.

Checks include exact account size, canonical base64, non-executable status,
program owner, Anchor discriminator, mint-qualified PDA/bump, canonical vault
ATA, SPL mint initialization/decimals, treasury and vault mint/authority,
expected tier fees, rake cap, pause encoding and reserved balance coverage.
Only classic SPL Token is supported: Token-2022, frozen accounts, native token
accounts, delegates and close authorities are rejected conservatively. Mint
and freeze authorities may exist; this reader does not certify token economics,
upgrade authority safety or operator identity beyond the configured program.

Authenticated, rate-limited GET routes:

- `/v2/economy/market?currency=SKR` (or POTATO): operator-configured market
  snapshot; all base-unit integers are decimal strings.
- `/v2/economy/ticket?currency=SKR&idempotency_key=...`: looks up an existing
  immutable internal intent for the session's player, requires the same wallet,
  and validates the ticket PDA, wallet, mint, reference, kind, tier and amount.
  A missing ticket returns `ticketed:false`; malformed/incompatible accounts
  fail closed. There is no public intent-creation route.

Both payment and admission enablement remain **false**. A valid paid ticket is
not authorization to join, a race-capacity reservation, an authenticated game
identity, or proof of NFT/freeroll eligibility. In particular the existing
self-service player link is not sufficient game identity attestation. Paused
markets can be inspected, but cannot become enabled through these routes.
The lobby remains an offline catalog and does not mark its mints verified.

Tests use synthetic RPC data, real session signatures and an ephemeral HTTP
RPC server. They do not demonstrate validator execution or live payment.
Finalized RPC responses are trusted infrastructure input, not light-client
proofs. SBF/validator tests and operator deployment verification remain gates.

## Part 8: native bank/runtime integration

`onchain/programs/neonrelay-economy/tests/v2_runtime.rs` runs the actual Anchor
entrypoint and SPL Token processor under `solana-program-test = 1.18.26`, not
mock token-transfer callbacks. The transaction signer keys are ephemeral,
generated inside the test process; no keys are persisted or sent to a cluster.

The scenario verifies:

- 50-token entry debits 50, credits treasury 5 and vault 45, and creates the
  mint/player-bound ticket; a duplicate cannot charge again.
- A 100-token entry with only 50 available reaches the first (10-token rake)
  CPI, then fails the 90-token prize CPI. Both transfers and ticket initialization
  roll back atomically; all three token balances remain unchanged.
- Unauthorized pause fails; authorized pause prevents payment and claim.
- Publication reserves 45; duplicate publication and a second epoch attempting
  to reserve one more token fail without leaving the second epoch account.
- Incorrect claim amount fails without leaving a claim account or reducing
  reserves. A valid claim uses the config PDA signer to transfer 45 back to the
  player, exhausts epoch/config reserves, and cannot execute twice.

Retries use different compute-budget instructions so the bank cannot satisfy
negative tests from a cached identical transaction signature. Anchor's native
entrypoint lifetime adapter retains a small cloned AccountInfo slice per test
invocation, without unsafe casts; it is test-only and never linked into the
program. Test-profile debug info is disabled to limit CI linker disk use.

Verified Rust run (host tests plus native runtime scenario):
https://github.com/Leo88q/neon-relay/actions/runs/35305393273
at commit `d6ca9d0`. Full local gates also pass (`80` backend, `32` onchain TS).

**Scope limitation:** config and token balances are seeded in genesis; this is
not an `initialize_v2`/mint initialization test. It is not SBF execution, a
validator/deployment test, exhaustive cross-mint attack testing, or proof that
an operator deployment is safe. Those remain release gates. No public payments
or race admission have been enabled.

## Part 9: v2 initialization and two-mint runtime isolation

The second scenario in `tests/v2_runtime.rs` now invokes `initialize_v2` with
real Associated Token/System/SPL program processors. It creates two independent
v2 configs and canonical vault ATAs for synthetic mints with 0 and 6 decimals.
The earlier part-8 initialization limitation therefore applies only to the
first scenario, not to the full current suite.

Verified cases:

- Only the seeded legacy operator can initialize a market; a treasury with
  another mint or another owner is rejected.
- Rake above 2000 bps and a third mint with 16 decimals fail, with neither
  config nor vault left behind. Duplicate initialization fails.
- Config identity, all four decimal-scaled fees, initial reserves/pause, and
  vault mint/owner/zero balance are checked after successful initialization.
- Swapping payment source, vault, treasury or ticket with the other mint's
  account fails without creating tickets or changing token balances.
- The same wallet/reference can pay independently in both markets; ticket
  addresses differ. Both markets independently publish epoch 1.
- Cross-market vault, epoch and claim-account substitutions fail. Claiming
  market A leaves market B's reserved balance and vault unchanged. Both valid
  claims succeed, both duplicate claims fail, all reserves/epoch remainders
  reach zero, and each treasury retains exactly its own 10% rake.

Rust host tests and both native runtime scenarios passed at `b5da216`:
https://github.com/Leo88q/neon-relay/actions/runs/35305779544
General CI passed at the same source revision:
https://github.com/Leo88q/neon-relay/actions/runs/35305779545
The current local suites are reported in `docs/PRODUCTION_READY_SUMMARY_RU.md`; they
must be rerun after every source change. They do not replace Rust/Anchor or
validator evidence.

Still seeded: legacy operator config, initialized mint accounts, source token
balances and treasury accounts. This does not test legacy bootstrap, SPL mint
creation/minting, SBF binary execution, upgrade/deployment controls, every
possible attack, or game admission. Payments remain disabled.

## Part 10: built SBF execution (verified)

CI now builds the economy ELF with the Agave v3.1.8 tool distribution. The
Linux archive is pinned by SHA-256
`e951bb8127c57460bc3ebca1671952e9b164e249d713fcebe2c125f70b8791e8`.
The build does not deploy anything or use an operator wallet.

The two `v2_runtime` scenarios run twice: first with the native Anchor
entrypoint, then with `NEONRELAY_TEST_SBF=1` and `BPF_OUT_DIR` pointing to the
freshly built ELF. SBF mode checks that the file exists and registers the economy
with **no native processor fallback**. SPL Token and Associated Token remain
real native processors in the bank harness. Thus the economy itself executes
as SBF, including initialization, mint-isolated payments, reserves, PDA-signed
claims, pause, replay rejection and atomic failures covered in parts 8–9.

The first ELF built successfully but positive transactions failed with
`ProgramFailedToComplete`, despite passing native tests. Moving v2 decoded
`Account` fields into `Box<Account<...>>` resolved execution failures. This
reduces stack pressure without changing account serialization, instruction
arguments, PDA seeds or constraints. Transaction metadata is now included in
assertion diagnostics, and CI publishes bounded failure annotations so a
failed execution is not hidden behind successful compilation.

The following is retained only as historical context from an older revision;
`fb85089` and the linked CI runs do not attest to this checkout. Current source
and toolchain gates must be generated by the release scripts and recorded
outside the repository.

The `economy-sbf` artifact contains only `neonrelay_economy.so` and
`economy-sbf.sha256`. The resolved Cargo.lock is a separate review artifact;
no keypair files are uploaded. This is an observed build/test result, not a
claim of a fully reproducible audited release or locked transitive toolchain.

Remaining gates: standalone validator/RPC lifecycle and deployment verification,
legacy bootstrap trust, real mint setup, backend/mobile/game integration and
admission authorization. These tests are not a cluster deployment and do not
validate every legacy v1 instruction. Public payments/admission remain disabled.

## Part 11: isolated validator/RPC lifecycle (verified)

`onchain/scripts/test_local_validator.sh` starts an ephemeral Agave validator
on loopback, loading the built economy ELF into genesis with `--bpf-program`.
The Rust `v2_validator` test is ignored by normal host runs and explicitly
invoked by this script. Its RPC URL is fixed to `http://127.0.0.1:8899`; it cannot
be configured to send these transactions to devnet or mainnet. Test signer
keys are generated in memory. The temporary ledger and public-account fixture
are deleted when the script exits, and the validator process is stopped.

Unlike the earlier bank scenarios, this test does not seed economic state:

1. Request local faucet SOL for two ephemeral signers.
2. Create and initialize two SPL mints, create source/treasury ATAs, mint test
   tokens through SPL instructions.
3. Invoke the actual legacy `initialize`, then `initialize_v2` for each mint.
4. Pay 50, check source/treasury/vault balances of 50/5/45, and reject replay.
5. Publish a 45-token single-leaf epoch, claim it, reject duplicate claim, check
   balances of 95/5/0 and zero config reservations/epoch remainder.
6. Wait for the final observed slot to root. The Node script
   `verify_validator_rpc.ts` invokes the **production backend v2 RPC decoder**
   on both markets/tickets using finalized reads, confirming their mint-bound
   identity, fee, ownership, balances and disabled-payment flag.

Negative replay assertions require a transaction error, not merely an RPC
transport failure. Legacy initialization's decoded accounts were boxed like
v2 accounts to reduce SBF stack pressure; serialized ABI and constraints are
unchanged. This checks legacy initialization only, not all v1 payment/claim
instructions or the trustworthiness of legacy first-caller bootstrap.

The validator description and links in this historical section are not a
current deployment result. The current checkout has no verified validator or
external RPC evidence unless the release gate produces it.

To rerun with the pinned toolchain installed and ELF already built:

```sh
onchain/scripts/test_local_validator.sh
```

**Remaining scope:** genesis loading is not an upgradeable-loader deployment
transaction, deployment-authority audit or external-cluster verification. The
backend test exercises RPC decoding, not the full authenticated HTTP/game/mobile
purchase/admission flow. NFT ownership, mint policy, tournament authorization,
game identity attestation and release gates remain separate. Public payments
and race admission remain disabled.
