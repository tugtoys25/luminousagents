-- Sprint 10: explicit broker ownership for opportunity, enquiry and NDA visibility.
ALTER TABLE opportunities ADD COLUMN assigned_broker_id TEXT REFERENCES users(id);
CREATE INDEX IF NOT EXISTS idx_opportunities_assigned_broker ON opportunities(assigned_broker_id, updated_at DESC);
