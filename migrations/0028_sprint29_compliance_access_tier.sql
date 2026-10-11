-- Sprint 29 completion: tier 3 is the highest-confidentiality data-room tier.
-- Only super administrators may issue tier-3 grants or upload tier-3 documents.
CREATE TABLE access_grants_v2 (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  opportunity_id TEXT NOT NULL REFERENCES opportunities(id),
  nda_request_id TEXT NOT NULL REFERENCES nda_requests(id),
  tier INTEGER NOT NULL DEFAULT 2 CHECK (tier IN (1,2,3)),
  granted_by TEXT REFERENCES users(id),
  granted_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE(user_id, opportunity_id, nda_request_id)
);
INSERT INTO access_grants_v2 (id, user_id, opportunity_id, nda_request_id, tier, granted_by, granted_at, expires_at, revoked_at)
SELECT id, user_id, opportunity_id, nda_request_id, tier, granted_by, granted_at, expires_at, revoked_at FROM access_grants;
DROP TABLE access_grants;
ALTER TABLE access_grants_v2 RENAME TO access_grants;
CREATE INDEX IF NOT EXISTS idx_grants_active ON access_grants(user_id, opportunity_id, expires_at, revoked_at);
CREATE INDEX IF NOT EXISTS idx_access_grants_active ON access_grants(user_id, opportunity_id, expires_at);

CREATE TABLE documents_v2 (
  id TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  tier INTEGER NOT NULL DEFAULT 2 CHECK (tier IN (1,2,3)),
  uploaded_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  sha256 TEXT NOT NULL DEFAULT '',
  scan_status TEXT NOT NULL DEFAULT 'pending' CHECK (scan_status IN ('pending','clean','rejected')),
  scan_provider TEXT,
  scan_job_id TEXT,
  scan_verdict TEXT,
  scan_digest TEXT,
  scanned_at TEXT,
  scan_engine_version TEXT
);
INSERT INTO documents_v2 (id, opportunity_id, r2_key, filename, content_type, byte_size, tier, uploaded_by, created_at, sha256, scan_status, scan_provider, scan_job_id, scan_verdict, scan_digest, scanned_at, scan_engine_version)
SELECT id, opportunity_id, r2_key, filename, content_type, byte_size, tier, uploaded_by, created_at, sha256, scan_status, scan_provider, scan_job_id, scan_verdict, scan_digest, scanned_at, scan_engine_version FROM documents;
DROP TABLE documents;
ALTER TABLE documents_v2 RENAME TO documents;
CREATE INDEX IF NOT EXISTS idx_documents_opportunity_tier ON documents(opportunity_id, tier, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_scan_status ON documents(scan_status, opportunity_id, tier);
CREATE INDEX IF NOT EXISTS idx_documents_scan_job ON documents(scan_job_id);
