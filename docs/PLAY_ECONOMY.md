# Neon Relay Play Economy (SKR pay-to-play, top-10 prizes)

Status: on-chain core implemented (stage 14); backend ticket reads, epoch
close job, economy routes and the in-game Wallet→Economy panel implemented
(stage 15). The Mobile Wallet Adapter transaction builder for pay_entry /
claim_prize inside the Android layer is stage 17 (BL-17); until then the
client panel explains the flow and Android logs requests. **No real money moves until the compliance gate in
§7 is signed off.**

## 1. Model in one paragraph

Players pay an entry fee in **SKR** — the Solana Mobile Seeker token, an
external SPL token Neon Relay does not create, mint or hardcode — to join
**ranked matches** and **tournaments** (both models approved). Each payment is
split on-chain: a **rake of 10%** (configurable, capped at 20% in the program)
goes to the operator treasury, the remaining **90%** accumulates in a
program-owned prize vault. At each epoch close the backend computes the
**top-10** from the server-authoritative leaderboard, applies the approved
share table and publishes a Merkle root on-chain; ranked players claim their
prizes from the vault. Game simulation, scoring and eligibility stay entirely
server-side (spec §5); the chain only holds money and published results.

## 2. Token policy (SKR)

* The mint is **operator configuration**, never code: backend env
  `NEONRELAY_SKR_MINT`; the on-chain program receives it once via
  `initialize()` and stores it in its config PDA.
* On **devnet** the economy runs on a labelled throwaway test mint
  (`onchain/scripts/create_test_mint.sh`), explicitly *not* the official SKR.
* On mainnet the operator sets the official SKR mint address from Solana
  Mobile's published sources; the backend validates symbol/decimals over RPC at
  boot and refuses to start on mismatch (fail-fast, no silent wrong-mint).
* Neon Relay never custodies player funds: entry fees move wallet→vault/treasury
  inside one program call; prizes pay out of the program-owned vault via PDAs.
  No private keys exist in clients or game servers.

## 3. Entry flow (match and tournament, per-match since stage 17)

1. Client (Settings → Wallet → Entry) builds `pay_entry(reference, kind)` via
   Mobile Wallet Adapter `signAndSend`; `reference` is the server-issued
   match/tournament id (32 bytes), `kind` = 0 match / 1 tournament.
2. The program checks `!paused`, takes the configured fee for `kind`, splits
   rake→treasury ATA and remainder→vault ATA, and mints an idempotent
   `EntryTicket` PDA keyed by `(reference, player)` — a duplicate payment for
   the same reference fails instead of double-charging.
3. The backend derives the same ticket PDA for `(reference, wallet)` and
   reports ticket status over RPC (`GET /v1/economy/ticket`); epoch prize
   eligibility and ranked counts require a ticket — enforcement lives in the
   authoritative backend pipeline, while the C++ game server stays
   payment-free by design (no money logic in the game binary).
4. Tournament entries additionally register through the features program as
   before; the economy ticket is the payment layer, registration stays free of
   simulation logic.
5. **Per-match references (stage 17):** `POST /v1/economy/match-intent`
   creates a match record and returns
   `reference = SHA256(kind‖epoch‖match_id‖wallet)`; paying it mints a
   match-scoped ticket. Epoch prize eligibility accepts either the epoch
   ranked pass (extra = 0) or any paid match intent of the wallet in that
   epoch, so operators can run per-match pricing, per-epoch passes or both.
6. **On-device transaction building (stage 17):** the Android wallet layer
   (`EconomyTxBuilder.kt`) recomputes references, PDAs, associated-token
   accounts and Borsh payloads exactly like backend/src/economy.ts, fetches
   the config account and a blockhash over public RPC, takes claim proofs
   from the public `GET /v1/economy/proof` route and sends via MWA
   `signAndSendTransactions`. The game client only passes operator config
   (`cl_neonrelay_economy_program`, `cl_neonrelay_rpc_url`,
   `cl_neonrelay_backend_url`, `cl_neonrelay_skr_mint`) — no session, no keys.

## 4. Rake, prize pool and the top-10 table

* Rake default **1000 bps (10%)**, operator-adjustable via `set_params`,
  hard-capped at **2000 bps (20%)** in the program.
* Epoch prize pool = **vault balance minus aggregate on-chain reservations**,
  read from finalized chain state at close time (`readVaultPool`: config
  account → vault address + `reserved`, then vault token balance). The pool is
  never operator-supplied: `poolMicro` in a request is rejected, and the
  vault snapshot (address, balance, reserved) is stored next to every closed
  epoch for later reconciliation. `publish_prizes` re-checks coverage
  on-chain, so an RPC race can only fail closed, never over-allocate.
* Approved share table (basis points of the pool, places 1→10):
  **2500 / 1800 / 1400 / 1100 / 900 / 700 / 600 / 500 / 300 / 200** (sums to
  10000 = 100%; exported as `PRIZE_TABLE_BPS` in `onchain/src/constants.ts`).
* **Leftover policy: redistribution (Tranche A).** With fewer than 10 ticketed
  winners, the occupied places' shares rescale to 100%:
  `amount[i] = floor(pool × bps[i] / sum(occupied bps))`, and the
  integer-division dust (always < n units) goes +1 to the largest remainders,
  ties broken by rank. A full 10-winner close is identical to the raw table;
  a lone winner takes the whole pool. Rationale: the alternatives strand
  funds — carry-over needs cross-epoch vault accounting, refunds need a
  separate instruction — while redistribution keeps every close fully
  accounted: distributed total always equals the pool. Two documented edges:
  dust pools (pool < winner count) may round tail places to zero — those
  winners get no leaf and the remainder stays vaulted; zero eligible winners
  refuse the close entirely and the pool rolls into the next epoch's vault
  balance. Covered by `backend/test/economy.test.ts` (1/2/3/7/10 winners,
  dust, unpaid-leader exclusion, empty close).
* Epoch close job (backend, stage 15; Tranche-A workflow): an operator
  proposes `close-economy-epoch`, a superadmin approves → freeze leaderboard
  → vault-derived pool → redistributed amounts → leaves
  `SHA256(wallet || amount_be)` → padded Merkle tree →
  `publish_prizes(epoch, root, total, leaf_count)` (one-way; `total` must be ≤
  free vault balance; `leaf_count` binds the exact proof depth) → players
  claim with indexed proofs; a Claim PDA per `(epoch, player)` blocks double
  claims.
* Top-10 players additionally receive the existing supply-1 badge tokens as
  non-transferable glory (features program).

## 5. Anti-fraud and money safety

* Server-side caps: max paid entries per wallet per epoch, account age and
  ban-list eligibility (docs/REWARD_SECURITY.md patterns reused).
* Idempotent tickets (reference, player); checked arithmetic for the split;
  pause switch stops new payments instantly; prize roots are publish-once and
  vault-covered; proofs capped at 32 nodes; claim PDAs prevent replays.
* All amounts are raw SPL base units of the configured mint; the program is
  decimals-agnostic, the backend displays human units.

## 6. Why this is not "everything on chain"

Scoring, physics, anti-cheat and leaderboard truth remain server-authoritative;
the chain stores payments, tickets and published roots only. A compromised
chain view cannot fabricate scores, and a compromised server cannot steal the
vault (payouts require a Merkle proof against the published root).

## 7. Compliance gate (mandatory before mainnet money)

* Operator jurisdiction declaration: pay-to-play with skill-based prizes is
  lawful in the operator's country (declared 2026-09-17); **ToS must geo-restrict
  jurisdictions where skill-gaming or prize competitions are licensed or
  prohibited**, plus an age gate (18+) and a "skill, not chance" framing.
* No investment/yield language anywhere in UI or docs ("prizes for ranked
  results", never "earnings"); entry fees are consumption payments.
* Legal review sign-off recorded in docs/RELEASE_CHECKLIST.md before any
  mainnet deployment with the real SKR mint (tracked as BL-16 until signed).
* Solana Mobile / Seeker store policy check for wallet-gated gameplay.
