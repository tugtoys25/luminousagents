-- Sprint 19: triage workflow for managed-form submissions.
-- Forward-only and additive. Apply BEFORE deploying code that reads these columns.
ALTER TABLE managed_form_submissions ADD COLUMN status TEXT NOT NULL DEFAULT 'new';
ALTER TABLE managed_form_submissions ADD COLUMN internal_note TEXT NOT NULL DEFAULT '';
ALTER TABLE managed_form_submissions ADD COLUMN updated_at TEXT;
CREATE INDEX IF NOT EXISTS idx_managed_form_submissions_status ON managed_form_submissions(status, created_at DESC);
-- Lets the buyer re-request after an approval has expired or been revoked, and speeds the "active grant" check.
CREATE INDEX IF NOT EXISTS idx_access_grants_active ON access_grants(user_id, opportunity_id, expires_at);
