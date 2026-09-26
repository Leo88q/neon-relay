# Solana architecture

How Neon Relay uses Solana — and, just as importantly, how it does not.

**Golden rule (spec §blockchain):** the blockchain is used **only** to pay out
rewards that the game servers and the reward backend already decided. No game
simulation, no anti-cheat, no matchmaking, no gameplay state ever touches the
chain. The chain sees one thing per epoch: a 32-byte Merkle root, and one thing
per payout: a proof.

## 1. The whole chain of custody

```
game server (C++)                reward backend (TS)                 Anchor program (Solana)
─────────────────                ───────────────────                 ───────────────────────
signs match events        ──▶    verifies server signatures   ──▶    verifies Merkle proof
(ed25519-donna,                  enforces idempotency + caps         against operator-published
 stage 8)                        seals epochs into roots             root; pays once per
                                 issues claim intents                (epoch, wallet) leaf
        docs/REWARD_SECURITY.md §1–§6                this document §3–§5
```

Every arrow is a verification, never trust: the backend rejects events whose
signature does not match `NEONRELAY_SERVER_SIGNING_PUBLIC_KEY`; the program
rejects claims whose proof does not fold into the published root; a leaf can
only be paid once because the claim record PDA is created at payout.

## 2. Program layout (`onchain/programs/neonrelay-rewards`)

| Account (PDA) | Seeds | Contents | Written by |
| --- | --- | --- | --- |
| `Config` | `neonrelay_config` | operator `authority`, reward `mint`, `paused`, `epoch_count`, bumps | `initialize` (once) |
| `EpochState` | `neonrelay_epoch` ‖ `epoch_id` (u64be) | published Merkle `root`, `leaf_count`, `total_micro`, `remaining_micro`, `published_at` | `publish_epoch` (once per epoch) |
| `ClaimRecord` | `neonrelay_claim` ‖ `epoch_id` (u64be) ‖ wallet pubkey | `amount_micro`, `claimed_at` | `claim` (once per epoch+wallet) |
| vault (`TokenAccount`) | `neonrelay_vault` | reward-mint balance, authority = `Config` | funded by the operator |

Instructions:

| Instruction | Signer | Effect |
| --- | --- | --- |
| `initialize` | operator (becomes `authority`) | records mint (must have 6 decimals ⇒ `amount_micro` = SPL base units), creates vault; not repeatable |
| `publish_epoch(epoch_id, root, leaf_count, total_micro)` | `authority` only | stores the root, exact leaf count and payout ceiling; atomically requires `config.reserved + total_micro <= vault.amount`; **one-way** — re-publish fails because the PDA exists; all-zero root rejected |
| `set_paused(bool)` | `authority` only | emergency stop for `claim` |
| `claim(epoch_id, amount_micro, leaf_index, proof)` | the player's wallet | enforces the **exact proof depth** derived from `leaf_count` (`proof.len() == depth`, unconditional) plus `leaf_index < leaf_count`, verifies leaf `SHA256(wallet_pubkey ‖ u64be amount)` against the root, creates the claim PDA (⇒ **no double claims**), transfers from the vault |

## 3. Merkle construction (identical on all three sides)

`backend/src/merkle.ts` (producer), `onchain/src/merkle.ts` (client
pre-verification) and `lib.rs` (on-chain verifier) implement byte-identical
rules:

* leaf = `SHA256(publicKeyBytes(32) ‖ u64be(amountMicro))`;
* leaves ordered by wallet-binding id, padded to a power of two by
  duplicating the last leaf;
* parent = `SHA256(left ‖ right)`;
* proof = siblings leaf-first, folded with an **explicit leaf index**
  (`leaf_index` is part of the claim-intent response, `docs/API.md`):
  even index ⇒ current hash on the left.

Parity is enforced by tests, not by hope: `cd onchain && npm test` cross-checks
the TS mirror against the backend on randomized trees, pins a golden leaf
vector shared with the Rust unit test
(`onchain/programs/neonrelay-rewards/tests/golden_leaf.txt`), and statically
asserts that `lib.rs` contains the same seeds, fold direction and caps
(BL-03: the Rust code cannot be compiled in the sandbox — the unit test runs
on a connected machine).

## 4. Payout flow (player side)

1. Player connects a wallet in-game (Settings → Wallet) via the Mobile Wallet
   Adapter on Solana Mobile (`android/`, `docs/ANDROID_SEEKER.md`) and links it
   to the backend (`POST /v1/wallet/link`, `docs/WALLET_AUTH.md`).
2. Backend seals an epoch via the proposal workflow (operator proposes, superadmin approves): per-binding sums → leaves → root + `leaf_count`.
3. Operator publishes on-chain: `publish_epoch(epoch_id, root, leaf_count, total_micro)`; the program reserves the declared ceiling against the rewards vault.
4. Player requests `POST /v1/rewards/claim-intent {epoch_id}` →
   `{amount_micro, leaf_hash, leaf_index, merkle_proof}`.
5. The client pre-verifies the proof locally (`onchain/src/merkle.ts`) before
   asking the wallet to sign a `claim` transaction — a bad intent never reaches
   the user's wallet.
6. `claim` executes on-chain; the player reports
   `POST /v1/rewards/claim-confirmation {intent_id, transaction_id, status}`.
   Confirmation is **audit-only**: the no-double-pay guarantee lives in the
   claim PDA, not in the backend.

## 5. Token policy

* **No official token exists.** No token named SKR is created anywhere and the
  name must not be used (spec requirement).
* **No mint is hardcoded** — the mint is an account passed to `initialize`.
  Devnet testing uses a throwaway mint from
  `onchain/scripts/create_test_mint.sh`, explicitly labelled *test, no value*.
* `Anchor.toml` pins `cluster = "devnet"`; mainnet deployment is out of scope
  until legal/liquidity review (see `docs/RELEASE_CHECKLIST.md`).
* The program has **no mint authority in code**: it can only move tokens the
  operator deposited into the vault, and only against published roots. Note
  that, like any Anchor program, a devnet deployment remains *upgradeable* by
  its deploy authority — production hardening (multisig or renouncing the
  upgrade authority) is an explicit item in `docs/RELEASE_CHECKLIST.md`.

## 6. What can go wrong, and what stops it

| Failure | Stop |
| --- | --- |
| Backend compromised, forged intents | intents are re-derived from stored leaves; the on-chain proof must still fold into the operator-published root — the backend cannot invent leaves for an epoch |
| Operator key leaked | attacker can publish roots for *new* epochs (funds in vault at risk) — mitigation: pause (`set_paused`), vault is drained only via valid proofs, epoch publication is one-way so history can't be rewritten; operator key custody is in `docs/RELEASE_CHECKLIST.md` |
| Replay of a claim transaction | claim PDA per (epoch, wallet) exists after first success |
| Claim for someone else's leaf | leaf binds the wallet pubkey; the wallet signs the transaction |
| Amount inflation in transit | amount is inside the leaf hash; changing it breaks the proof |
| Game server key leaked | backend caps + epoch totals bound the damage; rotation = new key file + `NEONRELAY_SERVER_SIGNING_PUBLIC_KEY`, old events already ingested stay valid (see `docs/REWARD_SECURITY.md` §7) |

Threats outside the chain (client tampering, wallet-auth phishing, backend
abuse) are covered in `docs/THREAT_MODEL.md`.

## 7. Features program (`onchain/programs/neonrelay-features`, stage 11)

Non-simulation social/meta features, same trust model (operator authority
writes curated data; players act only on their own behalf; `set_paused` stops
player actions). Gameplay itself never touches the chain — this program only
records facts the server-side pipeline already decided.

| Feature | Accounts / rules |
| --- | --- |
| Achievement registry | per-player PDA (`neonrelay_achievements` ‖ wallet), `[u64; 4]` bitmap = 256 ids; operator service records (`create_registry`, idempotent `record_achievement`) from server-verified match data; the registry carries a `config_authority` stamp and `record_achievement` rejects stale stamps after an authority rotation (SW-2026-09-26 F-04; `restamp_registry` re-vouches explicitly) |
| Badge tokens | a recorded achievement lets **the player** mint one unique collectible through the classic SPL path (`mint_badge_core`): 0-decimal SPL mint PDA (`neonrelay_badge` ‖ id ‖ wallet), supply exactly 1, mint authority = config PDA, second attempt fails on `init` — uniqueness without any external NFT standard; the features registry must be stamped by the operator pinned in `AssetsConfig.features_authority`, and the live features config PDA must agree (SW-2026-09-26 F-04); name/art metadata is served off-chain (BL-13: no metaplex dependency is vendored, it could not be verified offline) |
| Epoch leaderboards | operator publishes a top-N snapshot (≤ 64 `(wallet, score)` rows) per epoch; one-way like reward roots |
| Tournaments | operator opens a registration window (start/end/capacity ≤ 65535); players register (PDA ⇒ one per tournament+wallet, window + capacity enforced) and **lock a refundable stake** of 0.01 SOL in the registration PDA (SW-2026-09-26 F-07: filling all 65 535 slots binds 655.35 SOL concurrently — the anti-sybil property); `cancel_registration` frees the slot and returns the stake, `reclaim_stake` returns it after the tournament ends, the operator can never take it; re-registration for the same pair is intentionally unsupported (the tombstone stays rent-exempt) |

Client helpers: `onchain/src/achievements.ts` decodes the bitmap with the same
word/bit arithmetic as the program; `onchain/test/features.test.ts` pins the
parity plus the authority/uniqueness/pause guards statically (18/18 offline
tests overall in `onchain/`).

## 8. neonrelay-economy (stage 14): pay-to-play money path

Third program, money-only (no simulation): config PDA
(`neonrelay_economy_config`: authority, operator mint, treasury ATA, vault ATA,
rake_bps ≤ 2000, fees, paused), `EntryTicket` PDAs
(`neonrelay_entry` + reference + player; idempotent payment receipts),
`PrizeEpoch` PDAs (`neonrelay_prizes` + epoch LE; publish-once Merkle root,
vault-covered total) and `PrizeClaim` PDAs
(`neonrelay_prize_claim` + epoch + player; double-claim block). Instructions:
`initialize` (operator mint in, never hardcoded), `set_params`, `set_paused`,
`pay_entry` (rake→treasury, rest→vault, one transaction), `publish_prizes`,
`claim_prize` (indexed Merkle proof, leaf = SHA256(wallet || amount_be), vault
pays under config-PDA signature). Invariants: no `init_if_needed`, checked
split arithmetic, pause gate on payments, one-way roots, 32-node proof cap,
exact proof depth from bound `leaf_count` (v1 and v2).
Design and compliance: docs/PLAY_ECONOMY.md.
