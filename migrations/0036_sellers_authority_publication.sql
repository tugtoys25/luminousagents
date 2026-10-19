-- Phase 3: seller relationship records, seller<->opportunity links, authority/mandate records and the
-- publication review that gates seller-sourced opportunities. Additive; no existing data is modified.
CREATE TABLE IF NOT EXISTS sellers (
  id TEXT PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  organisation TEXT,
  contact_name TEXT NOT NULL,
  contact_email TEXT NOT NULL,
  contact_telephone TEXT,
  contact_country TEXT,
  preferred_contact_method TEXT CHECK (preferred_contact_method IS NULL OR preferred_contact_method IN ('EMAIL','TELEPHONE','EITHER')),
  relationship_owner TEXT REFERENCES users(id),
  source_enquiry_id TEXT REFERENCES seller_enquiries(id),
  confidentiality_restrictions TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','RESTRICTED','INACTIVE')),
  retention_review_at TEXT,
  anonymised_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sellers_owner ON sellers(relationship_owner, status);
CREATE INDEX IF NOT EXISTS idx_sellers_email ON sellers(contact_email COLLATE NOCASE);

ALTER TABLE seller_enquiries ADD COLUMN seller_id TEXT REFERENCES sellers(id);
CREATE INDEX IF NOT EXISTS idx_seller_enquiries_seller ON seller_enquiries(seller_id);

-- Corrections to seller details are recorded here, never applied silently.
CREATE TABLE IF NOT EXISTS seller_changes (
  id TEXT PRIMARY KEY,
  seller_id TEXT NOT NULL REFERENCES sellers(id),
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  reason TEXT NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_seller_changes_seller ON seller_changes(seller_id, created_at DESC);

CREATE TABLE IF NOT EXISTS seller_opportunity_links (
  id TEXT PRIMARY KEY,
  seller_id TEXT NOT NULL REFERENCES sellers(id),
  opportunity_id TEXT NOT NULL REFERENCES opportunities(id),
  role TEXT NOT NULL CHECK (role IN ('OWNER','AUTHORISED_REPRESENTATIVE','BROKER_INTERMEDIARY','PROFESSIONAL_ADVISER','OTHER')),
  relationship_status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (relationship_status IN ('ACTIVE','ENDED')),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  confidentiality_restrictions TEXT NOT NULL DEFAULT '',
  review_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (review_status IN ('PENDING','REVIEWED')),
  reviewed_by TEXT REFERENCES users(id),
  reviewed_at TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (seller_id, opportunity_id),
  CHECK (review_status <> 'REVIEWED' OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_seller_links_opportunity ON seller_opportunity_links(opportunity_id, relationship_status);

-- Authority and mandate records. Each authority_type is a separate concept and is verified separately.
CREATE TABLE IF NOT EXISTS seller_authority_records (
  id TEXT PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  link_id TEXT NOT NULL REFERENCES seller_opportunity_links(id),
  authority_type TEXT NOT NULL CHECK (authority_type IN ('AUTHORITY_TO_SUBMIT','AUTHORITY_TO_REPRESENT','AUTHORITY_TO_NEGOTIATE','AUTHORITY_TO_MARKET','BROKERAGE_MANDATE')),
  -- A reference to evidence held in private storage or the compliance system. Never a URL; no evidence is stored here.
  evidence_type TEXT NOT NULL DEFAULT 'NONE' CHECK (evidence_type IN ('NONE','POWER_OF_ATTORNEY','BOARD_RESOLUTION','SIGNED_MANDATE','OWNERSHIP_RECORD','OTHER')),
  evidence_ref TEXT,
  status TEXT NOT NULL DEFAULT 'NOT_REVIEWED' CHECK (status IN ('NOT_REVIEWED','EVIDENCE_REQUESTED','UNDER_REVIEW','VERIFIED','REJECTED','EXPIRED','REVOKED','NOT_REQUIRED_WITH_RECORDED_REASON')),
  scope TEXT NOT NULL DEFAULT '',
  limitations TEXT NOT NULL DEFAULT '',
  exclusive INTEGER NOT NULL DEFAULT 0 CHECK (exclusive IN (0,1)),
  valid_from TEXT,
  valid_until TEXT,
  reviewed_by TEXT REFERENCES users(id),
  reviewed_at TEXT,
  review_notes TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL REFERENCES users(id),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (status <> 'VERIFIED' OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND evidence_type <> 'NONE' AND length(scope) >= 5)),
  CHECK (status <> 'NOT_REQUIRED_WITH_RECORDED_REASON' OR (reviewed_by IS NOT NULL AND length(review_notes) >= 10)),
  CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until > valid_from)
);
CREATE INDEX IF NOT EXISTS idx_authority_link ON seller_authority_records(link_id, authority_type, status);
CREATE INDEX IF NOT EXISTS idx_authority_expiry ON seller_authority_records(status, valid_until);

CREATE TABLE IF NOT EXISTS seller_authority_events (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL REFERENCES seller_authority_records(id),
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  actor_user_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_authority_events_record ON seller_authority_events(record_id, created_at DESC);

-- One publication review per seller-sourced opportunity. APPROVED is only storable when every control is confirmed.
CREATE TABLE IF NOT EXISTS seller_publication_reviews (
  id TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL UNIQUE REFERENCES opportunities(id),
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','APPROVED','REJECTED','REVOKED')),
  scope_text TEXT NOT NULL DEFAULT '',
  scope_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (scope_confirmed IN (0,1)),
  confidentiality_reviewed INTEGER NOT NULL DEFAULT 0 CHECK (confidentiality_reviewed IN (0,1)),
  public_fields_approved INTEGER NOT NULL DEFAULT 0 CHECK (public_fields_approved IN (0,1)),
  sensitive_data_reviewed INTEGER NOT NULL DEFAULT 0 CHECK (sensitive_data_reviewed IN (0,1)),
  image_rights_checked INTEGER NOT NULL DEFAULT 0 CHECK (image_rights_checked IN (0,1)),
  legal_review_completed INTEGER NOT NULL DEFAULT 0 CHECK (legal_review_completed IN (0,1)),
  notes TEXT NOT NULL DEFAULT '',
  prepared_by TEXT NOT NULL REFERENCES users(id),
  approved_by TEXT REFERENCES users(id),
  approved_at TEXT,
  revoked_by TEXT REFERENCES users(id),
  revoked_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (status <> 'APPROVED' OR (scope_confirmed = 1 AND confidentiality_reviewed = 1 AND public_fields_approved = 1 AND sensitive_data_reviewed = 1
    AND image_rights_checked = 1 AND legal_review_completed = 1 AND length(scope_text) >= 10 AND approved_by IS NOT NULL AND approved_at IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS seller_publication_events (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES seller_publication_reviews(id),
  opportunity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  actor_user_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_publication_events_opp ON seller_publication_events(opportunity_id, created_at DESC);
