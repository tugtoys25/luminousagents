-- Sprint 12 feature port into the deployed Sprint 11 schema.
-- Existing intentionally-public records retain their prior visibility; all other records default private.
ALTER TABLE opportunities ADD COLUMN classification TEXT NOT NULL DEFAULT 'confidential'
  CHECK (classification IN ('confidential','public','off_market','sold','under_offer','on_hold'));
ALTER TABLE opportunities ADD COLUMN labels_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE opportunity_media ADD COLUMN content_type TEXT NOT NULL DEFAULT 'image/jpeg';
ALTER TABLE opportunity_media ADD COLUMN byte_size INTEGER NOT NULL DEFAULT 0;
ALTER TABLE opportunity_media ADD COLUMN sha256 TEXT NOT NULL DEFAULT '';
ALTER TABLE buyer_profiles ADD COLUMN privacy_consent_at TEXT;
ALTER TABLE buyer_profiles ADD COLUMN privacy_notice_version TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_opportunity_media_order ON opportunity_media(opportunity_id, sort_order, created_at);
CREATE INDEX IF NOT EXISTS idx_opportunities_classification_public ON opportunities(classification, lifecycle, content_review_status, public_visibility);
UPDATE opportunities SET classification='public'
 WHERE content_review_status='approved' AND public_visibility=1;
