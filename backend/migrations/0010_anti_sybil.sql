-- Anti-sybil identity invariant: one active wallet may own a player id.
-- Revoked bindings remain auditable and may be re-linked only after the old
-- active binding is explicitly revoked. Existing duplicate data makes this
-- migration fail closed and requires operator reconciliation before boot.
CREATE UNIQUE INDEX wallet_bindings_active_player_unique
  ON wallet_bindings(player_id)
  WHERE player_id IS NOT NULL AND revoked_at IS NULL;
CREATE INDEX wallet_bindings_active_wallet
  ON wallet_bindings(public_key)
  WHERE revoked_at IS NULL;
