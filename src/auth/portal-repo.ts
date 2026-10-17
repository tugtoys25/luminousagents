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

export interface EmailCodeRow {
  challengeId: string;
  codeHash: string;
  expiresAt: string;
  attempts: number;
  id: string;
  email: string;
  displayName: string;
  status: string;
  mustChange: number;
}

const AUDIT_USER =
  "INSERT INTO audit_logs (id,actor_user_id,actor_type,action,entity_type,entity_id,request_id,details_json,created_at) VALUES (?,?,?,?,'user',?,?,?,?)";
const AUDIT_USER_EMPTY =
  "INSERT INTO audit_logs (id,actor_user_id,actor_type,action,entity_type,entity_id,request_id,details_json,created_at) VALUES (?,?,?,?,'user',?,?,'{}',?)";
const INSERT_SESSION =
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

/* ------------------------------------------------------- buyer email codes */

export async function findActiveBuyerByEmail(
  db: D1Database,
  email: string,
): Promise<{ id: string; email: string } | null> {
  return db
    .prepare(
      "SELECT id, email FROM users WHERE email = ? COLLATE NOCASE AND user_type = 'buyer' AND status = 'active' LIMIT 1",
    )
    .bind(email)
    .first<{ id: string; email: string }>();
}

export async function invalidateOpenEmailCodes(db: D1Database, userId: string, timestamp: string): Promise<void> {
  await db
    .prepare('UPDATE buyer_email_codes SET used_at = ? WHERE user_id = ? AND used_at IS NULL')
    .bind(timestamp, userId)
    .run();
}

export async function insertEmailCode(
  db: D1Database,
  p: { id: string; userId: string; codeHash: string; expiresAt: string; timestamp: string },
): Promise<void> {
  await db
    .prepare('INSERT INTO buyer_email_codes (id,user_id,code_hash,expires_at,attempts,created_at) VALUES (?,?,?,?,0,?)')
    .bind(p.id, p.userId, p.codeHash, p.expiresAt, p.timestamp)
    .run();
}

export async function markEmailCodeUsed(db: D1Database, challengeId: string, timestamp: string): Promise<void> {
  await db.prepare('UPDATE buyer_email_codes SET used_at = ? WHERE id = ?').bind(timestamp, challengeId).run();
}

export async function findLatestEmailCode(db: D1Database, email: string): Promise<EmailCodeRow | null> {
  return db
    .prepare(
      "SELECT c.id AS challengeId,c.code_hash AS codeHash,c.expires_at AS expiresAt,c.attempts,u.id,u.email,u.display_name AS displayName,u.status,u.must_change_password AS mustChange FROM buyer_email_codes c JOIN users u ON u.id=c.user_id WHERE u.email = ? COLLATE NOCASE AND u.user_type='buyer' AND c.used_at IS NULL ORDER BY c.created_at DESC LIMIT 1",
    )
    .bind(email)
    .first<EmailCodeRow>();
}

export async function closeOpenEmailCode(db: D1Database, challengeId: string, timestamp: string): Promise<void> {
  await db
    .prepare('UPDATE buyer_email_codes SET used_at = ? WHERE id = ? AND used_at IS NULL')
    .bind(timestamp, challengeId)
    .run();
}

/** Wrong code: count the attempt and burn the challenge on the fifth. */
export async function recordEmailCodeMiss(db: D1Database, challengeId: string, timestamp: string): Promise<void> {
  await db
    .prepare(
      'UPDATE buyer_email_codes SET attempts = attempts + 1, used_at = CASE WHEN attempts + 1 >= 5 THEN ? ELSE used_at END WHERE id = ? AND used_at IS NULL',
    )
    .bind(timestamp, challengeId)
    .run();
}

/** Compare-and-set: true only if the challenge was still open, unexpired and under the attempt limit. */
export async function consumeEmailCode(db: D1Database, challengeId: string, timestamp: string): Promise<boolean> {
  const r = await db
    .prepare('UPDATE buyer_email_codes SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ? AND attempts < 5')
    .bind(timestamp, challengeId, timestamp)
    .run();
  return (r.meta?.changes ?? 0) === 1;
}

/** Atomic: create the buyer session and audit the email-code sign-in. */
export async function createEmailCodeSession(
  db: D1Database,
  p: {
    userId: string;
    sessionId: string;
    tokenHash: string;
    timestamp: string;
    expiresAt: string;
    auditId: string;
    requestId: string;
  },
): Promise<void> {
  await db.batch([
    db
      .prepare(INSERT_SESSION)
      .bind(p.sessionId, p.userId, p.tokenHash, p.timestamp, p.timestamp, p.expiresAt, 'buyer'),
    db
      .prepare(
        "INSERT INTO audit_logs (id,actor_user_id,actor_type,action,entity_type,entity_id,request_id,details_json,created_at) VALUES (?,?,?,'buyer.email_code_login','session',?,?, '{}',?)",
      )
      .bind(p.auditId, p.userId, 'buyer', p.sessionId, p.requestId, p.timestamp),
  ]);
}

/* ------------------------------------------------- first administrator */

export async function findUnconfiguredStaffByEmail(db: D1Database, email: string): Promise<{ id: string } | null> {
  return db
    .prepare(
      "SELECT id FROM users WHERE email = ? COLLATE NOCASE AND user_type = 'staff' AND status = 'active' AND password_hash IS NULL LIMIT 1",
    )
    .bind(email)
    .first<{ id: string }>();
}

/** Credential migration; only ever touches a staff account that still has no password. */
export async function provisionStaffPassword(
  db: D1Database,
  p: { userId: string; passwordHash: string; timestamp: string },
): Promise<boolean> {
  const r = await db
    .prepare(
      "UPDATE users SET password_hash = ?, password_updated_at = ?, must_change_password = 0, failed_login_count = 0, locked_until = NULL, updated_at = ? WHERE id = ? AND user_type = 'staff' AND status = 'active' AND password_hash IS NULL",
    )
    .bind(p.passwordHash, p.timestamp, p.timestamp, p.userId)
    .run();
  return Boolean(r.meta.changes);
}

/**
 * Atomic: create the super administrator only while no staff row exists (NOT EXISTS guard in the INSERT itself,
 * so two racing requests cannot both succeed) and audit it only if that row was really created.
 */
export async function insertFirstAdmin(
  db: D1Database,
  p: {
    userId: string;
    email: string;
    displayName: string;
    passwordHash: string;
    timestamp: string;
    auditId: string;
    requestId: string;
  },
): Promise<void> {
  await db.batch([
    db
      .prepare(
        "INSERT INTO users (id,email,display_name,user_type,role,status,password_hash,password_updated_at,created_at,updated_at) SELECT ?, ?, ?, 'staff', 'super_admin', 'active', ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM users WHERE user_type = 'staff')",
      )
      .bind(p.userId, p.email, p.displayName, p.passwordHash, p.timestamp, p.timestamp, p.timestamp),
    db
      .prepare(
        "INSERT INTO audit_logs (id,actor_user_id,actor_type,action,entity_type,entity_id,request_id,details_json,created_at) SELECT ?, ?, 'staff', 'staff.first_admin_bootstrapped', 'user', ?, ?, '{}', ? WHERE EXISTS (SELECT 1 FROM users WHERE id = ? AND user_type = 'staff')",
      )
      .bind(p.auditId, p.userId, p.userId, p.requestId, p.timestamp, p.userId),
  ]);
}

export async function staffUserExists(db: D1Database, userId: string): Promise<boolean> {
  return Boolean(await db.prepare("SELECT id FROM users WHERE id = ? AND user_type = 'staff'").bind(userId).first());
}

/* ------------------------------------------------------ buyer registration */

export async function emailTaken(db: D1Database, email: string): Promise<boolean> {
  return Boolean(await db.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE').bind(email).first());
}

/** Atomic: invited buyer, profile with privacy consent, public audit row and the staff review job. */
export async function insertBuyerRegistration(
  db: D1Database,
  p: {
    userId: string;
    email: string;
    displayName: string;
    passwordHash: string | null;
    companyName: string;
    roleTitle: string;
    experienceNotes: string;
    privacyVersion: string;
    timestamp: string;
    auditId: string;
    requestId: string;
    auditDetailsJson: string;
    jobId: string;
    jobPayloadJson: string;
  },
): Promise<void> {
  await db.batch([
    db
      .prepare(
        "INSERT INTO users (id,email,display_name,user_type,role,status,password_hash,password_updated_at,created_at,updated_at) VALUES (?,?,?,'buyer','buyer','invited',?,?,?,?)",
      )
      .bind(
        p.userId,
        p.email,
        p.displayName,
        p.passwordHash,
        p.passwordHash ? p.timestamp : null,
        p.timestamp,
        p.timestamp,
      ),
    db
      .prepare(
        'INSERT INTO buyer_profiles (user_id,company_name,role_title,experience_notes,updated_at,privacy_consent_at,privacy_notice_version) VALUES (?,?,?,?,?,?,?)',
      )
      .bind(p.userId, p.companyName, p.roleTitle, p.experienceNotes, p.timestamp, p.timestamp, p.privacyVersion),
    db
      .prepare(
        "INSERT INTO audit_logs (id,actor_user_id,actor_type,action,entity_type,entity_id,request_id,details_json,created_at) VALUES (?,NULL,'public','buyer.registration_submitted','user',?,?,?,?)",
      )
      .bind(p.auditId, p.userId, p.requestId, p.auditDetailsJson, p.timestamp),
    db
      .prepare(
        "INSERT INTO notification_jobs (id,job_type,payload_json,status,attempts,available_at,created_at,updated_at) VALUES (?,'buyer.registration_review',?,'queued',0,?,?,?)",
      )
      .bind(p.jobId, p.jobPayloadJson, p.timestamp, p.timestamp, p.timestamp),
  ]);
}
