-- Operator-provisioned identity root, never inferred from self-declared links.
CREATE TABLE game_accounts (
  player_id TEXT PRIMARY KEY,
  wallet TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1))
) STRICT;
CREATE TRIGGER game_account_identity_immutable BEFORE UPDATE OF player_id, wallet ON game_accounts
BEGIN SELECT RAISE(ABORT, 'game account identity is immutable'); END;
CREATE TRIGGER game_account_no_replace BEFORE INSERT ON game_accounts
WHEN EXISTS(SELECT 1 FROM game_accounts WHERE player_id=NEW.player_id OR wallet=NEW.wallet)
BEGIN SELECT RAISE(ABORT, 'game account already registered'); END;
CREATE TRIGGER game_account_no_delete BEFORE DELETE ON game_accounts
BEGIN SELECT RAISE(ABORT, 'disable game accounts rather than deleting identity'); END;
CREATE TABLE game_pairings (
  token_hash TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  binding_id TEXT NOT NULL REFERENCES wallet_bindings(id),
  player_id TEXT NOT NULL REFERENCES game_accounts(player_id),
  wallet TEXT NOT NULL,
  signer TEXT NOT NULL,
  domain TEXT NOT NULL,
  connection_nonce TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
) STRICT;
CREATE UNIQUE INDEX game_pairing_pending_session ON game_pairings(session_id) WHERE consumed_at IS NULL;
CREATE INDEX game_pairing_expiry ON game_pairings(expires_at);
CREATE TRIGGER invalidate_game_pairings AFTER UPDATE OF player_id, revoked_at, public_key ON wallet_bindings
BEGIN
  DELETE FROM game_pairings WHERE binding_id=NEW.id AND consumed_at IS NULL;
END;
CREATE TRIGGER disable_game_account AFTER UPDATE OF enabled ON game_accounts
BEGIN
  DELETE FROM game_pairings WHERE player_id=NEW.player_id AND consumed_at IS NULL;
  DELETE FROM game_identity_grants WHERE player_id=NEW.player_id;
  DELETE FROM game_identity_challenges WHERE player_id=NEW.player_id AND consumed_at IS NULL;
END;
