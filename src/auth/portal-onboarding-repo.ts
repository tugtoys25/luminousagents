/** SQL for first-administrator bootstrap and buyer registration. */

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
