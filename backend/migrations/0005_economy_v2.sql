-- New namespace; deliberately does not relabel/mutate legacy single-mint rows.
-- Public keys and hashes use lowercase 32-byte hex; u64 values use canonical
-- decimal TEXT so SQLite/JS never truncate them to signed int64/double.
CREATE TABLE economy_v2_epochs (
  mint TEXT NOT NULL CHECK(length(mint) = 64 AND mint NOT GLOB '*[^0-9a-f]*'),
  epoch TEXT NOT NULL CHECK(length(epoch) BETWEEN 1 AND 20 AND epoch NOT GLOB '*[^0-9]*'
    AND (epoch = '0' OR substr(epoch, 1, 1) != '0')
    AND (length(epoch) < 20 OR epoch <= '18446744073709551615')),
  state TEXT NOT NULL DEFAULT 'OPEN' CHECK(state IN ('OPEN', 'SEALED')),
  pool_base TEXT NOT NULL CHECK(length(pool_base) BETWEEN 1 AND 20 AND pool_base NOT GLOB '*[^0-9]*'
    AND (pool_base = '0' OR substr(pool_base, 1, 1) != '0')
    AND (length(pool_base) < 20 OR pool_base <= '18446744073709551615')),
  root TEXT CHECK(length(root) = 64 AND root NOT GLOB '*[^0-9a-f]*'),
  total_base TEXT CHECK(length(total_base) BETWEEN 1 AND 20 AND total_base NOT GLOB '*[^0-9]*'
    AND (total_base = '0' OR substr(total_base, 1, 1) != '0')
    AND (length(total_base) < 20 OR total_base <= '18446744073709551615')),
  distribution TEXT,
  PRIMARY KEY(mint, epoch),
  CHECK((state = 'OPEN' AND root IS NULL AND total_base IS NULL AND distribution IS NULL)
    OR (state = 'SEALED' AND root IS NOT NULL AND total_base IS NOT NULL AND distribution IS NOT NULL))
) STRICT;

CREATE TRIGGER economy_v2_epoch_insert_open BEFORE INSERT ON economy_v2_epochs
WHEN NEW.state != 'OPEN' OR EXISTS(SELECT 1 FROM economy_v2_epochs WHERE mint = NEW.mint AND epoch = NEW.epoch)
BEGIN SELECT RAISE(ABORT, 'epoch must start OPEN'); END;

CREATE TRIGGER economy_v2_epoch_one_way BEFORE UPDATE ON economy_v2_epochs
WHEN OLD.state != 'OPEN' OR NEW.state != 'SEALED'
  OR OLD.mint != NEW.mint OR OLD.epoch != NEW.epoch OR OLD.pool_base != NEW.pool_base
BEGIN SELECT RAISE(ABORT, 'epoch transition must be OPEN to SEALED'); END;

CREATE TRIGGER economy_v2_epoch_no_delete BEFORE DELETE ON economy_v2_epochs
BEGIN SELECT RAISE(ABORT, 'epoch deletion forbidden'); END;

CREATE TABLE economy_v2_intents (
  mint TEXT NOT NULL,
  epoch TEXT NOT NULL,
  player_id TEXT NOT NULL CHECK(length(player_id) BETWEEN 1 AND 128),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128),
  wallet TEXT NOT NULL CHECK(length(wallet) = 64 AND wallet NOT GLOB '*[^0-9a-f]*'),
  kind INTEGER NOT NULL CHECK(kind IN (0, 1)),
  tier TEXT NOT NULL CHECK(length(tier) BETWEEN 1 AND 64),
  amount_base TEXT NOT NULL CHECK(length(amount_base) BETWEEN 1 AND 20 AND amount_base NOT GLOB '*[^0-9]*'
    AND (amount_base = '0' OR substr(amount_base, 1, 1) != '0')
    AND (length(amount_base) < 20 OR amount_base <= '18446744073709551615')),
  reference TEXT NOT NULL CHECK(length(reference) = 64 AND reference NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY(mint, player_id, idempotency_key),
  UNIQUE(mint, reference),
  FOREIGN KEY(mint, epoch) REFERENCES economy_v2_epochs(mint, epoch)
) STRICT;
CREATE INDEX economy_v2_intents_cap ON economy_v2_intents(mint, epoch, player_id);

CREATE TRIGGER economy_v2_intent_open BEFORE INSERT ON economy_v2_intents
WHEN NOT EXISTS(SELECT 1 FROM economy_v2_epochs
  WHERE mint = NEW.mint AND epoch = NEW.epoch AND state = 'OPEN')
  OR EXISTS(SELECT 1 FROM economy_v2_intents WHERE mint = NEW.mint
    AND ((player_id = NEW.player_id AND idempotency_key = NEW.idempotency_key) OR reference = NEW.reference))
BEGIN SELECT RAISE(ABORT, 'intent requires OPEN epoch'); END;

CREATE TRIGGER economy_v2_intent_immutable BEFORE UPDATE ON economy_v2_intents
BEGIN SELECT RAISE(ABORT, 'intent is immutable'); END;
CREATE TRIGGER economy_v2_intent_no_delete BEFORE DELETE ON economy_v2_intents
BEGIN SELECT RAISE(ABORT, 'intent deletion forbidden'); END;
