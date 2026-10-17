/** SQL for buyer email-code sign-in: challenge lifecycle, attempt counting and compare-and-set consume. */

import { INSERT_SESSION } from './portal-repo';

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
