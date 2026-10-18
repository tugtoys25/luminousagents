-- Append-only protection for audit_logs. Isolated in its own migration because it uses triggers.
-- Rollback: DROP TRIGGER trg_audit_logs_no_update; DROP TRIGGER trg_audit_logs_no_delete;
CREATE TRIGGER IF NOT EXISTS trg_audit_logs_no_update BEFORE UPDATE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'audit_logs is append-only');
END;
CREATE TRIGGER IF NOT EXISTS trg_audit_logs_no_delete BEFORE DELETE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'audit_logs is append-only');
END;
