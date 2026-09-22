# neonrelay-backend

Reward backend for Neon Relay: wallet authentication (stage 6) and the
server-authoritative reward ledger (stage 7). **Zero runtime dependencies** — Node 22 built-ins only
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

## Watchtower OS v3

The v3 integration contract is documented in [`../WATCHTOWER_INTEGRATION.md`](../WATCHTOWER_INTEGRATION.md).
The dependency-free API exposes the requested verification surfaces:

* `GET /api/os/config` — tenant `neonrelay`, game id, program references and exactly 33 deduplicated components;
* `GET /api/l2/router?gameId=neonrelay&tps=high&ux=gasless` — HyperGrid routing with Arcium, PST, Xandeum, Sorada and MagicBlock ER contracts;
* `GET /api/sdk/<name>?gameId=neonrelay` — adapter contracts for Godot, Gamba, Preset, RitArena, Xandeum, PST, Core Attributes, Access Protocol, idosgames, security tooling and Arcium;
* `GET /api/game-signals/config?gameId=neonrelay` — attribution/ML contract with human-reviewed campaign proposals;
* `GET` or `POST /api/ingest/solana` — bounded, idempotent session telemetry with `solana_wallet` late ID binding.

These routes report adapter boundaries, not provisioned credentials or third-party SLAs. The Godot 4 sample is in `../integrations/godot/`; wallet and session-key providers are deliberately stubs until the operator installs the real SDKs.

## Test evidence

`npm test` runs the full Node v22 suite, including Watchtower v3 route, 33-component, high-frequency router, telemetry idempotency and late-binding checks. The older authentication, reward, economy, admin, RPC and reconciliation suites remain covered as well.
