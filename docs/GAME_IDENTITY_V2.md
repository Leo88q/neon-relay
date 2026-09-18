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

## Part 15: native connection lifecycle (no HTTP transport yet)

`GameConnectionIdentity` in `src/neonrelay/game_connection.h` owns an ephemeral
nonce, pending-request serial and optional leased identity. `CGameContext` now
creates a fresh instance using `secure_random_fill` on connection, disconnects
and releases it on drop, and disconnects all instances on destruction/map reset.
No identity is loaded from persistent client state or a nickname.

A valid `Begin` clears the previous identity and supersedes the pending attempt.
`Complete` requires the original nonce/serial, matching backend echo/domain,
valid consent/context fields, a live request deadline and a context expiry no
later than that deadline. A matching completion is terminal even when rejected.
Stale successes/failures cannot alter a newer pending request. Expiry and clock
rollback clear authentication; disconnect is terminal for that instance.

The future HTTP adapter MUST validate the backend TLS endpoint and response
schema before calling `Complete`, and marshal completion to the game thread.
It must capture a weak pointer to the original instance plus the request token,
not look up a client slot when a response arrives. A reused slot gets a different
instance and nonce. Even a retained old instance rejects operations after drop.
The lifecycle class is not thread-safe and does not authenticate arbitrary
context structs by itself. Its guarded signing method checks freshness on use.

The compiled harness checks stale/reordered/duplicate replies, old failure
callbacks, re-pairing, domain/context substitutions, request timeout, exact
expiry, clock rollback, disconnect and client-slot reuse. The full syntax gate
checks the modified game-context translation unit. These are not live gameplay
or full native-link tests.

No pairing packets, chat/RCON endpoint, nonce display, HTTPS client or backend
response adapter is connected yet. Thus this stage wires lifetime/reset hooks
into the native server, but still does not authenticate a live game connection
or enable any payment/admission flow.

## Part 16: bounded native HTTPS transport adapter

`GamePairingHttp` now builds the server's canonical pairing proof, submits a
JSON POST using the engine HTTP queue, and exposes game-thread `Poll()` to apply
a completed response to a weak handle of the original connection. It has a
128-request cap, ten-second deadline, 4096-byte reply limit, no retry of a
consumed token, and cancellation on adapter destruction. Responses require HTTP
200, a nine-field object with unique required keys, exact types, explicit consent,
`admissionEnabled:false`, valid public identifiers and a live authentication
expiry. The connection state separately checks nonce/domain/request generation.

The operator origin accepts only `https://host[:port]`, without userinfo, paths,
queries, fragments or whitespace. The path is fixed to `/v2/game/redeem`.
Credentials cannot be placed in the URL. A new engine `Sensitive()` request
policy overrides global insecure/debug options for this native request: HTTPS
only, peer/hostname verification, no redirect following, no curl wire-debug or
request progress/error logging. Emscripten refuses sensitive requests because
that backend does not implement the same no-redirect policy. Other requests keep
their existing defaults. This is not a general engine HTTP behavior change.

Compiled protocol tests now sign a real pairing request in C++, redeem it through
the backend HTTP route and parse the actual reply in C++. They also reject
incompatible/duplicate/oversized JSON, stale identity fields and unsafe origins.
The signer gate syntax-checks the adapter; CI additionally installs curl headers
and syntax-checks native engine HTTP code. The tests do **not** yet run the native
HTTP worker over a real TLS connection, simulate TLS/redirect failures, or link
and playtest the full game server. Do not infer those guarantees from protocol
parity or source compilation.

The adapter is in the server source list, but is not instantiated by a game
packet handler: operator key/origin configuration, confidential client token
transport, main-loop polling and integration tests still need wiring. Public
payments/admission remain disabled. Calls to Start/Poll and destruction belong
on the game thread; no callbacks are installed on the HTTP worker thread.

## Part 17: real native HTTP/TLS execution (verified in CI)

`scripts/test_native_https.sh` builds a focused executable from the **real**
engine `http.cpp`, curl worker, base implementations and pairing adapter. No
HTTP, TLS, clock or response-processing implementation is replaced with stubs.
The Python runner generates short-lived test certificates, starts loopback
HTTP/HTTPS servers, temporarily installs a generated CA in the disposable CI
runner trust store, and removes it and its private key material afterward.
Run this test only in an isolated Linux test environment with curl development
headers, OpenSSL CLI and passwordless sudo—not on an operator workstation.

Verified at `e3ccca8` in CI run:
https://github.com/Leo88q/neon-relay/actions/runs/35342502366

Executed checks:

- Valid HTTPS under the temporary trusted CA succeeds.
- An untrusted self-signed certificate and a trusted-CA certificate with the
  wrong hostname both fail before an HTTP request reaches those endpoints.
- 307 redirects, including redirects to plain HTTP, are not followed; the
  redirect target receives no request.
- Direct HTTP is refused for sensitive requests even when the global insecure
  option is enabled. A nonsensitive HTTP control still succeeds.
- A streaming body without Content-Length exceeding 4096 bytes is rejected.
- A slow response hits an actual native worker request timeout.
- With global debug enabled, a sensitive test header is absent from captured
  logs; the ordinary-request control header is present.
- The actual `GamePairingHttp` queue/Poll/parser path accepts a schema-valid
  local TLS response and establishes the connection's leased identity. Drop
  while a subsequent request is pending leaves the connection unauthenticated.

The local TLS server deliberately **simulates backend responses**. It does not
perform account registry/signature verification; those are covered separately
by the C++/real-backend HTTP protocol tests from parts 13–16. This is not yet a
single end-to-end test from a real game packet through the production backend,
a full native game build/playtest, or proof that operator deployment TLS is
configured correctly. No client packet handler, live wallet login or payment
admission was enabled.

Local offline gates passed (backend 94/94, onchain TS 32/32, compiled protocol and
connection tests). The native TLS executable itself ran in GitHub CI: the local
sandbox lacked curl development headers and its apt package mirror was
unreachable. This is recorded separately, not represented as local TLS success.

## Part 18: native TLS worker against the real backend (verified)

The TLS harness now also runs `scripts/test_native_backend_https.ts`. It creates
an in-memory instance of the **production backend app** and forwards a loopback
HTTPS server's request events to the app's actual dispatcher. Registry, wallet
challenge/session authentication, pairing signature/replay checks and identity
verification are not replaced or reimplemented.

The focused native executable's `--backend` mode generates a fresh connection
nonce with `secure_random_fill`, receives a pairing token over private test IPC,
and redeems it through the real engine curl worker. `GamePairingHttp::Poll`
installs only the backend-returned context. The connection then signs the real
backend identity challenge, which the backend accepts as a verified identity
for the operator-provisioned account. This tests more than manually constructing
a trusted context on the C++ side.

The test additionally verifies:

- Reusing the consumed token fails and clears native identity on failed refresh.
- A token issued for another connection nonce does not authenticate the native
  connection, even though its server request has a valid signature.
- Disabling the registered account between issue and redemption rejects it.
- The wallet bearer and pairing token are absent from native stdout/stderr.
- `admissionEnabled` remains false after successful identity verification.

Verified source revision `f3de11b`, GitHub CI run:
https://github.com/Leo88q/neon-relay/actions/runs/35344279857
The existing adversarial TLS tests and all ordinary CI jobs also passed. Local
offline gates passed with backend 94/94 and onchain TS 32/32; native TLS execution
was verified in CI, not in the local sandbox without curl development headers.

**Remaining trust/transport gap:** the harness uses private subprocess stdin
for wallet-to-game token delivery. This is explicitly not a game packet protocol
or a deployed client channel. Sending bearer-like pairing tokens through chat,
RCON logs or ordinary unencrypted game UDP is not an acceptable replacement.
A confidential authenticated client channel and actual game message/main-loop
wiring still need implementation and playtesting. This result also does not
validate production backend TLS termination or operator key provisioning. No
live wallet login, public payment or paid race admission was enabled.

## Part 19: confidential pairing envelope (verified interoperability)

`POST /v2/game/pair-sealed` accepts an authenticated wallet session, explicit
consent, an exact `offer` JSON string and its canonical base64url Ed25519
`signature`. The configured game identity signer must sign these ordered fields:

```
v = 1
purpose = neonrelay-game-pairing-seal
domain = configured backend domain
connection_nonce = lowercase 32-byte hex
server_ephemeral_key = lowercase raw X25519 public key hex
issued_at = integer Unix milliseconds
expires_at = integer Unix milliseconds, at most issued_at + 120000
```

The backend requires canonical compact JSON (no extra/duplicate fields), matching
domain/purpose, current time and a valid trusted-server signature. It validates
X25519 key agreement before creating the ordinary hashed one-use pairing row;
invalid/low-order keys fail closed. Registry/session/consent rules still apply.
The token expiry is capped by both offer expiry and session expiry.

Envelope construction uses Node/OpenSSL primitives:

- Fresh sender X25519 key; shared secret with the offer's ephemeral server key.
- HKDF-SHA256, salt = SHA256(exact offer UTF-8 bytes), info = ASCII
  `neonrelay:game-pairing-seal:v1`, 32-byte output.
- AES-256-GCM, random 12-byte IV, exact offer bytes as AAD, 16-byte tag.
- Plaintext = 43-byte ASCII pairing token, never present in this HTTP response.
- Response: version 1, `sender_key` (32-byte hex), `iv` (12-byte hex),
  `ciphertext` (43-byte hex), `tag` (16-byte hex), expiry and disabled-admission
  flag. Metadata flags are not authorization and must never enable admission.

`GamePairingSeal` owns an opaque ephemeral OpenSSL key. Successful decryption
frees it; replay fails. Expiry, time before issuance or excess attempts discard
the key. Temporary shared/AES key buffers and decrypted temporary storage are
cleansed. The resulting token exists transiently in memory for the HTTPS redeem
request; this is not a claim that all language/runtime heap copies are wiped.
Without OpenSSL the class returns failure, never plaintext fallback. A future
connection adapter must own/destroy the seal alongside its original connection.

The actual-backend/native TLS harness now includes a sealed case. C++ generates
and signs the offer; the wallet-authenticated backend encrypts a real token;
only ciphertext fields cross test stdin; C++ decrypts and redeems through the
real native HTTP worker, then signs and verifies an identity challenge. Native
checks reject altered tag, all-zero peer, another connection's ephemeral key and
repeat opening. Backend tests additionally cover AAD tampering, untrusted signer,
wrong domain/purpose, expiry, extra fields, missing consent and disabled registry.

Verified at `6065e74`:
https://github.com/Leo88q/neon-relay/actions/runs/35347448666
Local offline gates: backend 97/97, onchain TS 32/32 and prior checks. OpenSSL/TLS
native execution remains CI-verified rather than local-sandbox execution.

### Security scope before packet integration

This is a confidentiality envelope, **not a complete authenticated game channel**
and not an audited general-purpose protocol. AEAD verifies the derived key/AAD;
X25519 encryption alone does not prove that the sender is the backend. Actual
acceptance still requires HTTPS redemption of a valid live backend token. Anyone
knowing a public offer can encrypt junk and cause denial of service; attempts
must be rate-limited before a packet handler is enabled. Swapping/relaying whole
valid offers across client connections requires a separate binding/confirmation
and active-attacker review; this change does not establish protection against
that or hijacking subsequent unencrypted game traffic.

No envelope packet parser/handler or client UI is enabled. Do not send plaintext
from the older `/v2/game/pair` route over UDP. This stage removes the plaintext
secret from the test's sealed delivery path, not the remaining game transport,
endpoint-authentication, relay, lifecycle and playtest release gates. Payments
and paid admission remain disabled.
