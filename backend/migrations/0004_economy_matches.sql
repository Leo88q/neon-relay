-- Neon Relay economy (stage 17): per-match payment intents. A reference is
-- SHA256(kind||epoch||match_id||wallet); paying it mints an on-chain ticket
-- that makes the wallet's ranked results count for epoch prizes.
CREATE TABLE economy_matches (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet_binding_id TEXT NOT NULL,
  epoch             INTEGER NOT NULL,
  reference         TEXT NOT NULL,          -- hex sha256 reference passed to pay_entry
  created_at        INTEGER NOT NULL,
  UNIQUE (wallet_binding_id, epoch, reference)
);
CREATE INDEX economy_matches_wallet ON economy_matches (wallet_binding_id, epoch);
