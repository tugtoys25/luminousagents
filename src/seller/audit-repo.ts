/** Shared audit statement builders for seller entities. Rows are written inside the caller's D1 batch. */
export interface AuditRow { id: string; actorId: string | null; action: string; entityType: string; entityId: string; requestId: string; details: Record<string, unknown>; ts: string }

const COLS = 'INSERT INTO audit_logs (id, actor_user_id, actor_type, action, entity_type, entity_id, request_id, details_json, created_at)';

/** Unconditional audit insert. */
export const auditStmt = (db: D1Database, a: AuditRow): D1PreparedStatement =>
  db.prepare(`${COLS} VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(a.id, a.actorId, a.actorId ? 'staff' : 'system', a.action, a.entityType, a.entityId, a.requestId, JSON.stringify(a.details), a.ts);

/** Audit insert that only writes when the immediately preceding statement in the batch changed a row. */
export const auditIfChangedStmt = (db: D1Database, a: AuditRow): D1PreparedStatement =>
  db.prepare(`${COLS} SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() > 0`).bind(a.id, a.actorId, a.actorId ? 'staff' : 'system', a.action, a.entityType, a.entityId, a.requestId, JSON.stringify(a.details), a.ts);

export async function listAuditForEntity(db: D1Database, entityType: string, entityId: string): Promise<Array<Record<string, unknown>>> {
  const r = await db
    .prepare('SELECT a.action, a.actor_type AS actorType, a.created_at AS createdAt, u.display_name AS actorName FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id WHERE a.entity_type = ? AND a.entity_id = ? ORDER BY a.created_at DESC, a.id DESC LIMIT 100')
    .bind(entityType, entityId)
    .all<Record<string, unknown>>();
  return r.results ?? [];
}

/** A refused request to a seller route. Stores the route PATTERN (never raw identifiers) and the actor's role. */
export async function recordDenial(db: D1Database, d: { id: string; actorId: string; role: string; method: string; routePath: string; code: string; requestId: string; ts: string }): Promise<void> {
  await auditStmt(db, { id: d.id, actorId: d.actorId, action: d.code === 'STEP_UP_REQUIRED' ? 'seller.step_up_required' : 'seller.permission_denied', entityType: 'seller_access', entityId: d.routePath.slice(0, 120), requestId: d.requestId, details: { method: d.method, role: d.role, code: d.code }, ts: d.ts }).run();
}
