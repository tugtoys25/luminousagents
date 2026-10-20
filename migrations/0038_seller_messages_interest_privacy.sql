-- Phase 4: staff-sent seller emails (follow-up, material-interest notification), material-interest records,
-- privacy requests and legal holds. Additive.
ALTER TABLE seller_enquiries ADD COLUMN legal_hold INTEGER NOT NULL DEFAULT 0 CHECK (legal_hold IN (0,1));
ALTER TABLE sellers ADD COLUMN legal_hold INTEGER NOT NULL DEFAULT 0 CHECK (legal_hold IN (0,1));
ALTER TABLE seller_communications ADD COLUMN opportunity_id TEXT;

CREATE TABLE IF NOT EXISTS seller_material_interests (
  id TEXT PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  opportunity_id TEXT NOT NULL REFERENCES opportunities(id),
  seller_id TEXT NOT NULL REFERENCES sellers(id),
  link_id TEXT NOT NULL REFERENCES seller_opportunity_links(id),
  -- Internal pointer to the interested party (e.g. a buyer record id). Never placed in any seller email.
  buyer_reference TEXT NOT NULL DEFAULT '',
  interest_type TEXT NOT NULL CHECK (interest_type IN ('INITIAL_ENQUIRY','REQUEST_FOR_INFORMATION','MEETING_REQUEST','INDICATION_OF_INTEREST','INDICATIVE_PROPOSAL','FORMAL_OFFER')),
  received_at TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  summary_internal TEXT NOT NULL DEFAULT '',
  verification_state TEXT NOT NULL DEFAULT 'UNVERIFIED' CHECK (verification_state IN ('UNVERIFIED','VERIFIED','REJECTED')),
  stage TEXT NOT NULL DEFAULT 'RECORDED' CHECK (stage IN ('RECORDED','UNDER_REVIEW','APPROVED','REJECTED','WITHDRAWN','NOTIFIED')),
  stage_label TEXT NOT NULL DEFAULT '',
  -- Staff-written, reviewed text that may be shown to the seller. Nothing else from this record is emailed.
  approved_summary TEXT NOT NULL DEFAULT '',
  proposed_next_step TEXT NOT NULL DEFAULT '',
  confidentiality_checked INTEGER NOT NULL DEFAULT 0 CHECK (confidentiality_checked IN (0,1)),
  notification_eligible INTEGER NOT NULL DEFAULT 0 CHECK (notification_eligible IN (0,1)),
  recorded_by TEXT NOT NULL REFERENCES users(id),
  reviewed_by TEXT REFERENCES users(id),
  reviewed_at TEXT,
  notified_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (stage NOT IN ('APPROVED','NOTIFIED') OR (confidentiality_checked = 1 AND notification_eligible = 1 AND reviewed_by IS NOT NULL AND length(approved_summary) >= 20))
);
CREATE INDEX IF NOT EXISTS idx_interest_opportunity ON seller_material_interests(opportunity_id, stage);
CREATE INDEX IF NOT EXISTS idx_interest_seller ON seller_material_interests(seller_id, created_at DESC);

CREATE TABLE IF NOT EXISTS seller_material_interest_events (
  id TEXT PRIMARY KEY,
  interest_id TEXT NOT NULL REFERENCES seller_material_interests(id),
  action TEXT NOT NULL,
  from_stage TEXT,
  to_stage TEXT,
  note TEXT NOT NULL DEFAULT '',
  actor_user_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_interest_events ON seller_material_interest_events(interest_id, created_at DESC);

-- Every seller-facing email sent by staff. Content is frozen at approval (see trigger in 0039) and hashed.
CREATE TABLE IF NOT EXISTS seller_outbound_messages (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('FOLLOWUP','MATERIAL_INTEREST')),
  enquiry_id TEXT NOT NULL REFERENCES seller_enquiries(id),
  seller_id TEXT REFERENCES sellers(id),
  opportunity_id TEXT REFERENCES opportunities(id),
  interest_id TEXT REFERENCES seller_material_interests(id),
  interest_version INTEGER,
  template_id TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_text TEXT NOT NULL,
  body_html TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','QUEUED','SENDING','SENT','CANCELLED')),
  cancel_reason TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  approved_by TEXT REFERENCES users(id),
  approved_at TEXT,
  content_hash TEXT,
  sent_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (status NOT IN ('QUEUED','SENDING','SENT') OR (approved_by IS NOT NULL AND approved_at IS NOT NULL AND content_hash IS NOT NULL)),
  CHECK (kind <> 'MATERIAL_INTEREST' OR (interest_id IS NOT NULL AND interest_version IS NOT NULL AND seller_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_messages_enquiry ON seller_outbound_messages(enquiry_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_interest ON seller_outbound_messages(interest_id, status);

CREATE TABLE IF NOT EXISTS seller_privacy_requests (
  id TEXT PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  enquiry_id TEXT REFERENCES seller_enquiries(id),
  request_type TEXT NOT NULL CHECK (request_type IN ('ACCESS','ERASURE','RECTIFICATION','RESTRICTION','MARKETING_WITHDRAWAL','OTHER')),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','IN_PROGRESS','COMPLETED','REFUSED')),
  received_at TEXT NOT NULL,
  -- Entered by staff from the applicable policy; the system does not assume any statutory period.
  due_at TEXT,
  outcome_note TEXT NOT NULL DEFAULT '',
  handled_by TEXT REFERENCES users(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (status NOT IN ('COMPLETED','REFUSED') OR length(outcome_note) >= 5)
);
CREATE INDEX IF NOT EXISTS idx_privacy_status ON seller_privacy_requests(status, due_at);
