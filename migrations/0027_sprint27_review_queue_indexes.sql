-- Sprint 27 continuation: support CMS review queue and stale verification checks.
CREATE INDEX IF NOT EXISTS idx_opportunities_review_updated ON opportunities(content_review_status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_opportunities_verified_at ON opportunities(last_verified_at);
CREATE INDEX IF NOT EXISTS idx_opportunities_assigned_review ON opportunities(assigned_broker_id, content_review_status, updated_at DESC);
