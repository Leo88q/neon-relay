# V2 game identity attestation (part 12)

**Not payment or race admission authorization.** This introduces a separate
short-lived server-verified identity. Existing self-service `/v1/wallet/link`
remains compatible, but is never sufficient to create this verification.

## Operator and server contract

Set `NEONRELAY_GAME_IDENTITY_PUBLIC_KEY` to the canonical base64url raw 32-byte
Ed25519 **public** key of a trusted game identity signer. This is separate from
the match-event signing configuration. No private key is stored in the backend.
Absent/malformed configuration disables the identity routes with HTTP 503.

The game-server signing component is **not implemented here**. Before signing,
it MUST authenticate a stable, server-controlled player identity and require
it to equal the challenge's `player_id`. A nickname, client-supplied id or an
endpoint that blindly signs arbitrary challenges is not sufficient. The server
must also check the allowlisted domain, exact purpose/version, intended wallet
binding, expiry, and the user's explicit link request. Do not reuse the wallet
login challenge or sign this challenge using a wallet key.

## HTTP protocol

All three routes require the existing wallet-authenticated bearer session and
have IP rate limits:

1. `POST /v2/identity/challenge` with `{ "player_id": "server-player-id" }`.
   Returns `nonce`, `challenge` (base64url UTF-8 JSON bytes) and `expires_at`.
2. The trusted game server validates the request and signs the **exact decoded
   challenge bytes**, without JSON reserialization. The fixed payload includes
   version 1, purpose `neonrelay-game-identity`, domain, random nonce, public
   session UUID, wallet binding UUID, wallet key, player id, expected signer,
   issue time and expiry. It contains no bearer token or session-token hash.
3. `POST /v2/identity/verify` with `nonce` and base64url Ed25519 `signature`.
   The backend verifies its own stored bytes, not a client-supplied payload.
4. `GET /v2/identity` returns `verified`, `player_id`, `verified_until` and
   `admissionEnabled:false`.

Challenges expire after 120 seconds. Issuing a new challenge replaces the
session's pending one. Verification consumes the nonce and establishes a
five-minute grant for that exact session/wallet in one SQLite IMMEDIATE
transaction. Retries of a consumed challenge fail; invalid signatures do not
consume it. There is at most one pending challenge per session by SQL index.
Expired challenge records are purged after a day during issuance.

Successful verification updates the legacy player link for compatibility. A
SQL trigger invalidates all old grants and pending challenges for that wallet
when player id, wallet key or revocation changes—even a self-link to the same
id. Switching away and back cannot resurrect a grant. Other sessions for the
same wallet must attest separately. Session/binding revocation, grant expiry,
and a different configured signer/domain fail closed. Grants do not slide with
session expiry. Reusing an old signer/domain configuration can make a still-live
grant match again; emergency revocation should delete grants and pending
challenges as well as rotate the key.

## Remaining integration

No public payment/intent-creation route or race admission was enabled. The
read-only ticket inspection route remains unchanged. Future paid flows must
require this live attestation **plus** operator-approved tournament policy,
verified mint/fees, capacity reservation, payment verification and one-use game
admission. This mechanism does not establish NFT ownership, ranking eligibility
or uniqueness of a human; the trusted game identity issuer is responsible for
stable player ids. Existing legacy reward-link semantics are not retroactively
secured by these new routes.

Tests exercise real Ed25519 signatures and authenticated HTTP sessions, including
wrong wallet/signer, changed payload fields, session mismatch, replay, expiry,
self-link revocation, signer/domain changes, missing configuration and rate limits.
