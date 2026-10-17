/**
 * SQL for the staff/buyer sign-in portal: login, lockout, resets, password changes, buyer email codes,
 * first-administrator bootstrap and buyer registration. Routes own policy (throttling, Turnstile, password
 * rules); this file owns the statements and keeps each multi-statement change atomic.
 */

export type PortalKind = 'staff' | 'buyer';

export interface LoginUserRow {
  id: string;
  email: string;
  displayName: string;
  role: string;
  status: string;
  passwordHash: string | null;
  failed: number;
  lockedUntil: string | null;
  mustChange: number;
}

export interface SignedInUser {
  id: string;
  email: string;
  passwordHash: string | null;
  sessionId: string;
}

const AUDIT_USER =
  "INSERT INTO audit_logs (id,actor_user_id,actor_type,action,entity_type,entity_id,request_id,details_json,created_at) VALUES (?,?,?,?,'user',?,?,?,?)";
const AUDIT_USER_EMPTY =
  "INSERT INTO audit_logs (id,actor_user_id,actor_type,action,entity_type,entity_id,request_id,details_json,created_at) VALUES (?,?,?,?,'user',?,?,'{}',?)";
export const INSERT_SESSION =
  'INSERT INTO sessions (id,user_id,token_hash,created_at,last_seen_at,expires_at,session_type) VALUES (?,?,?,?,?,?,?)';

/* ------------------------------------------------------------- helpers */

export async function insertUserAudit(
  db: D1Database,
  p: {
    id: string;
    actorUserId: string | null;
    actorType: PortalKind | 'public';
    action: string;
    entityId: string;
    requestId: string;
    detailsJson: string;
    timestamp: string;
  },
): Promise<void> {
  await db
    .prepare(AUDIT_USER)
    .bind(p.id, p.actorUserId, p.actorType, p.action, p.entityId, p.requestId, p.detailsJson, p.timestamp)
    .run();
}

export async function findSignedInUser(
  db: D1Database,
  p: { tokenHash: string; kind: PortalKind; timestamp: string },
): Promise<SignedInUser | null> {
  return db
    .prepare(
      "SELECT u.id, u.email, u.password_hash AS passwordHash, s.id AS sessionId FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.session_type = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND u.user_type = ? AND u.status = 'active' LIMIT 1",
    )
    .bind(p.tokenHash, p.kind, p.timestamp, p.kind)
    .first<SignedInUser>();
}

export async function countStaff(db: D1Database): Promise<number> {
  return (
    (await db.prepare("SELECT COUNT(*) AS total FROM users WHERE user_type = 'staff'").first<{ total: number }>())
      ?.total ?? 0
  );
}

export async function countUnconfiguredStaff(db: D1Database): Promise<number> {
  return (
    (
      await db
        .prepare(
          "SELECT COUNT(*) AS total FROM users WHERE user_type = 'staff' AND status = 'active' AND password_hash IS NULL",
        )
        .first<{ total: number }>()
    )?.total ?? 0
  );
}

/* --------------------------------------------------------------- login */

export async function findUserForLogin(
  db: D1Database,
  email: string,
  kind: PortalKind,
): Promise<LoginUserRow | null> {
  return db
    .prepare(
      'SELECT id, email, display_name AS displayName, role, status, password_hash AS passwordHash, failed_login_count AS failed, locked_until AS lockedUntil, must_change_password AS mustChange FROM users WHERE email = ? COLLATE NOCASE AND user_type = ? LIMIT 1',
    )
    .bind(email, kind)
    .first<LoginUserRow>();
}

export async function recordFailedLogin(
  db: D1Database,
  p: { userId: string; failedCount: number; lockedUntil: string | null; timestamp: string },
): Promise<void> {
  await db
    .prepare('UPDATE users SET failed_login_count = ?, locked_until = ?, updated_at = ? WHERE id = ?')
    .bind(p.failedCount, p.lockedUntil, p.timestamp, p.userId)
    .run();
}

/** Atomic: clear lockout (optionally upgrading the hash), create the session and audit it. */
export async function completeLogin(
  db: D1Database,
  p: {
    userId: string;
    kind: PortalKind;
    rehashedPassword: string | null;
    sessionId: string;
    tokenHash: string;
    timestamp: string;
    expiresAt: string;
    auditId: string;
    action: string;
    requestId: string;
  },
): Promise<void> {
  await db.batch([
    p.rehashedPassword !== null
      ? db
          .prepare('UPDATE users SET failed_login_count = 0, locked_until = NULL, password_hash = ? WHERE id = ?')
          .bind(p.rehashedPassword, p.userId)
      : db
          .prepare('UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = ?')
          .bind(p.userId),
    db
      .prepare(INSERT_SESSION)
      .bind(p.sessionId, p.userId, p.tokenHash, p.timestamp, p.timestamp, p.expiresAt, p.kind),
    db
      .prepare(
        "INSERT INTO audit_logs (id,actor_user_id,actor_type,action,entity_type,entity_id,request_id,details_json,created_at) VALUES (?,?,?,?,'session',?,?,'{}',?)",
      )
      .bind(p.auditId, p.userId, p.kind, p.action, p.sessionId, p.requestId, p.timestamp),
  ]);
}

export async function revokeSessionByTokenHash(db: D1Database, tokenHash: string, timestamp: string): Promise<void> {
  await db
    .prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
    .bind(timestamp, tokenHash)
    .run();
}

/* ------------------------------------------------------ password reset */

export async function findActiveUserByEmail(
  db: D1Database,
  email: string,
  kind: PortalKind,
): Promise<{ id: string; email: string } | null> {
  return db
    .prepare(
      "SELECT id, email FROM users WHERE email = ? COLLATE NOCASE AND user_type = ? AND status = 'active' LIMIT 1",
    )
    .bind(email, kind)
    .first<{ id: string; email: string }>();
}

export async function findValidResetToken(
  db: D1Database,
  p: { tokenHash: string; kind: PortalKind; timestamp: string },
): Promise<{ id: string; userId: string; email: string } | null> {
  return db
    .prepare(
      "SELECT t.id, t.user_id AS userId, u.email FROM password_reset_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND t.used_at IS NULL AND t.expires_at > ? AND u.user_type = ? AND u.status = 'active' LIMIT 1",
    )
    .bind(p.tokenHash, p.timestamp, p.kind)
    .first<{ id: string; userId: string; email: string }>();
}

/** Compare-and-set: true only for the single caller that consumed the token. */
export async function consumeResetToken(db: D1Database, tokenId: string, timestamp: string): Promise<boolean> {
  const r = await db
    .prepare('UPDATE password_reset_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL')
    .bind(timestamp, tokenId)
    .run();
  return Boolean(r.meta.changes);
}

/** Atomic: set the new password, sign the user out everywhere, audit. */
export async function applyPasswordReset(
  db: D1Database,
  p: {
    userId: string;
    kind: PortalKind;
    passwordHash: string;
    timestamp: string;
    auditId: string;
    action: string;
    requestId: string;
  },
): Promise<void> {
  await db.batch([
    db
      .prepare(
        'UPDATE users SET password_hash = ?, password_updated_at = ?, must_change_password = 0, failed_login_count = 0, locked_until = NULL, updated_at = ? WHERE id = ?',
      )
      .bind(p.passwordHash, p.timestamp, p.timestamp, p.userId),
    db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').bind(p.timestamp, p.userId),
    db
      .prepare(AUDIT_USER_EMPTY)
      .bind(p.auditId, p.userId, p.kind, p.action, p.userId, p.requestId, p.timestamp),
  ]);
}

/** Atomic: replace the password, revoke every other session, audit. */
export async function applyPasswordChange(
  db: D1Database,
  p: {
    userId: string;
    kind: PortalKind;
    currentSessionId: string;
    passwordHash: string;
    timestamp: string;
    auditId: string;
    action: string;
    requestId: string;
  },
): Promise<void> {
  await db.batch([
    db
      .prepare(
        'UPDATE users SET password_hash = ?, password_updated_at = ?, must_change_password = 0, updated_at = ? WHERE id = ?',
      )
      .bind(p.passwordHash, p.timestamp, p.timestamp, p.userId),
    db
      .prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id != ? AND revoked_at IS NULL')
      .bind(p.timestamp, p.userId, p.currentSessionId),
    db
      .prepare(AUDIT_USER_EMPTY)
      .bind(p.auditId, p.userId, p.kind, p.action, p.userId, p.requestId, p.timestamp),
  ]);
}

/** Buyer-only first password (email-code accounts). Atomic with other-session revocation and audit. */
export async function applyBuyerSetPassword(
  db: D1Database,
  p: {
    userId: string;
    currentSessionId: string;
    passwordHash: string;
    timestamp: string;
    auditId: string;
    requestId: string;
  },
): Promise<void> {
  await db.batch([
    db
      .prepare(
        "UPDATE users SET password_hash = ?, password_updated_at = ?, must_change_password = 0, updated_at = ? WHERE id = ? AND user_type = 'buyer'",
      )
      .bind(p.passwordHash, p.timestamp, p.timestamp, p.userId),
    db
      .prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id != ? AND revoked_at IS NULL')
      .bind(p.timestamp, p.userId, p.currentSessionId),
    db
      .prepare(
        "INSERT INTO audit_logs (id,actor_user_id,actor_type,action,entity_type,entity_id,request_id,details_json,created_at) VALUES (?,?,?,'buyer.password_set','user',?,?, '{}',?)",
      )
      .bind(p.auditId, p.userId, 'buyer', p.userId, p.requestId, p.timestamp),
  ]);
}
