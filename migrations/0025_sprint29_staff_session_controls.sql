-- Sprint 29: make active staff-session inventory and revocation queries efficient.
CREATE INDEX IF NOT EXISTS idx_sessions_staff_active_expiry
  ON sessions(session_type, revoked_at, expires_at, user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_staff_user_activity
  ON sessions(user_id, session_type, revoked_at, last_seen_at DESC);
