CREATE TABLE IF NOT EXISTS buyer_profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  company_name TEXT NOT NULL DEFAULT '',
  role_title TEXT NOT NULL DEFAULT '',
  countries_json TEXT NOT NULL DEFAULT '[]',
  budget_min_minor INTEGER,
  budget_max_minor INTEGER,
  currency TEXT NOT NULL DEFAULT 'GBP',
  experience_notes TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS saved_opportunities (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  opportunity_id TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY(user_id, opportunity_id)
);
CREATE TABLE IF NOT EXISTS nda_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  r2_key TEXT,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','retired')),
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE(name, version)
);
CREATE TABLE IF NOT EXISTS nda_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  opportunity_id TEXT NOT NULL REFERENCES opportunities(id),
  template_id TEXT REFERENCES nda_templates(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','revoked')),
  acceptance_name TEXT,
  accepted_at TEXT,
  accepted_ip_hash TEXT,
  signed_pdf_r2_key TEXT,
  review_reason TEXT NOT NULL DEFAULT '',
  reviewed_by TEXT REFERENCES users(id),
  reviewed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS access_grants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  opportunity_id TEXT NOT NULL REFERENCES opportunities(id),
  nda_request_id TEXT NOT NULL REFERENCES nda_requests(id),
  tier INTEGER NOT NULL DEFAULT 2 CHECK (tier IN (1,2)),
  granted_by TEXT REFERENCES users(id),
  granted_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE(user_id, opportunity_id, nda_request_id)
);
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  tier INTEGER NOT NULL DEFAULT 2 CHECK (tier IN (1,2)),
  uploaded_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);
