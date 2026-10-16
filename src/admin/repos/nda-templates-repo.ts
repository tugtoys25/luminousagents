/** SQL for NDA template versions. Template text lives in private R2; D1 holds metadata and the content hash. */
type Row = Record<string, unknown>;

export interface NdaTemplateRecord {
  id: string;
  name: string;
  version: number;
  r2Key: string | null;
  contentHash: string;
  status: string;
}

export async function listTemplates(db: D1Database): Promise<Row[]> {
  const rows = await db
    .prepare(
      'SELECT id, name, version, r2_key AS r2Key, content_hash AS contentHash, status, created_at AS createdAt FROM nda_templates ORDER BY version DESC',
    )
    .all<Row>();
  return rows.results ?? [];
}

/** Latest version number for a template name (0 when none exists). */
export async function latestTemplateVersion(db: D1Database, name: string): Promise<number> {
  const latest = await db
    .prepare('SELECT COALESCE(MAX(version), 0) AS version FROM nda_templates WHERE name = ?')
    .bind(name)
    .first<{ version: number }>();
  return latest?.version ?? 0;
}

/**
 * Creates a template version and its audit row in one batch. With `activate`, the currently
 * active template is retired in the same batch so exactly one template is ever active.
 */
export async function createTemplateVersion(
  db: D1Database,
  t: {
    id: string;
    name: string;
    version: number;
    r2Key: string;
    contentHash: string;
    activate: boolean;
    staffId: string;
    timestamp: string;
    auditId: string;
    requestId: string;
  },
): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  if (t.activate) statements.push(db.prepare("UPDATE nda_templates SET status = 'retired' WHERE status = 'active'").bind());
  statements.push(
    db
      .prepare(
        'INSERT INTO nda_templates (id, name, version, r2_key, content_hash, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(t.id, t.name, t.version, t.r2Key, t.contentHash, t.activate ? 'active' : 'draft', t.staffId, t.timestamp),
    db
      .prepare(
        "INSERT INTO audit_logs (id, actor_user_id, actor_type, action, entity_type, entity_id, request_id, details_json, created_at) VALUES (?, ?, 'staff', 'nda.template.created', 'nda_template', ?, ?, ?, ?)",
      )
      .bind(
        t.auditId,
        t.staffId,
        t.id,
        t.requestId,
        JSON.stringify({ name: t.name, version: t.version, contentHash: t.contentHash, activated: t.activate }),
        t.timestamp,
      ),
  );
  await db.batch(statements);
}

export function findTemplate(db: D1Database, id: string): Promise<NdaTemplateRecord | null> {
  return db
    .prepare('SELECT id, name, version, r2_key AS r2Key, content_hash AS contentHash, status FROM nda_templates WHERE id = ?')
    .bind(id)
    .first<NdaTemplateRecord>();
}

/** Retires the active template, activates this one (draft or retired only) and audits, atomically. */
export async function activateTemplate(
  db: D1Database,
  a: { templateId: string; version: number; contentHash: string; staffId: string; timestamp: string; auditId: string; requestId: string },
): Promise<void> {
  await db.batch([
    db.prepare("UPDATE nda_templates SET status = 'retired' WHERE status = 'active'").bind(),
    db.prepare("UPDATE nda_templates SET status = 'active' WHERE id = ? AND status IN ('draft','retired')").bind(a.templateId),
    db
      .prepare(
        "INSERT INTO audit_logs (id, actor_user_id, actor_type, action, entity_type, entity_id, request_id, details_json, created_at) VALUES (?, ?, 'staff', 'nda.template.activated', 'nda_template', ?, ?, ?, ?)",
      )
      .bind(a.auditId, a.staffId, a.templateId, a.requestId, JSON.stringify({ version: a.version, contentHash: a.contentHash }), a.timestamp),
  ]);
}
