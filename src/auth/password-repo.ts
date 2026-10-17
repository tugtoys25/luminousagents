/** SQL for password resets, invites and staff-issued temporary passwords. */

/**
 * Atomic: invalidate older unused tokens, store the new token HASH (never the raw token) and queue the email job.
 * The raw token only ever leaves in the (encrypted) job payload.
 */
export async function storeResetToken(
  db: D1Database,
  p: {
    userId: string;
    tokenId: string;
    tokenHash: string;
    purpose: 'reset' | 'invite';
    expiresAt: string;
    timestamp: string;
    jobId: string;
    encryptedPayload: string;
  },
): Promise<void> {
  await db.batch([
    db.prepare('UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL').bind(p.timestamp, p.userId),
    db
      .prepare('INSERT INTO password_reset_tokens (id, user_id, token_hash, purpose, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(p.tokenId, p.userId, p.tokenHash, p.purpose, p.expiresAt, p.timestamp),
    db
      .prepare(
        "INSERT INTO notification_jobs (id, job_type, payload_json, status, attempts, available_at, created_at, updated_at) VALUES (?, 'auth.password_reset', ?, 'queued', 0, ?, ?, ?)",
      )
      .bind(p.jobId, p.encryptedPayload, p.timestamp, p.timestamp, p.timestamp),
  ]);
}

/**
 * Atomic: set the new hash, force a change at next sign-in, clear lockout, sign the person out everywhere
 * and cancel any outstanding reset links.
 */
export async function setTemporaryPassword(
  db: D1Database,
  p: { userId: string; kind: 'staff' | 'buyer'; passwordHash: string; timestamp: string },
): Promise<void> {
  await db.batch([
    db
      .prepare(
        'UPDATE users SET password_hash = ?, password_updated_at = ?, must_change_password = 1, failed_login_count = 0, locked_until = NULL, updated_at = ? WHERE id = ? AND user_type = ?',
      )
      .bind(p.passwordHash, p.timestamp, p.timestamp, p.userId, p.kind),
    db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').bind(p.timestamp, p.userId),
    db.prepare('UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL').bind(p.timestamp, p.userId),
  ]);
}
