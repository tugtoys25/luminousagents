-- Gap-closing migration: additional seller contacts, and redaction-aware triggers so seller erasure can clear free text.
-- Rollback: drop seller_contacts if unused; re-create trg_authority_events_no_update / trg_interest_events_no_update strictly (see 0037 / 0039).
CREATE TABLE IF NOT EXISTS seller_contacts (
  id TEXT PRIMARY KEY,
  seller_id TEXT NOT NULL REFERENCES sellers(id),
  name TEXT NOT NULL,
  role_title TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL,
  telephone TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REMOVED')),
  created_by TEXT NOT NULL REFERENCES users(id),
  removed_by TEXT REFERENCES users(id),
  removed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_seller_contacts_seller ON seller_contacts(seller_id, status);

DROP TRIGGER IF EXISTS trg_authority_events_no_update;
CREATE TRIGGER trg_authority_events_no_update BEFORE UPDATE ON seller_authority_events
WHEN NEW.note IS NOT '[redacted]' OR NEW.id IS NOT OLD.id OR NEW.record_id IS NOT OLD.record_id OR NEW.from_status IS NOT OLD.from_status OR NEW.to_status IS NOT OLD.to_status OR NEW.actor_user_id IS NOT OLD.actor_user_id OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'seller_authority_events is append-only (redaction only)'); END;
DROP TRIGGER IF EXISTS trg_interest_events_no_update;
CREATE TRIGGER trg_interest_events_no_update BEFORE UPDATE ON seller_material_interest_events
WHEN NEW.note IS NOT '[redacted]' OR NEW.id IS NOT OLD.id OR NEW.interest_id IS NOT OLD.interest_id OR NEW.action IS NOT OLD.action OR NEW.from_stage IS NOT OLD.from_stage OR NEW.to_stage IS NOT OLD.to_stage OR NEW.actor_user_id IS NOT OLD.actor_user_id OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'seller_material_interest_events is append-only (redaction only)'); END;
