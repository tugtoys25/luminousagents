-- Sprint 10: auditable scanner results, NDA template hash capture, and active template seed.
ALTER TABLE documents ADD COLUMN scan_provider TEXT;
ALTER TABLE documents ADD COLUMN scan_job_id TEXT;
ALTER TABLE documents ADD COLUMN scan_verdict TEXT;
ALTER TABLE documents ADD COLUMN scan_digest TEXT;
ALTER TABLE documents ADD COLUMN scanned_at TEXT;
ALTER TABLE documents ADD COLUMN scan_engine_version TEXT;
ALTER TABLE nda_requests ADD COLUMN nda_template_hash TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_documents_scan_job ON documents(scan_job_id);

-- Hash of docs/nda-template-v1.md. This is a bootstrap draft and MUST receive legal approval before launch.
INSERT OR IGNORE INTO nda_templates (id, name, version, r2_key, content_hash, status, created_by, created_at)
VALUES ('10da0000-0000-4000-8000-000000000001', 'Mayfair NDA Acknowledgement', 1, NULL, '9de441dff22680a05463d5f6b8a251f3bc5ee11ea66aa2be96523aa7380a9fd7', 'active', NULL, '2026-10-09T00:00:00.000Z');
