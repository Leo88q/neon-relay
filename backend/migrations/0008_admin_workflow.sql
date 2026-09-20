-- Tranche A: two-person admin workflow + append-only audit + vault snapshots.
--
-- Admin proposals replace direct seal/close execution: an operator proposes,
-- a superadmin approves (and the approval executes). Every step is mirrored
-- into admin_audit. Both tables are append-only: rows are never updated in
-- place (except the open->terminal proposal transition) and never deleted.
--
-- economy_epochs gains the vault snapshot the prize pool was derived from,
-- so any distribution can be reconciled against chain state afterwards.

CREATE TABLE admin_proposals (
  id               TEXT PRIMARY KEY,            -- crypto.randomUUID()
  type             TEXT NOT NULL,               -- seal-reward-epoch | close-economy-epoch
  params           TEXT NOT NULL,               -- JSON {epoch_id|epoch}
  proposed_by_role TEXT NOT NULL,               -- operator | superadmin
  proposed_by_hash TEXT NOT NULL,               -- sha256(hex) of the proposer token
  created_at       INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL,
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'executed', 'rejected', 'expired')),
  decided_at       INTEGER,                      -- set on open -> terminal
  decided_by_hash  TEXT,                         -- sha256(hex) of the approver/rejecter token
  result           TEXT                          -- JSON execution result / rejection reason
) STRICT;

CREATE INDEX admin_proposals_status ON admin_proposals (status, expires_at);

-- Only the open -> terminal transition is allowed, and the proposal identity
-- (type/params/proposer) is immutable.
CREATE TRIGGER admin_proposal_one_way BEFORE UPDATE ON admin_proposals
WHEN OLD.status != 'open'
  OR NEW.status NOT IN ('executed', 'rejected', 'expired')
  OR OLD.id != NEW.id OR OLD.type != NEW.type OR OLD.params != NEW.params
  OR OLD.proposed_by_role != NEW.proposed_by_role
  OR OLD.proposed_by_hash != NEW.proposed_by_hash
  OR OLD.created_at != NEW.created_at OR OLD.expires_at != NEW.expires_at
BEGIN
  SELECT RAISE(ABORT, 'proposal transition must be open to terminal');
END;

CREATE TRIGGER admin_proposal_no_delete BEFORE DELETE ON admin_proposals
BEGIN
  SELECT RAISE(ABORT, 'proposal deletion forbidden');
END;

CREATE TABLE admin_audit (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at     INTEGER NOT NULL,
  actor_role     TEXT NOT NULL,                 -- operator | superadmin | system
  actor_hash     TEXT,                          -- sha256(hex) of the actor token, NULL for system
  action         TEXT NOT NULL,                 -- proposal-created | proposal-approved | ...
  proposal_id    TEXT,                          -- linked proposal, NULL for direct actions
  params         TEXT,                          -- JSON request params (never secrets)
  result         TEXT,                          -- JSON short result
  request_ip     TEXT
) STRICT;

CREATE INDEX admin_audit_action ON admin_audit (action, created_at);
CREATE INDEX admin_audit_proposal ON admin_audit (proposal_id);

CREATE TRIGGER admin_audit_no_update BEFORE UPDATE ON admin_audit
BEGIN
  SELECT RAISE(ABORT, 'audit log is append-only');
END;

CREATE TRIGGER admin_audit_no_delete BEFORE DELETE ON admin_audit
BEGIN
  SELECT RAISE(ABORT, 'audit log is append-only');
END;

-- Vault snapshot for the prize pool derivation (u64 as canonical decimal TEXT,
-- vault_ata as base58). NULL for epochs closed before this migration.
ALTER TABLE economy_epochs ADD COLUMN vault_ata TEXT;
ALTER TABLE economy_epochs ADD COLUMN vault_balance TEXT;
ALTER TABLE economy_epochs ADD COLUMN vault_reserved TEXT;
