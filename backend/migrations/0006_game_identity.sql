-- Separate from self-declared v1 player links. No payment/admission authority.
CREATE TABLE game_identity_challenges (
  nonce TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  binding_id TEXT NOT NULL REFERENCES wallet_bindings(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL,
  wallet TEXT NOT NULL,
  signer TEXT NOT NULL,
  domain TEXT NOT NULL,
  payload TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
) STRICT;
CREATE INDEX game_identity_challenge_expiry ON game_identity_challenges(expires_at);
CREATE UNIQUE INDEX game_identity_pending_session ON game_identity_challenges(session_id) WHERE consumed_at IS NULL;
CREATE TABLE game_identity_grants (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  binding_id TEXT NOT NULL REFERENCES wallet_bindings(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL,
  wallet TEXT NOT NULL,
  signer TEXT NOT NULL,
  domain TEXT NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;
-- Even a self-link to the same id invalidates server verification and pending
-- challenges. Changing back to an old id must never resurrect an old grant.
CREATE TRIGGER invalidate_game_identity AFTER UPDATE OF player_id, revoked_at, public_key ON wallet_bindings
BEGIN
  DELETE FROM game_identity_grants WHERE binding_id = NEW.id;
  DELETE FROM game_identity_challenges WHERE binding_id = NEW.id AND consumed_at IS NULL;
END;
