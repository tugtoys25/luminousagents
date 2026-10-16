/** Persistence for staff MFA. The only place MFA SQL lives. */

export interface MfaRow {
  userId: string;
  secretEnc: string;
  enabledAt: string | null;
  lastUsedStep: number | null;
  recoveryHashes: string;
}

export interface MfaDb {
  DB: D1Database;
}

export async function getMfa(env: MfaDb, userId: string): Promise<MfaRow | null> {
  return env.DB.prepare(
    'SELECT user_id AS userId, secret_enc AS secretEnc, enabled_at AS enabledAt, last_used_step AS lastUsedStep, recovery_hashes AS recoveryHashes FROM staff_mfa WHERE user_id = ? LIMIT 1',
  )
    .bind(userId)
    .first<MfaRow>();
}

/** Creates or replaces a PENDING enrolment. Never touches an enabled one. */
export async function savePendingSecret(
  env: MfaDb,
  userId: string,
  secretEnc: string,
  at: string,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `INSERT INTO staff_mfa (user_id, secret_enc, enabled_at, last_used_step, recovery_hashes, created_at, updated_at)
     VALUES (?, ?, NULL, NULL, '[]', ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET secret_enc = excluded.secret_enc, updated_at = excluded.updated_at
     WHERE staff_mfa.enabled_at IS NULL`,
  )
    .bind(userId, secretEnc, at, at)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

/** Turns a pending enrolment on. Returns false if it was already enabled or removed meanwhile. */
export async function activate(
  env: MfaDb,
  userId: string,
  step: number,
  recoveryHashes: string[],
  at: string,
): Promise<boolean> {
  const result = await env.DB.prepare(
    'UPDATE staff_mfa SET enabled_at = ?, last_used_step = ?, recovery_hashes = ?, updated_at = ? WHERE user_id = ? AND enabled_at IS NULL',
  )
    .bind(at, step, JSON.stringify(recoveryHashes), at, userId)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

/** Compare-and-set: succeeds for exactly one caller per time step (replay protection). */
export async function advanceStep(env: MfaDb, userId: string, step: number, at: string): Promise<boolean> {
  const result = await env.DB.prepare(
    'UPDATE staff_mfa SET last_used_step = ?, updated_at = ? WHERE user_id = ? AND enabled_at IS NOT NULL AND (last_used_step IS NULL OR last_used_step < ?)',
  )
    .bind(step, at, userId, step)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

/** Compare-and-set on the previous JSON so a recovery code can be spent only once. */
export async function replaceRecoveryHashes(
  env: MfaDb,
  userId: string,
  previousJson: string,
  next: string[],
  at: string,
): Promise<boolean> {
  const result = await env.DB.prepare(
    'UPDATE staff_mfa SET recovery_hashes = ?, updated_at = ? WHERE user_id = ? AND recovery_hashes = ?',
  )
    .bind(JSON.stringify(next), at, userId, previousJson)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function deleteMfa(env: MfaDb, userId: string): Promise<boolean> {
  const result = await env.DB.prepare('DELETE FROM staff_mfa WHERE user_id = ?').bind(userId).run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function markSessionVerified(env: MfaDb, sessionId: string, at: string): Promise<void> {
  await env.DB.prepare('UPDATE sessions SET mfa_at = ? WHERE id = ? AND revoked_at IS NULL')
    .bind(at, sessionId)
    .run();
}

export async function revokeStaffSessions(env: MfaDb, userId: string, at: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND session_type = 'staff' AND revoked_at IS NULL",
  )
    .bind(at, userId)
    .run();
}

export async function targetUser(
  env: MfaDb,
  userId: string,
): Promise<{ id: string; role: string } | null> {
  return env.DB.prepare("SELECT id, role FROM users WHERE id = ? AND user_type = 'staff' LIMIT 1")
    .bind(userId)
    .first<{ id: string; role: string }>();
}

export async function audit(
  env: MfaDb,
  entry: {
    actorUserId: string | null;
    action: string;
    entityId: string;
    requestId: string;
    details?: Record<string, unknown>;
    at: string;
  },
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO audit_logs (id,actor_user_id,actor_type,action,entity_type,entity_id,request_id,details_json,created_at) VALUES (?,?,'staff',?,'user',?,?,?,?)",
  )
    .bind(
      crypto.randomUUID(),
      entry.actorUserId,
      entry.action,
      entry.entityId,
      entry.requestId,
      JSON.stringify(entry.details ?? {}),
      entry.at,
    )
    .run();
}
