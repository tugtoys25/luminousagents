/** SQL for data-room documents (metadata only; file bytes live in private R2). */
export async function opportunityExists(db: D1Database, opportunityId: string): Promise<boolean> {
  const row = await db.prepare('SELECT id FROM opportunities WHERE id = ?').bind(opportunityId).first();
  return Boolean(row);
}

export interface NewDocument {
  id: string;
  opportunityId: string;
  r2Key: string;
  filename: string;
  contentType: string;
  byteSize: number;
  tier: number;
  uploadedBy: string;
  timestamp: string;
  sha256: string;
  /** True when the scanner is disabled: the row is stored as clean with the skip provider. */
  scanSkipped: boolean;
  skipProvider: string;
  auditId: string;
  requestId: string;
}

/** Document row and its audit row commit atomically; callers delete the R2 object if this throws. */
export async function insertDocumentWithAudit(db: D1Database, d: NewDocument): Promise<void> {
  const scanSkipped = d.scanSkipped;
  await db.batch([
    db
      .prepare(
        'INSERT INTO documents (id, opportunity_id, r2_key, filename, content_type, byte_size, tier, uploaded_by, created_at, sha256, scan_status, scan_provider, scan_job_id, scan_verdict, scan_digest, scanned_at, scan_engine_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        d.id,
        d.opportunityId,
        d.r2Key,
        d.filename,
        d.contentType,
        d.byteSize,
        d.tier,
        d.uploadedBy,
        d.timestamp,
        d.sha256,
        scanSkipped ? 'clean' : 'pending',
        scanSkipped ? d.skipProvider : null,
        scanSkipped ? `skipped-${d.id}` : null,
        scanSkipped ? 'clean' : null,
        scanSkipped ? d.sha256 : null,
        scanSkipped ? d.timestamp : null,
        scanSkipped ? 'scanner-disabled' : null,
      ),
    db
      .prepare(
        "INSERT INTO audit_logs (id, actor_user_id, actor_type, action, entity_type, entity_id, request_id, details_json, created_at) VALUES (?, ?, 'staff', 'document.uploaded', 'document', ?, ?, ?, ?)",
      )
      .bind(
        d.auditId,
        d.uploadedBy,
        d.id,
        d.requestId,
        JSON.stringify({
          opportunityId: d.opportunityId,
          byteSize: d.byteSize,
          tier: d.tier,
          contentType: d.contentType,
          scanSkipped,
        }),
        d.timestamp,
      ),
  ]);
}

type Row = Record<string, unknown>;

export async function listDocuments(db: D1Database, opportunityId: string): Promise<Row[]> {
  const rows = await db
    .prepare(
      `SELECT d.id, d.opportunity_id AS opportunityId, d.filename, d.content_type AS contentType,
      d.byte_size AS byteSize, d.tier, d.scan_status AS scanStatus, d.sha256,
      d.scan_provider AS scanProvider, d.scanned_at AS scannedAt, d.created_at AS createdAt,
      o.title AS opportunityTitle
     FROM documents d JOIN opportunities o ON o.id = d.opportunity_id
     WHERE (? = '' OR d.opportunity_id = ?)
     ORDER BY d.created_at DESC LIMIT 200`,
    )
    .bind(opportunityId, opportunityId)
    .all<Row>();
  return rows.results ?? [];
}

export async function settingUpdatedAt(db: D1Database, key: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT updated_at AS updatedAt FROM platform_settings WHERE setting_key = ?')
    .bind(key)
    .first<{ updatedAt: string }>();
  return row?.updatedAt ?? null;
}

export async function countPendingDocuments(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS total FROM documents WHERE scan_status = 'pending'")
    .first<{ total: number }>();
  return row?.total ?? 0;
}

/**
 * Scanner mode change, optional release of pending documents (only when scanning is switched off)
 * and the audit row commit in one batch.
 */
export async function changeScannerMode(
  db: D1Database,
  c: {
    settingKey: string;
    mode: string;
    staffId: string;
    timestamp: string;
    releasePending: boolean;
    skipProvider: string;
    auditId: string;
    requestId: string;
    auditDetails: Record<string, unknown>;
  },
): Promise<void> {
  const statements = [
    db
      .prepare(
        'INSERT INTO platform_settings (setting_key,value_json,updated_by,updated_at) VALUES (?,?,?,?) ON CONFLICT(setting_key) DO UPDATE SET value_json=excluded.value_json,updated_by=excluded.updated_by,updated_at=excluded.updated_at',
      )
      .bind(c.settingKey, JSON.stringify(c.mode), c.staffId, c.timestamp),
  ];
  if (c.releasePending)
    statements.push(
      db
        .prepare(
          "UPDATE documents SET scan_status = 'clean', scan_provider = ?, scan_job_id = 'skipped-' || id, scan_verdict = 'clean', scan_digest = sha256, scanned_at = ?, scan_engine_version = 'scanner-disabled' WHERE scan_status = 'pending'",
        )
        .bind(c.skipProvider, c.timestamp),
    );
  statements.push(
    db
      .prepare(
        "INSERT INTO audit_logs (id,actor_user_id,actor_type,action,entity_type,entity_id,request_id,details_json,created_at) VALUES (?,?,'staff','platform.scanner_mode_changed','platform_settings',?,?,?,?)",
      )
      .bind(c.auditId, c.staffId, c.settingKey, c.requestId, JSON.stringify(c.auditDetails), c.timestamp),
  );
  await db.batch(statements);
}
