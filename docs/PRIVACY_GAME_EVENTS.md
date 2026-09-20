# Game event privacy (Tranche B)

What the minimal game event log collects, why, how long it lives, and how a
player gets forgotten. This covers the backend `game_events` table and the
JSONL shipper path — Teehistorian/telemetry policy for any future full
packet recording is a separate decision (see §5).

## 1. Data collected

Per event: `session_id`, `event_type` (session_start/end, match_start/end,
disconnect), `player_id`, `match_id`, `mode`, a small `result` object
(`finished`, `place`, durations — ≤ 2 KiB), `occurred_at`, and the
server signature. No chat content, no IP addresses (rate-limit buckets are
in-memory and never persisted with events), no wallet keys, no device ids.

Purpose limitation: session accounting (DAU/sessions/durations), match
outcome rates for the beta metrics (`GET /v1/admin/metrics`), and abuse
investigation (disconnect/anomaly correlation). No advertising, no sale, no
third-party analytics SDKs.

## 2. Retention

- Default rolling retention: **90 days**. Operators SHOULD schedule
  `POST /v1/admin/game-events/purge {older_than_days: 90}` (superadmin,
  audited) on a weekly cron.
- Aggregates (`/v1/admin/metrics` responses) are derived on demand and never
  stored, so purging events truly removes the underlying detail.
- Backups (`POST /v1/admin/backup`) contain whatever events existed at
  snapshot time; backup lifecycle (off-site rotation ≤ 90 days recommended)
  bounds that tail. Document the rotation actually used.

## 3. Deletion requests

`POST /v1/admin/game-events/purge {player_id}` deletes every event row for
one player id (all ages) and writes one audit row. Serve wallet-unlink
deletion requests the same way: resolve the `player_id`(s) linked to the
binding, purge each, and confirm counts from the response.

## 4. Access

Game events are operator-only (`GET /v1/admin/game-events`, role `operator`
or above). There is no player-facing event history API in the beta. Audit
reads are not logged per-row; treat operator access as privileged and staff
accordingly (`docs/INCIDENT_RESPONSE.md` §2).

## 5. Teehistorian / full telemetry: not enabled

The upstream engine ships a tick-level recorder (Teehistorian). Neon Relay does
**not** enable it in the beta: the five lifecycle event types above are the
entire collection. Enabling anything tick-level later requires a privacy
review, a retention figure in this document, and a player-visible notice
before rollout.
