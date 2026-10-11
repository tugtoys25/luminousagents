-- Sprint 27: support filtered and paginated audit review.
CREATE INDEX IF NOT EXISTS idx_audit_action_created
  ON audit_logs(action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_entity_created
  ON audit_logs(entity_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor_created
  ON audit_logs(actor_user_id, created_at DESC);
