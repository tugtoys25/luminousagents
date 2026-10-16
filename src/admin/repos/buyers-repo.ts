/** SQL for staff-side buyer account management. */
type Row = Record<string, unknown>;

export interface BuyerRef {
  id: string;
  status: string;
}
export interface BuyerContact extends BuyerRef {
  email: string;
}
export interface ExistingAccount {
  id: string;
  userType: string;
  status: string;
}
export interface AuditArgs {
  auditId: string;
  staffId: string;
  requestId: string;
  timestamp: string;
}

export async function listBuyers(db: D1Database): Promise<Row[]> {
  const result = await db
    .prepare(
      "SELECT u.id, u.email, u.display_name AS displayName, u.status, u.created_at AS createdAt, p.company_name AS companyName, p.role_title AS roleTitle, u.must_change_password AS mustChange, CASE WHEN u.password_hash IS NULL THEN 0 ELSE 1 END AS hasPassword FROM users u LEFT JOIN buyer_profiles p ON p.user_id = u.id WHERE u.user_type = 'buyer' ORDER BY CASE u.status WHEN 'invited' THEN 0 WHEN 'active' THEN 1 ELSE 2 END, u.created_at DESC LIMIT 300",
    )
    .all<Row>();
  return result.results ?? [];
}

export function findBuyer(db: D1Database, id: string): Promise<BuyerRef | null> {
  return db
    .prepare("SELECT id, status FROM users WHERE id = ? AND user_type = 'buyer'")
    .bind(id)
    .first<BuyerRef>();
}

export function findBuyerContact(db: D1Database, id: string): Promise<BuyerContact | null> {
  return db
    .prepare("SELECT id, email, status FROM users WHERE id = ? AND user_type = 'buyer'")
    .bind(id)
    .first<BuyerContact>();
}

export function findActiveBuyerContact(db: D1Database, id: string): Promise<{ id: string; email: string } | null> {
  return db
    .prepare("SELECT id, email FROM users WHERE id = ? AND user_type = 'buyer' AND status = 'active'")
    .bind(id)
    .first<{ id: string; email: string }>();
}

/** Status change, session revocation (for any non-active status) and audit row commit together. */
export async function setBuyerStatus(
  db: D1Database,
  b: AuditArgs & { buyerId: string; from: string; to: string },
): Promise<void> {
  await db.batch([
    db
      .prepare("UPDATE users SET status = ?, updated_at = ? WHERE id = ? AND user_type = 'buyer'")
      .bind(b.to, b.timestamp, b.buyerId),
    db
      .prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND ? != 'active'")
      .bind(b.timestamp, b.buyerId, b.to),
    db
      .prepare(
        "INSERT INTO audit_logs (id, actor_user_id, actor_type, action, entity_type, entity_id, request_id, details_json, created_at) VALUES (?, ?, 'staff', 'buyer.status_changed', 'user', ?, ?, ?, ?)",
      )
      .bind(b.auditId, b.staffId, b.buyerId, b.requestId, JSON.stringify({ from: b.from, to: b.to }), b.timestamp),
  ]);
}

export function findAccountByEmail(db: D1Database, email: string): Promise<ExistingAccount | null> {
  return db
    .prepare('SELECT id, user_type AS userType, status FROM users WHERE email = ? COLLATE NOCASE')
    .bind(email)
    .first<ExistingAccount>();
}

/**
 * Activates an invited buyer. The audit row is inserted with `WHERE changes() > 0`, so it exists
 * only if the UPDATE really changed a row (the two statements must stay adjacent in one batch).
 * Returns whether the account is active afterwards.
 */
export async function activateInvitedBuyer(
  db: D1Database,
  b: AuditArgs & { buyerId: string; displayName: string; auditDetails: string },
): Promise<boolean> {
  await db.batch([
    db
      .prepare(
        "UPDATE users SET display_name = ?, status = 'active', updated_at = ? WHERE id = ? AND user_type = 'buyer' AND status = 'invited'",
      )
      .bind(b.displayName, b.timestamp, b.buyerId),
    db
      .prepare(
        "INSERT INTO audit_logs (id, actor_user_id, actor_type, action, entity_type, entity_id, request_id, details_json, created_at) SELECT ?, ?, 'staff', 'buyer.provisioned', 'user', ?, ?, ?, ? WHERE changes() > 0",
      )
      .bind(b.auditId, b.staffId, b.buyerId, b.requestId, b.auditDetails, b.timestamp),
  ]);
  const activated = await db
    .prepare("SELECT id FROM users WHERE id = ? AND status = 'active' AND user_type = 'buyer'")
    .bind(b.buyerId)
    .first();
  return Boolean(activated);
}

export async function createActiveBuyer(
  db: D1Database,
  b: AuditArgs & { buyerId: string; email: string; displayName: string; auditDetails: string },
): Promise<void> {
  await db.batch([
    db
      .prepare(
        "INSERT INTO users (id, email, display_name, user_type, role, status, created_at, updated_at) VALUES (?, ?, ?, 'buyer', 'buyer', 'active', ?, ?)",
      )
      .bind(b.buyerId, b.email, b.displayName, b.timestamp, b.timestamp),
    db
      .prepare(
        "INSERT INTO audit_logs (id, actor_user_id, actor_type, action, entity_type, entity_id, request_id, details_json, created_at) VALUES (?, ?, 'staff', 'buyer.provisioned', 'user', ?, ?, ?, ?)",
      )
      .bind(b.auditId, b.staffId, b.buyerId, b.requestId, b.auditDetails, b.timestamp),
  ]);
}
