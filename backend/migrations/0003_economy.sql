-- Neon Relay economy (stage 15): epoch prize distributions computed by the
-- backend close job. Roots are published on-chain by an operator/admin step
-- (docs/PLAY_ECONOMY.md); the backend never holds chain keys.
CREATE TABLE economy_epochs (
  epoch            INTEGER PRIMARY KEY,
  root             TEXT NOT NULL,           -- hex sha256 Merkle root
  total_micro      INTEGER NOT NULL,
  distribution     TEXT NOT NULL,           -- JSON [{wallet, amount_micro, place}]
  created_at       INTEGER NOT NULL
);
