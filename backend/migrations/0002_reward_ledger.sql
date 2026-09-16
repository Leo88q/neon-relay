-- Reward ledger: server-signed match events, epochs with Merkle roots,
-- claim intents. Caps are enforced at ingestion from the accepted-event
-- sums in this table (see backend/src/rewards.ts).

CREATE TABLE reward_events (
  id                TEXT PRIMARY KEY,
  idempotency_hash  TEXT NOT NULL UNIQUE,   -- sha256 of the canonical event fields
  match_id          TEXT NOT NULL,
  player_id         TEXT NOT NULL,
  wallet_binding_id TEXT,                   -- NULL until the player links a wallet
  reward_epoch      INTEGER NOT NULL,       -- assigned by the backend at ingestion
  event_type        TEXT NOT NULL,
  amount_micro      INTEGER NOT NULL CHECK (amount_micro >= 0),
  occurred_at       INTEGER NOT NULL,
  ingested_at       INTEGER NOT NULL,
  server_signature  TEXT NOT NULL,          -- base64url ed25519 sig of canonical fields
  status            TEXT NOT NULL,          -- accepted|duplicate|rejected_signature|
                                            -- rejected_caps|rejected_validation
  reason            TEXT
);

CREATE INDEX reward_events_player ON reward_events (player_id, ingested_at);
CREATE INDEX reward_events_binding ON reward_events (wallet_binding_id);
CREATE INDEX reward_events_epoch ON reward_events (reward_epoch, status);
CREATE INDEX reward_events_match ON reward_events (match_id, player_id);

CREATE TABLE reward_epochs (
  id          INTEGER PRIMARY KEY,          -- sequential epoch number
  state       TEXT NOT NULL,               -- open|sealed
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER NOT NULL,
  sealed_at   INTEGER,
  merkle_root TEXT,
  total_micro INTEGER NOT NULL DEFAULT 0,
  leaf_count  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE reward_leaves (
  epoch_id          INTEGER NOT NULL REFERENCES reward_epochs (id),
  wallet_binding_id TEXT NOT NULL,
  public_key        TEXT NOT NULL,          -- base64url account key of the binding
  amount_micro      INTEGER NOT NULL,
  leaf_index        INTEGER NOT NULL,
  leaf_hash         TEXT NOT NULL,          -- hex sha256(pubkey||u64be(amount))
  PRIMARY KEY (epoch_id, wallet_binding_id)
);

CREATE TABLE claim_intents (
  id                TEXT PRIMARY KEY,
  wallet_binding_id TEXT NOT NULL,
  epoch_id          INTEGER NOT NULL,
  amount_micro      INTEGER NOT NULL,
  leaf_hash         TEXT NOT NULL,
  merkle_proof      TEXT NOT NULL,          -- JSON array of hex sibling hashes
  status            TEXT NOT NULL,          -- created|submitted|confirmed|failed|expired
  transaction_id    TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  UNIQUE (wallet_binding_id, epoch_id)
);
