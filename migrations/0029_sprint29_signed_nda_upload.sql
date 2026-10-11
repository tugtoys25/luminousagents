-- Sprint 29 completion: preserve integrity and scan provenance for signed NDA uploads.
ALTER TABLE nda_requests ADD COLUMN signed_pdf_sha256 TEXT;
ALTER TABLE nda_requests ADD COLUMN signed_pdf_scan_provider TEXT;
ALTER TABLE nda_requests ADD COLUMN signed_pdf_scanned_at TEXT;
