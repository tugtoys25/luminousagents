/** SQL for resolving a staff session cookie to an active staff identity. */
export interface StaffSessionRow {
  id: string;
  email: string;
  displayName: string;
  role: string;
  mustChange: number;
  sessionId: string;
  mfaAt: string | null;
  mfaEnabledAt: string | null;
}

/**
 * Resolves a HASHED session token. Valid only while the session is unrevoked and unexpired AND the user is an
 * active staff account, so suspending a user or revoking a session takes effect on the next request.
 */
export function findStaffSession(db: D1Database, tokenHash: string, nowIso: string): Promise<StaffSessionRow | null> {
  return db
    .prepare(
      "SELECT u.id, u.email, u.display_name AS displayName, u.role, u.must_change_password AS mustChange, s.id AS sessionId, s.mfa_at AS mfaAt, m.enabled_at AS mfaEnabledAt FROM sessions s JOIN users u ON u.id = s.user_id LEFT JOIN staff_mfa m ON m.user_id = u.id WHERE s.token_hash = ? AND s.session_type = 'staff' AND s.revoked_at IS NULL AND s.expires_at > ? AND u.user_type = 'staff' AND u.status = 'active' LIMIT 1",
    )
    .bind(tokenHash, nowIso)
    .first<StaffSessionRow>();
}

export async function touchSession(db: D1Database, sessionId: string, nowIso: string): Promise<void> {
  await db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').bind(nowIso, sessionId).run();
}
