-- Rollback: DROP the triggers named below.
CREATE TRIGGER IF NOT EXISTS trg_evidence_log_no_update BEFORE UPDATE ON seller_evidence_access_log BEGIN SELECT RAISE(ABORT, 'seller_evidence_access_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_evidence_log_no_delete BEFORE DELETE ON seller_evidence_access_log BEGIN SELECT RAISE(ABORT, 'seller_evidence_access_log is append-only'); END;
-- Evidence rows are never deleted (purging removes the bytes and clears the key), and the recorded digest never changes.
CREATE TRIGGER IF NOT EXISTS trg_evidence_no_delete BEFORE DELETE ON seller_authority_evidence BEGIN SELECT RAISE(ABORT, 'seller_authority_evidence is not deletable'); END;
CREATE TRIGGER IF NOT EXISTS trg_evidence_digest_fixed BEFORE UPDATE ON seller_authority_evidence
WHEN NEW.sha256 <> OLD.sha256 OR NEW.byte_size <> OLD.byte_size OR NEW.content_type <> OLD.content_type OR NEW.record_id <> OLD.record_id OR (OLD.r2_key IS NOT NULL AND NEW.r2_key IS NOT NULL AND NEW.r2_key <> OLD.r2_key)
BEGIN SELECT RAISE(ABORT, 'evidence identity is fixed'); END;
-- Once a scan verdict exists it cannot be overwritten (a re-scan would be a new upload).
CREATE TRIGGER IF NOT EXISTS trg_evidence_scan_final BEFORE UPDATE OF scan_status ON seller_authority_evidence
WHEN OLD.scan_status <> 'pending' AND NEW.scan_status <> OLD.scan_status
BEGIN SELECT RAISE(ABORT, 'scan verdict is final'); END;
