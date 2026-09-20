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
Optional pagination: `?limit=1..200&offset=n` returns
`{ epochs, pagination: { limit, offset, total } }` instead of the bare array.

### POST /v1/rewards/epochs/seal — removed (410)
Direct sealing was replaced by the two-person proposal workflow
(`POST /v1/admin/proposals` + approve). The old path answers
`410 admin-workflow-required` with migration guidance, never a silent stub.

## Admin (Tranche A: roles, proposals, audit, backups)

Admin tokens: `NEONRELAY_OPERATOR_TOKEN` (propose + read) and
`NEONRELAY_SUPERADMIN_TOKEN` (approve/reject + backup). The legacy
`NEONRELAY_ADMIN_TOKEN` acts as a superadmin. Authentication is constant-time;
unknown tokens and wrong roles both answer `403 admin-forbidden`, missing
configuration answers `503 admin-disabled`. Secrets never touch the database:
audit attribution uses sha256 fingerprints.

### POST /v1/admin/proposals  (operator+)
Body `{ "type": "seal-reward-epoch" | "close-economy-epoch", "params": { … } }`
with `params = { epoch_id }` for seals and `{ epoch }` for closes.
Returns the open proposal (default TTL 24h, `NEONRELAY_ADMIN_PROPOSAL_TTL_MS`).
Bad type → `400 bad-proposal-type`, bad params → `400 bad-request`.

### POST /v1/admin/proposals/approve  (superadmin)
Body `{ "proposal_id": "uuid" }`. Executes the action and returns
`{ row, result, selfApproved }`. With split role tokens the approver must
differ from the proposer (`403 distinct-approver-required`); single-token
setups may self-approve, flagged in the audit log. Approving an expired
proposal marks it expired → `410 proposal-expired`. If execution itself
fails (e.g. `409 epoch-already-sealed`), the proposal stays open and the
failure is audited.

### POST /v1/admin/proposals/reject  (superadmin)
Body `{ "proposal_id": "uuid", "reason?": "…" }`. Marks the proposal rejected
without executing; approving afterwards → `409 proposal-rejected`.

### GET /v1/admin/proposals  (operator+)
`{ proposals, pagination: { limit, offset, total } }`; supports
`?limit=&offset=` (defaults 50/0, max 200). Open proposals past their expiry
read back as `expired`.

### GET /v1/admin/audit  (operator+)
Append-only audit log (SQL triggers forbid UPDATE/DELETE):
`{ entries: [{ id, created_at, actor_role, actor_hash, action, proposal_id,
params, result, request_ip }], pagination }`. Actions: `proposal-created`,
`proposal-approved`, `proposal-rejected`, `proposal-expired`,
`proposal-approve-failed`, `backup-created`.

### POST /v1/admin/backup  (superadmin)
Hot SQLite snapshot (`VACUUM INTO`) into `NEONRELAY_BACKUP_DIR`
(default `var/backups`). Returns `{ file, bytes, sha256, created_at }`.
Off-site copying is an operator step (see `DEVNET_RUNBOOK.md`).

### GET /v1/admin/backups  (operator+)
`{ backups: [{ file, bytes, modified_at }] }` (newest first, capped at 200).

### GET /v1/admin/ledger-stats  (operator+)
`{ db_bytes, tables: { <table>: <rows> } }` for ledger-size monitoring.

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
All intents of the session's wallet binding. Optional `?limit=&offset=`
pagination adds a `pagination: { limit, offset, total }` field.

## On-chain hand-off (stage 9)

The `merkle_proof` + `leaf_hash` + `leaf_index` from a claim intent are what the
Anchor program (`onchain/`, stage 9) verifies against the published epoch root;
confirmation statuses mirror the transaction lifecycle and are recorded for
audit only — double-payment is prevented on-chain by the per-(epoch, wallet)
claim PDA.

## Economy routes (stage 15, docs/PLAY_ECONOMY.md)

All economy routes require a wallet session unless noted; all return
`application/json`. The backend never signs chain transactions.

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /v1/economy/reference?kind=&epoch=&extra=` | session | entry-payment reference (SHA256(kind‖epoch‖extra‖wallet)) for `pay_entry` |
| `GET /v1/economy/ticket?kind=&epoch=&extra=` | session | on-chain EntryTicket status (PDA read over RPC): `{ticketed, kind, amountMicro, paidAt}` |
| `POST /v1/economy/epoch-close` | — (410) | removed: closes run through `POST /v1/admin/proposals {type:"close-economy-epoch"}` + superadmin approval; the pool is derived from vault balance minus reservations over RPC, never from the request |
| `GET /v1/economy/epochs` | public | closed prize epochs (root + total); optional `?limit=&offset=` pagination adds a `pagination` field |
| `GET /v1/economy/current-epoch` | public | current epoch index (`floor(now / epochMs)`) used by entry references |
| `POST /v1/economy/match-intent` `{epoch?}` | session | creates a per-match record, returns `{matchId, epoch, reference}` for `pay_entry` |
| `GET /v1/economy/proof?epoch=&wallet=` | public | place, amount, leaf index and Merkle proof for `claim_prize` (public by design: reveals only the caller's own leaf, already committed in the root; used by the on-device claim flow) |

Configuration: `NEONRELAY_ECONOMY_PROGRAM_ID`, `NEONRELAY_SKR_MINT`
(operator-set, validated, never hardcoded), `NEONRELAY_RPC_URL`
(default devnet). Without the program id the routes answer
`503 economy-not-configured`.
