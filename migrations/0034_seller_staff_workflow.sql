-- Seller enquiry staff workflow: notes, communications, status/assignment history, qualification reviews,
-- and follow-up columns on the existing staff_tasks table (reused instead of a parallel task table).
ALTER TABLE staff_tasks ADD COLUMN task_type TEXT;
ALTER TABLE staff_tasks ADD COLUMN outcome TEXT;
ALTER TABLE staff_tasks ADD COLUMN reminder_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE staff_tasks ADD COLUMN last_reminder_at TEXT;
ALTER TABLE staff_tasks ADD COLUMN escalated_at TEXT;
CREATE INDEX IF NOT EXISTS idx_staff_tasks_seller_due ON staff_tasks(related_entity_type, related_entity_id, status, due_at);

CREATE TABLE IF NOT EXISTS seller_enquiry_notes (
  id TEXT PRIMARY KEY,
  enquiry_id TEXT NOT NULL REFERENCES seller_enquiries(id),
  author_id TEXT NOT NULL REFERENCES users(id),
  classification TEXT NOT NULL DEFAULT 'GENERAL' CHECK (classification IN ('GENERAL','QUALIFICATION','CONFIDENTIALITY','AUTHORITY','COMPLIANCE')),
  note TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_seller_notes_enquiry ON seller_enquiry_notes(enquiry_id, created_at DESC);

CREATE TABLE IF NOT EXISTS seller_communications (
  id TEXT PRIMARY KEY,
  enquiry_id TEXT NOT NULL REFERENCES seller_enquiries(id),
  direction TEXT NOT NULL CHECK (direction IN ('INBOUND','OUTBOUND')),
  channel TEXT NOT NULL CHECK (channel IN ('EMAIL','TELEPHONE','MEETING','MESSAGE','OTHER')),
  occurred_at TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('staff','system')),
  actor_user_id TEXT REFERENCES users(id),
  template_id TEXT,
  summary TEXT NOT NULL DEFAULT '',
  outcome TEXT NOT NULL CHECK (outcome IN ('CONNECTED','NO_ANSWER','LEFT_MESSAGE','SENT','RECEIVED','OTHER')),
  delivery_status TEXT CHECK (delivery_status IS NULL OR delivery_status IN ('ACCEPTED_BY_PROVIDER','NOT_APPLICABLE')),
  followup_task_id TEXT,
  notification_job_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_seller_comms_enquiry ON seller_communications(enquiry_id, occurred_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_seller_comms_job ON seller_communications(notification_job_id) WHERE notification_job_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS seller_enquiry_status_history (
  id TEXT PRIMARY KEY,
  enquiry_id TEXT NOT NULL REFERENCES seller_enquiries(id),
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  from_assignee TEXT,
  to_assignee TEXT,
  reason TEXT,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_seller_history_enquiry ON seller_enquiry_status_history(enquiry_id, created_at DESC);

CREATE TABLE IF NOT EXISTS seller_enquiry_qualifications (
  id TEXT PRIMARY KEY,
  enquiry_id TEXT NOT NULL REFERENCES seller_enquiries(id),
  reviewer_id TEXT NOT NULL REFERENCES users(id),
  checklist_json TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('PASS','FAIL','NEEDS_MORE_INFO')),
  next_action TEXT NOT NULL,
  compliance_routed INTEGER NOT NULL DEFAULT 0 CHECK (compliance_routed IN (0,1)),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_seller_qual_enquiry ON seller_enquiry_qualifications(enquiry_id, created_at DESC);
