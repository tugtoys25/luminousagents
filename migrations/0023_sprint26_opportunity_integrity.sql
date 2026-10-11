-- Sprint 26: indexes for review queues and version recovery history.
CREATE INDEX IF NOT EXISTS idx_opportunities_review_queue
  ON opportunities(content_review_status, lifecycle, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_opportunity_versions_recent
  ON opportunity_versions(opportunity_id, version_number DESC);
