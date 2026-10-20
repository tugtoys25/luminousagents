-- Phase 4 triggers. Rollback: drop the triggers named in this file (and re-create trg_seller_notes_no_update /
-- trg_seller_comms_no_update / trg_seller_changes_no_update from migrations 0035 and 0037 to restore strict append-only).
CREATE TRIGGER IF NOT EXISTS trg_interest_events_no_update BEFORE UPDATE ON seller_material_interest_events BEGIN SELECT RAISE(ABORT, 'seller_material_interest_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_interest_events_no_delete BEFORE DELETE ON seller_material_interest_events BEGIN SELECT RAISE(ABORT, 'seller_material_interest_events is append-only'); END;

-- Retention/erasure is the ONLY permitted change to these append-only tables: free text may be replaced by '[redacted]'.
DROP TRIGGER IF EXISTS trg_seller_notes_no_update;
CREATE TRIGGER trg_seller_notes_no_update BEFORE UPDATE ON seller_enquiry_notes
WHEN NEW.note <> '[redacted]' OR NEW.id <> OLD.id OR NEW.enquiry_id <> OLD.enquiry_id OR NEW.author_id <> OLD.author_id OR NEW.classification <> OLD.classification OR NEW.created_at <> OLD.created_at
BEGIN SELECT RAISE(ABORT, 'seller_enquiry_notes is append-only (redaction only)'); END;
DROP TRIGGER IF EXISTS trg_seller_comms_no_update;
CREATE TRIGGER trg_seller_comms_no_update BEFORE UPDATE ON seller_communications
WHEN NEW.summary <> '[redacted]' OR NEW.id <> OLD.id OR NEW.enquiry_id <> OLD.enquiry_id OR NEW.direction <> OLD.direction OR NEW.channel <> OLD.channel OR NEW.occurred_at <> OLD.occurred_at OR NEW.outcome <> OLD.outcome
BEGIN SELECT RAISE(ABORT, 'seller_communications is append-only (redaction only)'); END;
DROP TRIGGER IF EXISTS trg_seller_changes_no_update;
CREATE TRIGGER trg_seller_changes_no_update BEFORE UPDATE ON seller_changes
WHEN NEW.old_value IS NOT NULL AND NEW.old_value <> '[redacted]' OR NEW.new_value IS NOT NULL AND NEW.new_value <> '[redacted]' OR NEW.id <> OLD.id OR NEW.seller_id <> OLD.seller_id OR NEW.field <> OLD.field OR NEW.reason <> OLD.reason
BEGIN SELECT RAISE(ABORT, 'seller_changes is append-only (redaction only)'); END;

-- Approved message content cannot change after approval (redaction under the retention policy excepted); messages are never deleted.
CREATE TRIGGER IF NOT EXISTS trg_messages_content_frozen BEFORE UPDATE ON seller_outbound_messages
WHEN OLD.status <> 'DRAFT' AND NEW.body_text <> '[redacted]'
  AND (NEW.subject <> OLD.subject OR NEW.body_text <> OLD.body_text OR NEW.body_html <> OLD.body_html OR NEW.recipient_email <> OLD.recipient_email OR NEW.kind <> OLD.kind)
BEGIN SELECT RAISE(ABORT, 'approved message content is frozen'); END;
CREATE TRIGGER IF NOT EXISTS trg_messages_no_delete BEFORE DELETE ON seller_outbound_messages BEGIN SELECT RAISE(ABORT, 'seller_outbound_messages is not deletable'); END;
-- A sent message cannot go back to an earlier state.
CREATE TRIGGER IF NOT EXISTS trg_messages_no_resurrect BEFORE UPDATE OF status ON seller_outbound_messages
WHEN OLD.status IN ('SENT','CANCELLED') AND NEW.status <> OLD.status
BEGIN SELECT RAISE(ABORT, 'message state is final'); END;

DROP TRIGGER IF EXISTS trg_seller_history_no_update;
CREATE TRIGGER trg_seller_history_no_update BEFORE UPDATE ON seller_enquiry_status_history
WHEN (NEW.reason IS NOT NULL AND NEW.reason <> '[redacted]') OR NEW.id <> OLD.id OR NEW.enquiry_id <> OLD.enquiry_id OR NEW.from_status <> OLD.from_status OR NEW.to_status <> OLD.to_status OR NEW.actor_user_id <> OLD.actor_user_id OR NEW.created_at <> OLD.created_at
BEGIN SELECT RAISE(ABORT, 'seller_enquiry_status_history is append-only (redaction only)'); END;
DROP TRIGGER IF EXISTS trg_seller_qual_no_update;
CREATE TRIGGER trg_seller_qual_no_update BEFORE UPDATE ON seller_enquiry_qualifications
WHEN NEW.checklist_json <> '[]' OR NEW.next_action <> '[redacted]' OR NEW.id <> OLD.id OR NEW.enquiry_id <> OLD.enquiry_id OR NEW.reviewer_id <> OLD.reviewer_id OR NEW.outcome <> OLD.outcome OR NEW.created_at <> OLD.created_at
BEGIN SELECT RAISE(ABORT, 'seller_enquiry_qualifications is append-only (redaction only)'); END;
