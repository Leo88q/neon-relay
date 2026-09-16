-- Wallet authentication: single-use nonces, wallet bindings, sessions.
-- Rewards tables arrive in migration 0002 (stage 7).

CREATE TABLE wallet_bindings (
  id           TEXT PRIMARY KEY,
  public_key   TEXT NOT NULL UNIQUE,          -- base64url ed25519 account key
  label        TEXT,                          -- wallet-provided display label
  player_id    TEXT,                          -- game player id once linked
  created_at   INTEGER NOT NULL,
  revoked_at   INTEGER                        -- set on unlink; NULL = active
);

CREATE INDEX wallet_bindings_player ON wallet_bindings (player_id);

CREATE TABLE auth_nonces (
  nonce        TEXT PRIMARY KEY,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  consumed_at  INTEGER                        -- NULL until first verification
);

CREATE INDEX auth_nonces_expires ON auth_nonces (expires_at);

CREATE TABLE sessions (
  id                TEXT PRIMARY KEY,
  token_hash        TEXT NOT NULL UNIQUE,     -- sha256(hex) of the bearer token
  wallet_binding_id TEXT NOT NULL REFERENCES wallet_bindings (id),
  created_at        INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL,
  last_seen_at      INTEGER NOT NULL,
  revoked_at        INTEGER
);

CREATE INDEX sessions_binding ON sessions (wallet_binding_id);
CREATE INDEX sessions_expires ON sessions (expires_at);
