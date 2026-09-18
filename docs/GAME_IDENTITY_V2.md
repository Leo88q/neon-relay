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

## Part 13: guarded C++ signing boundary

`src/neonrelay/game_identity.{h,cpp}` adds a guarded identity signing function
using the existing Ed25519 primitive. It is linked into the game-server source
list, but intentionally has **no network, chat, console or finish-event hook**.

The caller must supply `AuthenticatedGameIdentity` from a trusted account
adapter: allowlisted domain, stable player id, verified wallet, backend session
and binding UUIDs, nonexpired authentication, and explicit link consent. This
struct is a server-internal trust boundary, NOT a DTO to deserialize from a
client. Setting its fields is not itself proof of identity. The production
adapter that authenticates these facts is still missing.

The signer reconstructs the exact canonical challenge using that context and
its own public key, compares it byte-for-byte with the supplied backend JSON,
and only then signs. It rejects changed fields, noncanonical nonce/key encoding,
malformed UUIDs, wrong purpose/signer/domain, missing consent, expired or future
challenge times, lifetime over two minutes, stale authentication and oversized
input. No JSON parsing ambiguity or duplicate fields can survive exact equality.
Replay consumption remains the backend's responsibility.

The existing legacy finish-event path uses `ClientName` as its player identifier.
It was deliberately NOT reused as a trusted identity provider. Nicknames, client
slots and IP addresses must not become authoritative player ids for paid flows.
Legacy event semantics are unchanged and are not secured by this adapter.

`neonrelay_signer_test.sh` now compiles the C++ adapter and a test-only harness,
issues a real backend challenge through wallet-authenticated HTTP, passes a
fixture trusted context to C++, and redeems its signature through the backend.
It checks 16 altered-context/payload rejection cases, Unicode/quote byte parity,
no-admission flags and replay rejection. The harness is not a deployed tool.

This validates the C++/backend signing boundary, not native account login,
wallet-session transport, server integration, game admission or a release build.

## Part 14: operator account registry and one-use connection pairing

This stage tightens the earlier identity routes: challenge issuance,
verification and status now require an **enabled registry entry matching both
wallet and player id**. A trusted signature alone no longer creates verification
for an unregistered player. No existing self-declared links are auto-imported.

Provision locally as an operator (public wallet key only):

```sh
NEONRELAY_DB=/path/to/backend.db node --experimental-strip-types \
  backend/scripts/register_game_account.ts stable-account-id WALLET_BASE64URL
```

The operator must establish actual account ownership out of band before
provisioning. The command does not itself establish that ownership. CLI ids are
stable ASCII identifiers, not nicknames. One wallet maps to one player and vice
versa. SQL prevents reassignment, deletion and INSERT OR REPLACE; disable an
account with an operator DB update of `game_accounts.enabled` instead. Wallet
rotation/recovery is intentionally not implemented. Enabling/disabling removes
pending pairings/challenges and existing identity grants.

Pairing protocol (backend implementation only):

1. The game server generates a fresh cryptographically random 32-byte nonce for
   a specific live connection and presents it to the wallet-authenticated client.
2. `POST /v2/game/pair`, with wallet bearer session, body
   `{ "connection_nonce": "64 lowercase hex characters", "consent": true }`.
   The backend derives the player from the registry, ignoring `player_id` from
   `/v1/wallet/link`. Returns a random `pairing_token`, player id and expiry.
3. Deliver that token to the intended game connection using an authenticated,
   confidential channel. Treat it as a short-lived secret, not a chat message.
   The server must check its own connection nonce, not accept an arbitrary
   client-supplied nonce as proof of connection ownership.
4. The server signs exact UTF-8 compact JSON, in this order:
   `{ "v":1, "purpose":"neonrelay-game-pairing", "domain":DOMAIN,
   "token_hash":SHA256_HEX(TOKEN_ASCII), "connection_nonce":NONCE }`.
   Whitespace shown here is explanatory; `pairingProofBytes()` defines bytes.
5. `POST /v2/game/redeem`, with `pairing_token`, `connection_nonce`, and the
   canonical base64url Ed25519 `signature`. It requires the configured server
   signing key, not a wallet session. Pairings expire within two minutes (or at
   session expiry), are consumed atomically, and cannot be redeemed twice.
6. The response supplies server-side context: domain, registry player id, wallet,
   session/binding UUIDs, connection nonce, authentication expiry and explicit
   consent. No bearer token or session-token hash is returned. The server must
   authenticate the backend HTTPS endpoint and match nonce to the original live
   connection before constructing `AuthenticatedGameIdentity`.

Only the pairing token's SHA-256 hash is stored. New issuance invalidates the
session's old pending token. Relink/unlink, account disable, session revocation,
expiry, different signer/domain or connection nonce prevent redemption. A
returned context is a short lease, not an instantly revocable server login;
the server must discard it on disconnect/expiry and re-pair on reconnect.
Identity verification still rechecks registry/session validity, and future
admission must do the same. Rate limits apply to both pairing routes.

The native game connection transport, pairing-proof signing call, backend TLS
client and context lifecycle adapter remain **unimplemented**. There is no
public signing endpoint and no claim that a live game connection is now
wallet-authenticated. This stage supplies the registry and server-authenticated
backend protocol that the adapter will consume. No paid admission is enabled.
