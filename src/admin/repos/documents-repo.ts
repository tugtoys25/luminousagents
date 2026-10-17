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

export interface DocumentForScan {
  id: string;
  opportunityId: string;
  r2Key: string;
  contentType: string;
  sha256: string;
  scanStatus: string;
}

export function findDocumentForScan(db: D1Database, documentId: string): Promise<DocumentForScan | null> {
  return db
    .prepare(
      'SELECT id, opportunity_id AS opportunityId, r2_key AS r2Key, content_type AS contentType, sha256, scan_status AS scanStatus FROM documents WHERE id = ?',
    )
    .bind(documentId)
    .first<DocumentForScan>();
}

export interface ScanRecord {
  documentId: string;
  expectedSha256: string;
  scanStatus: 'clean' | 'rejected';
  provider: string;
  reference: string;
  verdict: string;
  sha256: string;
  scannedAt: string;
  engineVersion: string | null;
  auditId: string;
  actorId: string;
  requestId: string;
  auditDetailsJson: string;
  timestamp: string;
}

/**
 * Atomic compare-and-set: only a still-pending row whose digest matches is updated, and the audit row is
 * written only if that UPDATE changed a row AND the stored scan job is ours. UPDATE and audit MUST stay adjacent.
 */
export async function recordScanResult(db: D1Database, r: ScanRecord): Promise<void> {
  await db.batch([
    db
      .prepare(
        "UPDATE documents SET scan_status = ?, scan_provider = ?, scan_job_id = ?, scan_verdict = ?, scan_digest = ?, scanned_at = ?, scan_engine_version = ? WHERE id = ? AND scan_status = 'pending' AND sha256 = ?",
      )
      .bind(r.scanStatus, r.provider, r.reference, r.verdict, r.sha256, r.scannedAt, r.engineVersion, r.documentId, r.expectedSha256),
    db
      .prepare(
        "INSERT INTO audit_logs (id, actor_user_id, actor_type, action, entity_type, entity_id, request_id, details_json, created_at) SELECT ?, ?, 'staff', ?, 'document', ?, ?, ?, ? WHERE changes() > 0 AND EXISTS (SELECT 1 FROM documents WHERE id = ? AND scan_job_id = ? AND scan_status = ?)",
      )
      .bind(r.auditId, r.actorId, `document.scan.${r.scanStatus}`, r.documentId, r.requestId, r.auditDetailsJson, r.timestamp, r.documentId, r.reference, r.scanStatus),
  ]);
}

export function loadSavedScan(db: D1Database, documentId: string): Promise<{ scanStatus: string; scanJobId: string | null } | null> {
  return db
    .prepare('SELECT scan_status AS scanStatus, scan_job_id AS scanJobId FROM documents WHERE id = ?')
    .bind(documentId)
    .first<{ scanStatus: string; scanJobId: string | null }>();
}

export function findDocumentForReview(
  db: D1Database,
  documentId: string,
): Promise<{ id: string; opportunityId: string; scanStatus: string; sha256: string } | null> {
  return db
    .prepare('SELECT id, opportunity_id AS opportunityId, scan_status AS scanStatus, sha256 FROM documents WHERE id = ?')
    .bind(documentId)
    .first();
}

/** Manual override (reject only; the route refuses 'clean'). Status change and audit commit together. */
export async function setScanStatusManually(
  db: D1Database,
  p: { documentId: string; status: 'clean' | 'rejected'; auditId: string; actorId: string; requestId: string; detailsJson: string; timestamp: string },
): Promise<void> {
  await db.batch([
    db.prepare('UPDATE documents SET scan_status = ? WHERE id = ?').bind(p.status, p.documentId),
    db
      .prepare(
        "INSERT INTO audit_logs (id, actor_user_id, actor_type, action, entity_type, entity_id, request_id, details_json, created_at) VALUES (?, ?, 'staff', ?, 'document', ?, ?, ?, ?)",
      )
      .bind(p.auditId, p.actorId, `document.scan.${p.status}`, p.documentId, p.requestId, p.detailsJson, p.timestamp),
  ]);
}

export function findDocumentForDelete(
  db: D1Database,
  documentId: string,
): Promise<{ id: string; r2Key: string; opportunityId: string } | null> {
  return db
    .prepare('SELECT id, r2_key AS r2Key, opportunity_id AS opportunityId FROM documents WHERE id = ?')
    .bind(documentId)
    .first();
}

export async function deleteDocumentRow(db: D1Database, documentId: string): Promise<void> {
  await db.prepare('DELETE FROM documents WHERE id = ?').bind(documentId).run();
}
