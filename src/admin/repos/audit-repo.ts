/** SQL for audit log listing and export. `filterSql` is built from fixed fragments only; values are always bound. */
export interface AuditFilter {
  filterSql: string;
  binds: unknown[];
}
export interface AuditExportRow {
  id: string;
  createdAt: string;
  actorEmail: string | null;
  actorType: string;
  action: string;
  entityType: string;
  entityId: string;
  requestId: string | null;
  details: string | null;
}

export async function exportAuditRows(db: D1Database, f: AuditFilter): Promise<AuditExportRow[]> {
  const result = await db
    .prepare(
      `SELECT a.id, a.created_at AS createdAt, u.email AS actorEmail, a.actor_type AS actorType, a.action, a.entity_type AS entityType, a.entity_id AS entityId, a.request_id AS requestId, a.details_json AS details FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id${f.filterSql} ORDER BY a.created_at DESC, a.id DESC LIMIT 5001`,
    )
    .bind(...f.binds)
    .all<AuditExportRow>();
  return result.results ?? [];
}

export async function countAudit(db: D1Database, f: AuditFilter): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS total FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id${f.filterSql}`)
    .bind(...f.binds)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

export async function pageAudit(db: D1Database, f: AuditFilter, limit: number, offset: number): Promise<unknown[]> {
  const result = await db
    .prepare(
      `SELECT a.id, a.action, a.entity_type AS entityType, a.entity_id AS entityId, a.details_json AS details, a.created_at AS createdAt, u.email AS actorEmail FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id${f.filterSql} ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?`,
    )
    .bind(...f.binds, limit, offset)
    .all();
  return result.results ?? [];
}
