# neonrelay-backend

Reward backend for Neon Relay: wallet authentication (stage 6) and, from stage 7,
the reward ledger. **Zero runtime dependencies** — Node 22 built-ins only
(`node:http`, `node:crypto`, `node:sqlite`), TypeScript run through Node's
type-stripping (`--experimental-strip-types`), so there is no build step and no
`node_modules` to audit.

## Stack choice (documented per spec)

TypeScript on Node 22 was chosen because:

* the spec mandates TypeScript and Node 22;
* `node:sqlite` (Node ≥ 22) gives a real, transactional store with no native
  build toolchain — important because the CI sandbox cannot compile bindings;
* Ed25519 verification is in `node:crypto`, so wallet auth needs no crypto
  dependency;
* type-stripping keeps the deploy artifact identical to the source (no transpile
  drift), and `tsconfig.json` (`erasableSyntaxOnly`, `strict`) keeps the subset
  of TypeScript we use compatible with it — notably **no parameter properties,
  no enums**.

## Layout

```
backend/
├── migrations/0001_wallet_auth.sql   nonces, wallet bindings, sessions
├── scripts/migrate.ts                apply pending migrations
├── src/
│   ├── config.ts                     env-only configuration
│   ├── db.ts                         node:sqlite wrapper + forward-only migrations
│   ├── crypto.ts                     ed25519, canonical challenge (de)serialization
│   ├── wallets.ts                    nonce + binding repository
│   ├── sessions.ts                   bearer tokens (hash-only, sliding TTL)
│   ├── auth.ts                       challenge issue / verify service
│   ├── http.ts                       router, JSON helpers, rate limiter
│   ├── routes.ts                     /v1 route table
│   └── server.ts                     createApp()/main()
└── test/                             node:test suites (20 cases)
```

## Commands

```sh
npm run migrate     # apply migrations to $NEONRELAY_DB (default var/neonrelay.db)
npm start           # serve on $PORT (default 8787)
npm test            # node --test over test/**/*.test.ts
```

Environment: `PORT`, `NEONRELAY_DB`, `NEONRELAY_AUTH_DOMAIN`,
`NEONRELAY_CHALLENGE_TTL_MS`, `NEONRELAY_SESSION_TTL_MS`. See
[`docs/WALLET_AUTH.md`](../docs/WALLET_AUTH.md) for the protocol and threat
model, [`docs/API.md`](../docs/API.md) for the HTTP contract.

## Security posture

* no private keys, seed phrases or treasury credentials anywhere in this tree;
* session tokens stored as SHA-256 hashes, compared in constant time;
* nonces single-use; challenges domain-bound and short-lived;
* parameterized SQL only; per-IP token bucket on the auth routes;
* reward routes (stage 7) will reference `wallet_binding_id`, never raw keys.

## Test evidence

`npm test` → **20/20 passing** (Node v22.22.3, this repository, commit that
introduced stage 6): crypto round-trips, nonce replay/expiry, session
sliding/revocation, and the full HTTP flow including replay (409), cross-domain
(422), expiry (410), bad signature (401) and canonical-form tamper (400).
