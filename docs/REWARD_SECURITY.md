# Reward security model

How Neon Relay turns *server-signed match results* into *claimable on-chain
allocations* without trusting the client, the wallet, or any single component.
Implementation: [`backend/src/rewards.ts`](../backend/src/rewards.ts); HTTP
contract: [`API.md`](API.md); on-chain enforcement: stage 9
([`SOLANA_ARCHITECTURE.md`](SOLANA_ARCHITECTURE.md)).

## 1. Authority chain

```
game server (C++, stage 8)          backend (this document)            Anchor program (stage 9)
 signs match events with its   →    verifies signatures, enforces  →   verifies Merkle proof and
 ed25519 key                        caps + idempotency, seals          pays exactly once per leaf
                                    epochs into Merkle roots
```

* The **client never produces reward events**. It only plays; the server observes
  and signs.
* The **backend never mints or moves funds**. It publishes roots and hands out
  proofs; the program pays.
* The **program never trusts the backend beyond a root** signed by the operator
  authority; a root cannot pay a leaf that is not in it, and a leaf pays once.

## 2. Event record and signature

An ingested event carries: `match_id`, `player_id`, `wallet_binding_id`,
`event_type`, `amount_micro`, `occurred_at`, `server_signature`. The signed bytes
are the canonical JSON (fixed key order, no whitespace) of
`{match_id, player_id, event_type, amount_micro, occurred_at}` — the same
anti-malleability rule as wallet challenges ([`WALLET_AUTH.md`](WALLET_AUTH.md) §2).

* `NEONRELAY_SERVER_SIGNING_PUBLIC_KEY` configures the only accepted signer;
  **without it ingestion returns 503** — events are never accepted on trust.
* `reward_epoch` is assigned by the backend from its own clock at ingestion
  time; clients and servers cannot back-date events into older epochs.
* `amount_micro` is micro units (1e-6) of the environment's reward mint; devnet
  uses a throwaway test mint, no mainnet mint is hardcoded anywhere.

## 3. Idempotency

`idempotency_hash = SHA256(canonical event bytes)` with a UNIQUE index. A
re-delivered event (server retry, network duplicate, replayed capture) returns
`status: duplicate` and changes nothing. The hash covers exactly the signed
fields, so a server cannot accidentally produce two different hashes for one
logical event, and cannot reuse one signature for two events.

## 4. Caps

Enforced at ingestion, per `player_id`, over *accepted* events:

| Cap | Default | Window |
| --- | --- | --- |
| per match | `NEONRELAY_CAP_PER_MATCH_MICRO` = 50 000 000 | sum per `(match_id, player_id)` |
| daily | `NEONRELAY_CAP_DAILY_MICRO` = 250 000 000 | UTC day of ingestion |
| weekly | `NEONRELAY_CAP_WEEKLY_MICRO` = 1 000 000 000 | UTC week of ingestion |

An event whose amount would cross a cap is stored with
`status: rejected_caps` and a `reason` (auditable, not silent). Caps bind the
*game identity*; a player who links several wallets does not multiply caps,
because ingestion sums by `player_id`, and `/v1/rewards/eligibility` reports the
linked player's usage.

## 5. Statuses

* event: `accepted | duplicate | rejected_signature | rejected_caps |
  rejected_validation | rejected_epoch_sealed`
* epoch: `open | sealed` (sealing is one-way; re-sealing returns 409)
* intent: `created | submitted | confirmed | failed | expired`
  (`confirmed` is terminal; confirming twice returns 409)

Every rejected event is *stored*, so the audit trail includes attempts, not only
successes.

## 6. Epochs, Merkle roots and claims

Sealing (`POST /v1/rewards/epochs/seal`, operator token only):

1. sum accepted events per `wallet_binding_id`;
2. leaf = `SHA256(publicKeyBytes(32) || u64be(amount))`;
3. leaves ordered by binding id, padded by duplication to a power of two;
4. binary SHA-256 tree; root stored on the epoch with `total_micro` and
   `leaf_count`; leaves stored with their indices.

Claiming:

1. `POST /v1/rewards/claim-intent {epoch_id}` (wallet session) returns
   `{intent_id, amount_micro, leaf_hash, merkle_proof}`; the backend verifies its
   own proof against the stored root before returning it;
2. the client submits the proof to the Anchor program (stage 9);
3. `POST /v1/rewards/claim-confirmation` records `submitted` / `confirmed` /
   `failed` with the transaction id. The intent is unique per
   `(wallet_binding_id, epoch_id)`, so the backend never issues two proofs for
   one allocation; **double-payment itself is prevented on-chain** by the
   claim PDA, not here.

`GET /v1/rewards/epochs` and the seal response expose `audit_root`, recomputed
from stored leaves — anyone can re-derive a root and detect ledger tampering.

## 7. Threat model

| Threat | Mitigation |
| --- | --- |
| forged match events | Ed25519 verification against the configured server key; no key → ingestion off |
| replayed/duplicated events | idempotency hash UNIQUE; duplicates are recorded and inert |
| cap bypass via alt accounts | caps per `player_id`; eligibility and balance keyed to the linked binding; sybil wallets share nothing but the caps of their player |
| back-dating into cheap epochs | epoch assigned from backend clock at ingestion |
| inflation by re-sealing | sealing is one-way (409 afterwards); roots and totals immutable |
| inflated leaf amounts | leaves derived only from `accepted` events; caps bound the input; `total_micro` equals the leaf sum (asserted by tests) |
| stolen claim proof | a proof only proves membership; payment requires the wallet signature of the leaf's public key on-chain |
| double claim | on-chain claim PDA (stage 9); backend intent unique per binding+epoch |
| operator abuse of seal | operator route requires `NEONRELAY_ADMIN_TOKEN`; seal is idempotent-refusing and fully auditable via stored events/leaves |
| backend DB tampering | `audit_root` recomputation, stored rejected events, forward-only migrations |
| unbounded ingestion DoS | per-IP token bucket; batch size ≤ 500; signature verification is constant-work |

## 8. Key handling

The backend holds **no** signing key of its own in stage 7: it only verifies.
Stage 8 adds the game-server signer (C++ module, off by default); stage 9 adds
the operator authority that signs epoch roots for the program. Treasury/mainnet
credentials never appear in this repository, its CI variables or its logs.

## 9. Evidence

`cd backend && npm test` → **27/27 passing** on Node v22.22.3, including:
forged-signature rejection, duplicate detection, per-match and daily cap
rejections with reasons, pending→available→claimed balance transitions,
seal/claim-intent proof verification against the stored root, confirmation
state machine, and 404/409/403 paths for foreign wallets, unsealed epochs and
missing operator tokens.
