-- Sprint 30: support bounded inventory of buyer sessions in security operations.
CREATE INDEX IF NOT EXISTS idx_sprint30_buyer_sessions_active
  ON sessions(session_type, revoked_at, expires_at, last_seen_at DESC, user_id);
