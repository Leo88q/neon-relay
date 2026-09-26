# Wallet authentication (challenge / verify)

How a Solana wallet proves control of an account to the Neon Relay reward backend,
and how the backend turns that proof into a scoped session. Implementation:
[`backend/src/auth.ts`](../backend/src/auth.ts) and friends; Android side:
[`ANDROID_SEEKER.md`](ANDROID_SEEKER.md); HTTP contract: [`API.md`](API.md).

## 1. Goals and non-goals

Goals:

* prove that the client controls a wallet account **without the backend ever
  receiving key material**;
* bind rewards to a stable identifier (`wallet_binding_id`) that survives wallet
  app upgrades and device changes;
* make every artifact of the flow single-use, short-lived and domain-bound.

Non-goals: this is *authentication*, not authorization for on-chain funds. The
backend cannot move funds, cannot sign transactions, and never asks the wallet
for anything beyond a signature over our challenge.

## 2. Protocol

### 2.1 Challenge

`POST /v1/auth/challenge` returns

```json
{ "challenge": "<base64url bytes>", "nonce": "<base64url>", "expires_at": 1730000000000 }
```

The challenge bytes are the UTF-8 encoding of this canonical JSON (fixed key
order, no insignificant whitespace):

```json
{"v":1,"purpose":"neonrelay-wallet-auth","domain":"neonrelay.leo88q.example",
 "nonce":"…","issued_at":1730000000000,"expires_at":1730000120000}
```

* `nonce` — 192-bit random, stored server-side, **single use**, TTL 120 s
  (`NEONRELAY_CHALLENGE_TTL_MS`);
* `domain` — the value of `NEONRELAY_AUTH_DOMAIN`; wallets display it, and the
  backend rejects challenges carrying any other domain (phishing guard);
* `purpose` — prevents cross-protocol signature reuse (a Neon Relay auth
  signature is not a valid transaction or message signature elsewhere).

### 2.2 Signing (client side)

The Android layer asks the wallet, via Mobile Wallet Adapter `signMessages`, to
sign **exactly those bytes**. Signing happens inside the wallet app; the client
receives only the 64-byte Ed25519 signature. See `WalletManager.signChallenge`.

### 2.3 Verification

`POST /v1/auth/verify-wallet` with `{challenge, signature, public_key, account_label?}`.
Checks, in order (first failure wins):

| # | Check | Failure → status |
| --- | --- | --- |
| 1 | base64url decodes, sizes sane | `bad-request` 400 |
| 2 | JSON parses; `v=1`; `purpose` matches | `bad-challenge` 400 |
| 3 | bytes equal the canonical re-serialization (no malleability) | `bad-challenge` 400 |
| 4 | `domain` equals our configured domain | `wrong-domain` 422 |
| 5 | `now <= expires_at` | `challenge-expired` 410 |
| 6 | nonce exists, unconsumed, unexpired — then atomically consumed | `nonce-unknown` 404 / `nonce-replayed` 409 / `challenge-expired` 410 |
| 7 | `public_key` is a 32-byte Ed25519 key | `bad-public-key` 400 |
| 8 | Ed25519 signature verifies over the canonical bytes | `bad-signature` 401 |
| 9 | binding not revoked | `binding-revoked` 403 |

On success the backend upserts the **wallet binding** (unique per public key)
and issues a session.

### 2.4 Sessions

* token: 256-bit random, base64url, returned **once**;
* stored as SHA-256 hex only; compared in constant time;
* TTL 12 h (`NEONRELAY_SESSION_TTL_MS`), slid on each authenticated request;
* `Bearer` scheme; revocation is explicit (`/v1/wallet/unlink` revokes the
  binding *and* all its sessions) or per-session.

### 2.5 Bindings and player links

`wallet_bindings(public_key UNIQUE, label, player_id, revoked_at)` is the stable
reward identity. `/v1/wallet/link` attaches a game `player_id` (stage 7 rewards
reference the binding, never the raw key); `/v1/wallet/unlink` revokes the link
and the binding in one atomic statement. A later successful verification
*revives* a revoked binding under the same id, so historic rewards stay
attributable while the revocation window blocks use.

**Player-id authority (SW-2026-09-26 F-11):** in production a link is only
accepted when the operator has provisioned the `(player_id, wallet)` pair in
`game_accounts` — reward events resolve to the newest *active* binding of the
event's `player_id`, so a self-declared link would redirect sealed reward
leaves to whoever claims the id first. Staging/devnet can enforce the same
rule early with `NEONRELAY_REQUIRE_REGISTERED_PLAYER_LINK=1`; local tests run
without it. The trusted alternative path is the server-attested flow
(`POST /v2/identity/challenge|verify`), which checks `game_accounts` before it
ever writes `player_id`.

## 3. Threat model

| Threat | Mitigation |
| --- | --- |
| challenge replay | nonce single-use (atomic consume) + 120 s expiry; replay → 409 |
| signature replay across sessions | each verification issues a fresh session token; the signature itself is not a credential |
| phishing / evil dapp tricking a user into signing our challenge for another service | `domain` + `purpose` are signed; wallets show the domain; cross-domain challenges → 422 |
| signing something harmful | the payload is a plain JSON statement, not a transaction; MWA `signMessages` shows it in the wallet |
| session token theft | TLS in deployment, 12 h sliding TTL, hash-only storage, revocation on unlink; tokens are never logged |
| backend compromise leaks keys | impossible by construction: no private key, seed phrase or treasury key is ever present; only public keys, hashes and metadata |
| brute force / DoS on verify | per-IP token bucket (10 burst, 5/min) on challenge+verify; Ed25519 verification is cheap and constant-work |
| challenge spam growing `auth_nonces` | expired nonces purged at expiry and live challenges hard-capped (`authNonceCap`, default 50k → `429 challenge-cap`) — SW-2026-09-26 F-16 |
| player-id squatting redirecting rewards | production links require an operator-provisioned `game_accounts(player_id, wallet)` pair — SW-2026-09-26 F-11 (see §2.5) |
| SQL injection | parameterized statements only (node:sqlite prepared statements) |
| JSON malleability | canonical re-serialization check before any crypto |
| rate-limit bypass at scale | limiter is in-process by design; horizontal scale-out must enforce it at the edge (documented deployment requirement) |

## 4. Key handling rules (repeated for emphasis)

1. The backend **verifies** Ed25519 signatures; it never generates or stores a
   wallet private key.
2. No seed phrase, signer file, treasury key or mainnet credential appears in
   source, tests, CI variables or logs.
3. The reward mint is configured per environment; devnet uses a throwaway test
   mint labelled not-official; no mainnet mint is hardcoded (stage 9).

## 5. Operations

* configuration: `PORT`, `NEONRELAY_DB`, `NEONRELAY_AUTH_DOMAIN`,
  `NEONRELAY_CHALLENGE_TTL_MS`, `NEONRELAY_SESSION_TTL_MS`;
* migrations: `backend/migrations/*.sql`, forward-only, `npm run migrate`;
* tests: `npm test` — 20 cases covering crypto, nonces, sessions and the full
  HTTP flow including replay, cross-domain, expiry and tamper paths;
* the API is stateless per request apart from SQLite; deploy behind TLS with the
  edge rate limiter mentioned above.
