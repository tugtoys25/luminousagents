-- Append-only protection for seller history tables (triggers isolated in their own migration).
-- Rollback: drop the triggers named below.
CREATE TRIGGER IF NOT EXISTS trg_seller_notes_no_update BEFORE UPDATE ON seller_enquiry_notes BEGIN SELECT RAISE(ABORT, 'seller_enquiry_notes is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_seller_notes_no_delete BEFORE DELETE ON seller_enquiry_notes BEGIN SELECT RAISE(ABORT, 'seller_enquiry_notes is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_seller_comms_no_update BEFORE UPDATE ON seller_communications BEGIN SELECT RAISE(ABORT, 'seller_communications is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_seller_comms_no_delete BEFORE DELETE ON seller_communications BEGIN SELECT RAISE(ABORT, 'seller_communications is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_seller_history_no_update BEFORE UPDATE ON seller_enquiry_status_history BEGIN SELECT RAISE(ABORT, 'seller_enquiry_status_history is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_seller_history_no_delete BEFORE DELETE ON seller_enquiry_status_history BEGIN SELECT RAISE(ABORT, 'seller_enquiry_status_history is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_seller_qual_no_update BEFORE UPDATE ON seller_enquiry_qualifications BEGIN SELECT RAISE(ABORT, 'seller_enquiry_qualifications is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_seller_qual_no_delete BEFORE DELETE ON seller_enquiry_qualifications BEGIN SELECT RAISE(ABORT, 'seller_enquiry_qualifications is append-only'); END;
