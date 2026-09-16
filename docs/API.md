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

## Stage 7 preview (not implemented yet)

`POST /v1/rewards/claim-intent`, `GET /v1/rewards/balance`,
`GET /v1/rewards/eligibility`, `GET /v1/rewards/epochs`,
`POST /v1/rewards/claim-confirmation` — see [`REWARD_SECURITY.md`](REWARD_SECURITY.md)
for the ledger contract they will expose.
