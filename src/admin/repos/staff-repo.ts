/** SQL for staff accounts (super administrators only). */
type Row = Record<string, unknown>;

export interface StaffRecord {
  id: string;
  email: string;
  displayName: string;
  role: string;
  status: string;
}
export interface StaffContact {
  id: string;
  email: string;
}

export async function listStaff(db: D1Database): Promise<Row[]> {
  const result = await db
    .prepare(
      "SELECT id, email, display_name AS displayName, role, status, created_at AS createdAt, CASE WHEN password_hash IS NULL THEN 0 ELSE 1 END AS hasPassword, must_change_password AS mustChange FROM users WHERE user_type = 'staff' ORDER BY created_at LIMIT 300",
    )
    .all<Row>();
  return result.results ?? [];
}

export async function emailInUse(db: D1Database, email: string, exceptUserId?: string): Promise<boolean> {
  const row = exceptUserId
    ? await db
        .prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE AND id != ?')
        .bind(email, exceptUserId)
        .first()
    : await db.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE').bind(email).first();
  return Boolean(row);
}

export async function insertStaff(
  db: D1Database,
  s: { id: string; email: string; displayName: string; role: string; passwordHash: string | null; timestamp: string },
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO users (id,email,display_name,user_type,role,status,password_hash,password_updated_at,must_change_password,created_at,updated_at) VALUES (?,?,?,'staff',?,'active',?,?,?,?,?)",
    )
    .bind(
      s.id,
      s.email,
      s.displayName,
      s.role,
      s.passwordHash,
      s.passwordHash ? s.timestamp : null,
      s.passwordHash ? 1 : 0,
      s.timestamp,
      s.timestamp,
    )
    .run();
}

export function findStaff(db: D1Database, id: string): Promise<StaffRecord | null> {
  return db
    .prepare("SELECT id, email, display_name AS displayName, role, status FROM users WHERE id = ? AND user_type = 'staff'")
    .bind(id)
    .first<StaffRecord>();
}

export function findStaffContact(db: D1Database, id: string): Promise<StaffContact | null> {
  return db
    .prepare("SELECT id, email FROM users WHERE id = ? AND user_type = 'staff'")
    .bind(id)
    .first<StaffContact>();
}

export function findActiveStaffContact(db: D1Database, id: string): Promise<StaffContact | null> {
  return db
    .prepare("SELECT id, email FROM users WHERE id = ? AND user_type = 'staff' AND status = 'active'")
    .bind(id)
    .first<StaffContact>();
}

/** Account change and (for security-relevant changes) session revocation commit together. */
export async function updateStaffAndRevoke(
  db: D1Database,
  u: { id: string; role: string; status: string; displayName: string; email: string; securityChange: boolean; timestamp: string },
): Promise<void> {
  await db.batch([
    db
      .prepare("UPDATE users SET role = ?, status = ?, display_name = ?, email = ?, updated_at = ? WHERE id = ? AND user_type = 'staff'")
      .bind(u.role, u.status, u.displayName, u.email, u.timestamp, u.id),
    db
      .prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND ? = 1')
      .bind(u.timestamp, u.id, u.securityChange ? 1 : 0),
  ]);
}

export async function isActiveStaff(db: D1Database, userId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT id FROM users WHERE id = ? AND user_type = 'staff' AND status = 'active'")
    .bind(userId)
    .first();
  return Boolean(row);
}
