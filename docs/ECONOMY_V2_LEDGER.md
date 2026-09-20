# Economy v2 ledger and wire draft (BL-16 part 5)

**Status: backend-internal, no public payment/claim endpoint, no Rust deployment.**
The lobby remains `paymentsEnabled: false`. An intent is not a paid ticket;
a sealed database epoch is not an on-chain published root. Returned internal
proofs explicitly say `published: false`.

## Isolation and migration

`0005_economy_v2.sql` adds separate tables. It does not copy, reinterpret or
mutate `economy_epochs`, `economy_matches` or the rewards ledger. Existing v1
claims still use the existing v1 leaf/PDA formats. Migration tests populate
legacy rows before applying v2 and assert that they survive unchanged.

Epoch primary key: `(mint, epoch)`.
Intent primary key: `(mint, player_id, idempotency_key)`.
Reference uniqueness: `(mint, reference)`.
Foreign key: intent `(mint, epoch)` -> epoch `(mint, epoch)`.

Database mint/wallet/hash fields are lowercase raw-byte hex (64 characters),
not base58. u64 epoch/amount fields are canonical decimal TEXT, not SQLite
signed integers or JSON floating-point numbers. Runtime operations use bigint;
SQL rejects negative, fractional, leading-zero and out-of-range values.
Decimals are not inferred: amounts are already SPL base units supplied by a
trusted caller. This stage does not fetch/verify mint decimals.

## Internal store contract

`EconomyV2Store` is not directly exposed by HTTP routes. Before calling it,
the integration layer must authenticate the player ID, resolve the configured
mint, verify fees/ownership/paid results, and validate vault funds. None of
those checks can be replaced by successfully inserting an intent here.

- `openEpoch(mint, epoch, poolBase)`: insert once. Pool is an internal budget,
  not evidence of a funded vault. No pool edits or epoch deletion.
- `createIntent`: BEGIN IMMEDIATE protects idempotency and the per-player,
  per-mint, per-epoch count check in the same synchronous transaction.
  Exact retries are safe, including after sealing; changed payloads conflict.
  Rotating wallets with the same player ID does not reset the count. The cap
  is a constructor policy (default 1000), NOT a tournament capacity or token
  reward cap. Conflicting worker policy values must not be configured.
- `sealEpoch`: accepts 1..10 explicit positive payouts from a trusted caller,
  rejects duplicate wallets and u64 overflow, checks sum <= budget, sorts by
  raw wallet hex and computes mint-bound leaves/root. This method does NOT
  rank players or redistribute unused ranks. Ranking/payout authorization
  still belongs to a future settlement integration.
- `proof`: reconstructs and checks the root before returning an unpublished
  v2 proof for that mint/epoch/wallet. Unknown/open epochs or wallets return null.

Only OPEN -> SEALED is allowed. SQL triggers prohibit mutation/deletion of
sealed epochs and of intents, and prevent INSERT OR REPLACE from bypassing
these guards. These protect ordinary application statements, not a malicious
DB administrator who can drop triggers or alter the file.

## V2 leaf and proof contract

```
leaf = SHA256(wallet32 || amount_u64be || mint32)
parent = SHA256(left32 || right32)
```

Tree padding/order is the existing indexed complete-binary construction.
Proof verification caps depth at 32, validates each 32-byte hash, requires a
u32 index and rejects unused high index bits (`index < 2**proof.length`). It
uses arithmetic division rather than JS signed bit shifts. Legacy rewards
helpers are unchanged.

Implementations: `backend/src/economy_v2_codec.ts` and the independent offline
client mirror `onchain/src/economy_v2.ts`. Shared leaf vectors in
`onchain/test/fixtures/economy_v2.json` were generated with Python hashlib,
including different mints and u64 maximum. Tests exercise cross-mint rejection,
malformed proofs and the maximum depth/index combination.

## Reserved v2 PDA derivation (not deployed)

All seeds are UTF-8; public keys/reference are raw 32 bytes:

```
config = ["neonrelay_economy_v2", mint]
entry  = ["neonrelay_entry_v2", mint, reference, wallet]
prizes = ["neonrelay_prizes_v2", mint, epoch_u64le]
claim  = ["neonrelay_claim_v2", mint, epoch_u64le, wallet]
```

Each mint gets its own config; separate token vaults/treasuries must be created
and constrained by the future Rust instructions. The backend derivation alone
does not create these accounts. Never send these addresses to v1 instructions.

An internal intent reference is SHA256 of UTF-8 domain
`neonrelay:economy:v2:intent` followed by one NUL byte and compact JSON of:

```
[mintHex, epochDecimal, playerId, walletHex, idempotencyKey, kindNumber, tierId, amountDecimal]
```

Array field order and string/number types are part of this draft contract.
The client must receive/reproduce this reference only after authenticated
server fee and race validation; arbitrary tier/amount values accepted by this
low-level store are not authorization to pay or enter.

## Verification and remaining work

Backend tests include SQL constraints, rollback, migration, idempotency,
per-player caps, two independent database connections and mint-isolated roots.
The two-connection test is sequential visibility/locking-policy coverage, not
a stress/concurrency benchmark. Node tests do not execute Anchor programs.

Still required: Rust v2 instructions/accounts and authority constraints,
vault reservation/accounting, fee tiers, verified NFT freerolls, transaction
builder updates, authenticated endpoint wiring, validator-backed replay/
pause/isolation tests, and a complete Android build. No balances were moved
and no program was deployed in this stage.
