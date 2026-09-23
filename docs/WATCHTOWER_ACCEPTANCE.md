# Watchtower acceptance snapshot (2026-09-23)

This file records the factual Neon Relay exporter state after adding the
canonical read-only `/watchtower/*` surface and the hub ingestion alias.

## Implemented routes

```text
GET /watchtower/health
GET /watchtower/readyz
GET /watchtower/config
GET /watchtower/events
GET /watchtower/events/:signature
GET /watchtower/metrics/daily
GET /watchtower/players/cohorts
GET /watchtower/players/retention
GET /watchtower/players/cross-game
GET /watchtower/economy
GET /watchtower/treasury
GET /watchtower/security
GET /watchtower/alerts
GET /watchtower/funnels
GET /watchtower/forecast
GET /api/games/neonrelay/ingestion
POST /api/games/neonrelay/ingestion
```

Facts:

- `GET /watchtower/health` returns `writes: false`.
- Every `/watchtower/*` response includes `dataQuality`, `parserVersion`,
  `network`, `stage`, and `lastVerifiedAt`.
- `POST /api/games/neonrelay/ingestion` returns `accepted: true` for a fresh
  single event and `duplicate: true` for a replayed single event.
- `RaceStarted` from the Solana-style envelope maps to `match_start`.
- Local acceptance smoke: `cd backend && npm run watchtower:smoke`
  → `docs/baseline/watchtower-smoke.log` (`RESULT: PASS`).

## Mapping

| Existing route | Canonical / hub-facing surface |
| --- | --- |
| `/api/os/config` | `/watchtower/config` |
| `/api/ingest/solana` | `/watchtower/events` |
| `/api/games/neonrelay/ingestion` | Hub smoke-test alias with booleans |

## Data quality matrix

| Surface | dataQuality | Why |
| --- | --- | --- |
| Health / config | partial | backend facts are present, deployment identity is still operator-supplied |
| Events / metrics / funnels | partial | local SQLite telemetry is queryable, but there is no external production stream in this sandbox |
| Cross-game | unavailable/partial | identity edges exist, studio-wide warehouse does not exist in this repo |
| Treasury | unavailable until snapshots exist | route is implemented, but runtime data depends on operator snapshots |
| Forecast | unavailable | intentionally returns no synthetic forecast |

## Unavailable / blocked outside the repository

| Blocker | Why it remains unavailable here |
| --- | --- |
| Verified RPC-backed program identity | no Solana / Anchor CLI in the sandbox |
| Vendor CLI audit execution (Sentio / SolGuard / SLAM) | tools are not installed/configured here |
| Devnet deploy and key ceremony | no deploy keypair is available in the repository |
| GitHub-hosted CI confirmation | depends on GitHub Actions billing/account state |
