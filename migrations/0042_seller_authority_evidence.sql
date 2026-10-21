-- Authority evidence files. Bytes live in the existing PRIVATE_FILES R2 bucket (never public); this table holds metadata only.
-- Files are unavailable until scanned clean (same model as data-room documents). Removal is a purge: bytes deleted, row kept.
CREATE TABLE IF NOT EXISTS seller_authority_evidence (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL REFERENCES seller_authority_records(id),
  r2_key TEXT,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL CHECK (content_type IN ('application/pdf','image/jpeg','image/png','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')),
  byte_size INTEGER NOT NULL CHECK (byte_size > 0 AND byte_size <= 20971520),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  scan_status TEXT NOT NULL DEFAULT 'pending' CHECK (scan_status IN ('pending','clean','rejected')),
  scan_provider TEXT,
  scan_reference TEXT,
  scan_skipped INTEGER NOT NULL DEFAULT 0 CHECK (scan_skipped IN (0,1)),
  scanned_at TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','RETIRED')),
  retired_by TEXT REFERENCES users(id),
  retired_at TEXT,
  purge_pending INTEGER NOT NULL DEFAULT 0 CHECK (purge_pending IN (0,1)),
  purged_at TEXT,
  uploaded_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (purged_at IS NULL OR r2_key IS NULL)
);
CREATE INDEX IF NOT EXISTS idx_evidence_record ON seller_authority_evidence(record_id, status);
CREATE INDEX IF NOT EXISTS idx_evidence_purge ON seller_authority_evidence(purge_pending, purged_at);

-- Who looked at or acted on evidence. Append-only.
CREATE TABLE IF NOT EXISTS seller_evidence_access_log (
  id TEXT PRIMARY KEY,
  evidence_id TEXT NOT NULL REFERENCES seller_authority_evidence(id),
  actor_user_id TEXT REFERENCES users(id),
  action TEXT NOT NULL CHECK (action IN ('uploaded','scanned','downloaded','retired','delete_requested','purged')),
  request_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evidence_log ON seller_evidence_access_log(evidence_id, created_at DESC);
