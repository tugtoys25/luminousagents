/** SQL for staff and buyer session security pages (super administrators only). */
type Row = Record<string, unknown>;

export interface SessionTarget {
  id: string;
  userId: string;
  email: string;
}
export interface StaffSessionTarget extends SessionTarget {
  tokenHash: string;
}

export async function listActiveStaffSessions(db: D1Database, currentHash: string, nowIso: string): Promise<Row[]> {
  const result = await db
    .prepare(
      "SELECT s.id, s.user_id AS userId, s.created_at AS createdAt, s.last_seen_at AS lastSeenAt, s.expires_at AS expiresAt, u.email, u.display_name AS displayName, u.role, CASE WHEN s.token_hash = ? THEN 1 ELSE 0 END AS isCurrent FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.session_type = 'staff' AND s.revoked_at IS NULL AND s.expires_at > ? AND u.user_type = 'staff' AND u.status = 'active' ORDER BY s.last_seen_at DESC, s.id LIMIT 500",
    )
    .bind(currentHash, nowIso)
    .all<Row>();
  return result.results ?? [];
}

export function findActiveStaffSession(db: D1Database, sessionId: string): Promise<StaffSessionTarget | null> {
  return db
    .prepare(
      "SELECT s.id, s.user_id AS userId, s.token_hash AS tokenHash, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.session_type = 'staff' AND s.revoked_at IS NULL AND u.user_type = 'staff'",
    )
    .bind(sessionId)
    .first<StaffSessionTarget>();
}

/** True only when this call actually revoked the session (guards against double revoke races). */
export async function revokeStaffSession(db: D1Database, sessionId: string, timestamp: string): Promise<boolean> {
  const changed = await db
    .prepare(
      "UPDATE sessions SET revoked_at = ? WHERE id = ? AND session_type = 'staff' AND revoked_at IS NULL",
    )
    .bind(timestamp, sessionId)
    .run();
  return (changed.meta?.changes ?? 0) === 1;
}

export async function listActiveBuyerSessions(db: D1Database, nowIso: string): Promise<Row[]> {
  const result = await db
    .prepare(
      "SELECT s.id, s.user_id AS userId, s.created_at AS createdAt, s.last_seen_at AS lastSeenAt, s.expires_at AS expiresAt, u.email, u.display_name AS displayName, u.status AS accountStatus FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.session_type = 'buyer' AND s.revoked_at IS NULL AND s.expires_at > ? AND u.user_type = 'buyer' ORDER BY s.last_seen_at DESC, s.id LIMIT 500",
    )
    .bind(nowIso)
    .all<Row>();
  return result.results ?? [];
}

export function findActiveBuyerSession(db: D1Database, sessionId: string): Promise<SessionTarget | null> {
  return db
    .prepare(
      "SELECT s.id, s.user_id AS userId, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.session_type = 'buyer' AND s.revoked_at IS NULL AND u.user_type = 'buyer'",
    )
    .bind(sessionId)
    .first<SessionTarget>();
}

export async function revokeBuyerSession(db: D1Database, sessionId: string, timestamp: string): Promise<boolean> {
  const changed = await db
    .prepare(
      "UPDATE sessions SET revoked_at = ? WHERE id = ? AND session_type = 'buyer' AND revoked_at IS NULL",
    )
    .bind(timestamp, sessionId)
    .run();
  return (changed.meta?.changes ?? 0) === 1;
}
