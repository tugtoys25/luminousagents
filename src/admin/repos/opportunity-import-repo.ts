/** SQL for the opportunity CSV import (updates existing records only; always returns them to private draft). */
export function findOpportunityRow(db: D1Database, opportunityId: string): Promise<Record<string, unknown> | null> {
  return db.prepare('SELECT * FROM opportunities WHERE id = ?').bind(opportunityId).first<Record<string, unknown>>();
}

export async function nextVersionNumber(db: D1Database, opportunityId: string): Promise<number> {
  const row = await db
    .prepare('SELECT COALESCE(MAX(version_number), 0) + 1 AS next FROM opportunity_versions WHERE opportunity_id = ?')
    .bind(opportunityId)
    .first<{ next: number }>();
  return row?.next ?? 1;
}

export async function slugInUseByOther(db: D1Database, slug: string, opportunityId: string): Promise<boolean> {
  const row = await db.prepare('SELECT id FROM opportunities WHERE slug = ? AND id != ?').bind(slug, opportunityId).first();
  return Boolean(row);
}

/** Only these columns may be written by an import; the column list is never taken from the CSV. */
export const IMPORTABLE_COLUMNS = [
  'title', 'country', 'opportunity_type', 'classification', 'labels_json', 'price_text', 'price_visibility',
  'summary', 'body_html', 'availability', 'seo_title', 'seo_description',
] as const;

export interface StagedImport {
  id: string;
  values: Record<string, unknown>;
  slug: string;
  snapshotJson: string;
  version: number;
  updatedAt: string;
  versionId: string;
  auditId: string;
}

/** One atomic batch for the whole file: update, version row and audit row per record. All or nothing. */
export async function applyImport(
  db: D1Database,
  items: StagedImport[],
  actor: { staffId: string; requestId: string },
): Promise<void> {
  const statements = items.flatMap((item) => {
    const columns = Object.keys(item.values);
    for (const column of columns) {
      if (!(IMPORTABLE_COLUMNS as readonly string[]).includes(column)) throw new Error(`Column not importable: ${column}`);
    }
    return [
      db
        .prepare(
          `UPDATE opportunities SET ${columns.map((column) => `${column} = ?`).join(', ')}, slug = ?, lifecycle = 'draft', content_review_status = 'pending', public_visibility = 0, updated_at = ? WHERE id = ?`,
        )
        .bind(...columns.map((column) => item.values[column]), item.slug, item.updatedAt, item.id),
      db
        .prepare(
          'INSERT INTO opportunity_versions (id, opportunity_id, version_number, snapshot_json, changed_by, change_reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(item.versionId, item.id, item.version, item.snapshotJson, actor.staffId, 'CSV import; returned to private draft for review', item.updatedAt),
      db
        .prepare(
          'INSERT INTO audit_logs (id, actor_user_id, actor_type, action, entity_type, entity_id, request_id, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(item.auditId, actor.staffId, 'staff', 'opportunity.imported', 'opportunity', item.id, actor.requestId, JSON.stringify({ source: 'csv', reviewReset: true }), item.updatedAt),
    ];
  });
  await db.batch(statements);
}
