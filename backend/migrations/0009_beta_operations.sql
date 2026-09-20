-- Tranche B: minimal game event log, on-chain reconciliation snapshots and
-- treasury balance history. Snapshots are append-only telemetry; game events
-- are server-signed and idempotent like reward events, with operator-driven
-- retention purges (see docs/PRIVACY_GAME_EVENTS.md).

CREATE TABLE game_events (
  id               TEXT PRIMARY KEY,            -- crypto.randomUUID()
  idempotency_hash TEXT NOT NULL UNIQUE,        -- sha256 of the canonical event fields
  session_id       TEXT,                         -- game session uuid (NULL only if type allows)
  event_type       TEXT NOT NULL,               -- session_start|session_end|match_start|match_end|disconnect
  player_id        TEXT,
  match_id         TEXT,
  mode             TEXT,                         -- race|dm|... (match events)
  result           TEXT,                         -- JSON match/session outcome (<= 2kb)
  occurred_at      INTEGER NOT NULL,
  ingested_at      INTEGER NOT NULL,
  server_signature TEXT NOT NULL,               -- base64url ed25519 sig of canonical fields
  status           TEXT NOT NULL,               -- accepted|duplicate|rejected_signature|rejected_validation
  reason           TEXT
) STRICT;

CREATE INDEX game_events_type ON game_events (event_type, occurred_at);
CREATE INDEX game_events_player ON game_events (player_id, occurred_at);
CREATE INDEX game_events_session ON game_events (session_id);

-- kind: rewards-epoch | prize-epoch | treasury. ref: epoch id or program id.
-- backend/onchain hold the compared JSON payloads (roots, totals, balances).
CREATE TABLE reconcile_snapshots (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  ref        TEXT NOT NULL,
  status     TEXT NOT NULL,                     -- match | mismatch:<fields> | missing-onchain | missing-backend | error:<code>
  backend    TEXT,
  onchain    TEXT,
  details    TEXT
) STRICT;

CREATE INDEX reconcile_lookup ON reconcile_snapshots (kind, ref, created_at);

CREATE TRIGGER reconcile_no_update BEFORE UPDATE ON reconcile_snapshots
BEGIN
  SELECT RAISE(ABORT, 'reconciliation log is append-only');
END;

CREATE TRIGGER reconcile_no_delete BEFORE DELETE ON reconcile_snapshots
BEGIN
  SELECT RAISE(ABORT, 'reconciliation log is append-only');
END;

-- Vault/treasury balance history (u64 as canonical decimal TEXT, keys base58).
-- Movements are derived from consecutive snapshots, never asserted in one row.
CREATE TABLE treasury_snapshots (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at       INTEGER NOT NULL,
  program          TEXT NOT NULL,               -- economy program id (base58)
  mint             TEXT NOT NULL,               -- payment mint (base58)
  vault            TEXT NOT NULL,
  treasury         TEXT NOT NULL,
  vault_balance    TEXT NOT NULL,
  treasury_balance TEXT NOT NULL,
  reserved         TEXT NOT NULL
) STRICT;

CREATE INDEX treasury_history ON treasury_snapshots (program, mint, created_at);

CREATE TRIGGER treasury_no_update BEFORE UPDATE ON treasury_snapshots
BEGIN
  SELECT RAISE(ABORT, 'treasury history is append-only');
END;

CREATE TRIGGER treasury_no_delete BEFORE DELETE ON treasury_snapshots
BEGIN
  SELECT RAISE(ABORT, 'treasury history is append-only');
END;
