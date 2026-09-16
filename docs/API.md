# Reward backend HTTP API

Base URL (deployment): `https://<host>/v1`. Local dev: `http://127.0.0.1:8787/v1`.
All requests and responses are JSON (`content-type: application/json`).
Authentication, where required, is `Authorization: Bearer <session_token>`.

Implemented in stage 6. Stage 7 adds `/v1/rewards/*`; until then those paths
return `404 not-found` (never a stub).

## Error model

```json
{ "error": { "code": "nonce-replayed", "message": "nonce already used" } }
```

`code` is stable and machine-readable; `message` is human text and may change.
Codes per route are listed in [`WALLET_AUTH.md`](WALLET_AUTH.md) §2.3.

## Routes

### GET /v1/health
Liveness and migration state. No auth.

```json
{ "status": "ok", "service": "neonrelay-backend", "version": "0.1.0", "migrations": 1 }
```

### POST /v1/auth/challenge
Issue a single-use wallet challenge. No auth. Body: `{}` (empty object).

```json
{ "challenge": "<base64url>", "nonce": "<base64url>", "expires_at": 1730000120000 }
```

Rate limited per IP (10 burst, ~5/min).

### POST /v1/auth/verify-wallet
Verify the wallet signature over the challenge and open a session. No auth.

Request:

```json
{
  "challenge": "<base64url bytes returned by /v1/auth/challenge>",
  "signature": "<base64url 64-byte ed25519 signature>",
  "public_key": "<base64url 32-byte account public key>",
  "account_label": "optional wallet display label"
}
```

Response `200`:

```json
{
  "session_token": "<base64url, shown once>",
  "session_expires_at": 1730043200000,
  "wallet_binding_id": "uuid",
  "account": { "public_key": "<base64url>", "label": "…" }
}
```

### GET /v1/wallet
Current binding for the bearer session.

```json
{
  "wallet_binding_id": "uuid",
  "account": { "public_key": "…", "label": "…" },
  "player_id": null,
  "session_expires_at": 1730043200000
}
```

### POST /v1/wallet/link
Attach a game player id to the session's wallet binding. Bearer auth.

Request `{ "player_id": "player-42" }` → `{ "wallet_binding_id": "uuid", "player_id": "player-42" }`

### POST /v1/wallet/unlink
Revoke the binding and every session belonging to it. Bearer auth.

Request `{}` → `{ "unlinked": true, "wallet_binding_id": "uuid" }`

After unlinking, the just-used token returns `401 session-revoked`.

## Rewards (stage 7)

### POST /v1/rewards/events
Ingest server-signed match events. **No bearer auth**: authenticity is the
per-event Ed25519 signature checked against `NEONRELAY_SERVER_SIGNING_PUBLIC_KEY`
(absent key → `503 signing-key-unconfigured`). Body:

```json
{ "events": [ {
    "match_id": "m1", "player_id": "p1", "wallet_binding_id": "uuid|null",
    "event_type": "match_win", "amount_micro": 600, "occurred_at": 1730000000000,
    "server_signature": "<base64url>"
} ] }
```

Response `200`: `{ "results": [ {"idempotency_hash", "status", "reason?", "reward_epoch?"} ], "accepted": n }`
with `status` ∈ `accepted | duplicate | rejected_signature | rejected_caps |
rejected_validation | rejected_epoch_sealed` (see
[`REWARD_SECURITY.md`](REWARD_SECURITY.md) §5). Batch limit 500 events.

### GET /v1/rewards/balance  (bearer)
`{ "available_micro", "pending_micro", "claimed_micro" }` — available = accepted
rewards in sealed epochs minus submitted/confirmed claims.

### GET /v1/rewards/eligibility  (bearer)
Cap configuration, used/remaining daily and weekly amounts for the linked
player, reset timestamps and `can_earn`.

### GET /v1/rewards/epochs
Public list: `{id, state, started_at, ended_at, sealed_at, merkle_root, total_micro, leaf_count}`.

### POST /v1/rewards/epochs/seal  (operator)
`Authorization: Bearer $NEONRELAY_ADMIN_TOKEN`, body `{ "epoch_id": n }`.
One-way; returns `{ epoch, audit_root }`. Missing token config → `503`,
wrong token → `403`, already sealed → `409`.

### POST /v1/rewards/claim-intent  (bearer)
Body `{ "epoch_id": n }` → `{ intent_id, epoch_id, amount_micro, leaf_hash,
leaf_index, merkle_proof[], status }`. `leaf_index` is the leaf's position in the
sealed epoch tree; the on-chain claim instruction needs it to fold the proof in
the right direction. `409 epoch-not-sealed` before sealing,
`404 no-rewards-in-epoch` for bindings without accepted rewards. Idempotent per
binding+epoch.

### POST /v1/rewards/claim-confirmation  (bearer)
Body `{ "intent_id", "transaction_id", "status": "submitted|confirmed|failed" }`.
`409 intent-already-confirmed` on repeat confirmation.

### GET /v1/rewards/intents  (bearer)
All intents of the session's wallet binding.

## On-chain hand-off (stage 9)

The `merkle_proof` + `leaf_hash` + `leaf_index` from a claim intent are what the
Anchor program (`onchain/`, stage 9) verifies against the published epoch root;
confirmation statuses mirror the transaction lifecycle and are recorded for
audit only — double-payment is prevented on-chain by the per-(epoch, wallet)
claim PDA.
