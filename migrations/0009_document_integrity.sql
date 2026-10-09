-- Integrity metadata and fail-closed malware-review gate for private data-room files.
ALTER TABLE documents ADD COLUMN sha256 TEXT NOT NULL DEFAULT '';
ALTER TABLE documents ADD COLUMN scan_status TEXT NOT NULL DEFAULT 'pending' CHECK (scan_status IN ('pending','clean','rejected'));
CREATE INDEX IF NOT EXISTS idx_documents_scan_status ON documents(scan_status, opportunity_id, tier);
