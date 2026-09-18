# Dual-currency lobby policy (BL-16 part 2)

## Current implementation

`GET /v2/economy/lobby` is a public, rate-limited, **read-only catalog**.
Optional query `currency=SKR` or `currency=POTATO` selects one category;
unsupported, empty and repeated currency parameters return HTTP 400.
No session, chain keys, RPC calls or database writes are needed to browse.

The response contains `mode: "catalog-only"`, `paymentsEnabled: false`,
`disabledReason: "dual-mint-settlement-not-deployed"`, and `joinEnabled: false`
on every race. There is no v2 join/payment endpoint. Do not use v1 tickets to
join the v2 catalog: v1 settlement remains legacy single-mint settlement.

## Configuration

- `NEONRELAY_SKR_MINT`: operator-provided Solana Mobile Seeker token address,
  or a labelled test mint on devnet. No official/mainnet address is embedded.
- `NEONRELAY_POTATO_MINT`: operator-provided POTATO test mint.
- Missing or empty values remain null/unconfigured.
- Values must be canonical, nonzero 32-byte base58 addresses; identical SKR
  and POTATO addresses are rejected at startup.
- Address syntax is NOT proof that an account is an SPL mint, that the token
  is authentic, or that it uses any particular number of decimals.
  `mintVerified` therefore remains false.

## Catalog and arithmetic

| Tier | Players | Entry (whole tokens) |
| --- | --- | --- |
| Micro Sprint | 10 | 50 |
| Neon Dash | 20 | 100 |
| Chromatic Cup | 50 | 500 |
| Grand Prix | 100 minimum, maximum unspecified | 2000 |
| Legend Freeroll | organizer-defined | 0; Legendary holders only |

Entries are decimal strings in **whole token units**, not six-decimal micro
units. Never multiply them by a hardcoded decimal factor to sign a transfer.
Legendary ownership verification and freeroll sponsorship are not implemented.
`rankedEntryRequired: true` declares the intended policy, not enforcement.

Rake defaults to 1000 bps with a 2000 bps maximum. Preview helpers use bigint,
reject invalid player counts and amounts outside u64, and check gross-pool
overflow. Rake is rounded down per ticket, matching the legacy on-chain
payment split; the remaining units belong to the prize pool.

The preview's top ten percentages are 25/18/14/11/9/7/6/5/3/2. Integer-unit
remainders use largest remainder with rank as a tie-breaker, conserving the
pool exactly. This helper is NOT yet wired to epoch publication. Underfilled
races and fewer-than-ten winners need settlement policy before deployment.
A 100-player Grand Prix produces 180,000 prize tokens after rake; first place
at 25% receives **45,000**, not 40,000.

## Required coordinated migration (not implemented here)

The following must change together before payments can be enabled:

1. Rust `neonrelay-economy` state and PDA seeds: config/vault/treasury per mint;
   mint in entry, prize epoch and claim identity. Reject cross-mint accounts,
   keep one-way publication, checked arithmetic and pause/claim guards.
2. Backend database migration: mint-qualified epoch keys, match intents,
   distributions and idempotency identities. Do not relabel legacy rows with
   an arbitrary mint; old rows require explicit operator migration policy.
3. Backend economy proof generation AND `/v1/economy/proof` currently use the
   same `leafHash` as legacy rewards. Introduce a versioned economy leaf
   `SHA256(wallet32 || amount_u64be || mint32)`; do not silently break rewards.
4. Update Android `EconomyTxBuilder.kt`, onchain TS constants/helpers and
   backend PDA derivation in lockstep. Pin shared golden vectors and negative
   cross-mint proofs in all implementations.
5. RPC verification of mint owner/decimals, ticket owner/discriminator/player/
   reference/mint and amount before accepting a paid result. Current legacy
   ticket parsing is not sufficient for a production dual-mint deployment.
6. Tier-specific fees, atomic intent/idempotency checks, holder authorization
   for free entry and vault funding checks. Never accept caller-chosen fee
   amounts as authoritative.
7. Build Rust programs and run validator-backed two-token isolation, replay,
   pause and conservation tests. The existing 25 offline tests alone do not
   establish these properties.

This stage deliberately leaves all v2 payments disabled instead of shipping a
partially migrated transaction format.
