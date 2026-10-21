/** SQL for authority evidence metadata, scan results, access log and purge. Every sensitive action writes its log row in the same batch. */
import { auditIfChangedStmt } from './audit-repo';
import { EVIDENCE_MAX_PER_RECORD } from './evidence-files';
import type { Actor, SellerScope } from './seller-repo';
type Row = Record<string, unknown>;

export interface EvidenceRef {
  id: string; recordId: string; recordReference: string; recordStatus: string; sellerId: string; sellerReference: string; r2Key: string | null; filename: string;
  contentType: string; byteSize: number; sha256: string; scanStatus: string; scanSkipped: number; status: string; purgePending: number; purgedAt: string | null;
}
const COLS = `e.id, e.record_id AS recordId, r.reference AS recordReference, r.status AS recordStatus, x.id AS sellerId, x.reference AS sellerReference, e.r2_key AS r2Key, e.filename, e.content_type AS contentType,
  e.byte_size AS byteSize, e.sha256, e.scan_status AS scanStatus, e.scan_skipped AS scanSkipped, e.status, e.purge_pending AS purgePending, e.purged_at AS purgedAt`;

/** Brokers reach evidence only through sellers they own; other out-of-scope ids look like missing ones. */
export function findEvidence(db: D1Database, evidenceId: string, s: SellerScope): Promise<EvidenceRef | null> {
  return db.prepare(`SELECT ${COLS} FROM seller_authority_evidence e JOIN seller_authority_records r ON r.id = e.record_id JOIN seller_opportunity_links l ON l.id = r.link_id JOIN sellers x ON x.id = l.seller_id
    WHERE e.id = ? AND x.anonymised_at IS NULL AND (? = 0 OR x.relationship_owner = ?)`).bind(evidenceId, s.brokerOnly, s.staffId).first<EvidenceRef>();
}

export async function listEvidenceForSeller(db: D1Database, sellerId: string): Promise<Row[]> {
  const r = await db.prepare(`SELECT e.id, r.reference AS recordReference, e.filename, e.content_type AS contentType, e.byte_size AS byteSize, e.scan_status AS scanStatus, e.scan_skipped AS scanSkipped, e.status, e.purge_pending AS purgePending,
      e.purged_at AS purgedAt, e.created_at AS createdAt, u.display_name AS uploadedByName
    FROM seller_authority_evidence e JOIN seller_authority_records r ON r.id = e.record_id JOIN seller_opportunity_links l ON l.id = r.link_id JOIN users u ON u.id = e.uploaded_by
    WHERE l.seller_id = ? ORDER BY e.created_at DESC LIMIT 200`).bind(sellerId).all<Row>();
  return r.results ?? [];
}

/** Clean, active, not-purged files, or recorded references, are what "evidence reviewed" means for verification. */
export async function usableEvidenceCount(db: D1Database, recordId: string): Promise<number> {
  const r = await db.prepare("SELECT COUNT(*) AS n FROM seller_authority_evidence WHERE record_id = ? AND status = 'ACTIVE' AND purged_at IS NULL AND purge_pending = 0 AND scan_status = 'clean'").bind(recordId).first<{ n: number }>();
  return r?.n ?? 0;
}

const LOG = 'INSERT INTO seller_evidence_access_log (id, evidence_id, actor_user_id, action, request_id, created_at)';

export interface NewEvidence { evidenceId: string; recordId: string; recordReference: string; sellerId: string; sellerReference: string; r2Key: string; filename: string; contentType: string; byteSize: number; sha256: string; scanStatus: 'pending' | 'clean'; scanProvider: string | null; scanSkipped: boolean; logId: string; auditId: string }
export async function insertEvidence(db: D1Database, p: Actor & NewEvidence): Promise<boolean> {
  const r = await db.batch([
    db.prepare(`INSERT INTO seller_authority_evidence (id, record_id, r2_key, filename, content_type, byte_size, sha256, scan_status, scan_provider, scan_skipped, scanned_at, status, uploaded_by, created_at, updated_at)
        SELECT ?, id, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ? FROM seller_authority_records WHERE id = ? AND status <> 'REVOKED'
        AND (SELECT COUNT(*) FROM seller_authority_evidence WHERE record_id = ? AND status = 'ACTIVE' AND purged_at IS NULL) < ${EVIDENCE_MAX_PER_RECORD}`)
      .bind(p.evidenceId, p.r2Key, p.filename, p.contentType, p.byteSize, p.sha256, p.scanStatus, p.scanProvider, p.scanSkipped ? 1 : 0, p.scanSkipped ? p.ts : null, p.id, p.ts, p.ts, p.recordId, p.recordId),
    db.prepare(`${LOG} SELECT ?, ?, ?, 'uploaded', ?, ? WHERE changes() > 0`).bind(p.logId, p.evidenceId, p.id, p.requestId, p.ts),
    auditIfChangedStmt(db, { id: p.auditId, actorId: p.id, action: 'authority.evidence_uploaded', entityType: 'seller', entityId: p.sellerId, requestId: p.requestId, details: { seller: p.sellerReference, record: p.recordReference, evidenceId: p.evidenceId, bytes: p.byteSize, contentType: p.contentType, scanSkipped: p.scanSkipped }, ts: p.ts }),
  ]);
  return (r[0]?.meta?.changes ?? 0) > 0;
}

export async function recordScan(db: D1Database, p: Actor & { evidence: EvidenceRef; verdict: 'clean' | 'rejected'; provider: string; reference: string; skipped: boolean; scannedAt: string; logId: string; auditId: string }): Promise<boolean> {
  const e = p.evidence;
  const r = await db.batch([
    db.prepare("UPDATE seller_authority_evidence SET scan_status = ?, scan_provider = ?, scan_reference = ?, scan_skipped = ?, scanned_at = ?, updated_at = ? WHERE id = ? AND sha256 = ? AND scan_status = 'pending'")
      .bind(p.verdict, p.provider, p.reference, p.skipped ? 1 : 0, p.scannedAt, p.ts, e.id, e.sha256),
    db.prepare(`${LOG} SELECT ?, ?, ?, 'scanned', ?, ? WHERE changes() > 0`).bind(p.logId, e.id, p.id, p.requestId, p.ts),
    auditIfChangedStmt(db, { id: p.auditId, actorId: p.id, action: 'authority.evidence_scanned', entityType: 'seller', entityId: e.sellerId, requestId: p.requestId, details: { seller: e.sellerReference, record: e.recordReference, evidenceId: e.id, verdict: p.verdict, provider: p.provider, skipped: p.skipped }, ts: p.ts }),
  ]);
  return (r[0]?.meta?.changes ?? 0) > 0;
}

/** The access-log row is written FIRST and must succeed before any bytes are returned (fail closed). */
export async function logDownload(db: D1Database, p: Actor & { evidence: EvidenceRef; logId: string; auditId: string }): Promise<void> {
  const e = p.evidence;
  await db.batch([
    db.prepare(`${LOG} VALUES (?, ?, ?, 'downloaded', ?, ?)`).bind(p.logId, e.id, p.id, p.requestId, p.ts),
    db.prepare("INSERT INTO audit_logs (id, actor_user_id, actor_type, action, entity_type, entity_id, request_id, details_json, created_at) VALUES (?, ?, 'staff', 'authority.evidence_downloaded', 'seller', ?, ?, ?, ?)")
      .bind(p.auditId, p.id, e.sellerId, p.requestId, JSON.stringify({ seller: e.sellerReference, record: e.recordReference, evidenceId: e.id }), p.ts),
  ]);
}

export async function retireEvidence(db: D1Database, p: Actor & { evidence: EvidenceRef; reason: string; logId: string; auditId: string }): Promise<boolean> {
  const e = p.evidence;
  const r = await db.batch([
    db.prepare("UPDATE seller_authority_evidence SET status = 'RETIRED', retired_by = ?, retired_at = ?, updated_at = ? WHERE id = ? AND status = 'ACTIVE'").bind(p.id, p.ts, p.ts, e.id),
    db.prepare(`${LOG} SELECT ?, ?, ?, 'retired', ?, ? WHERE changes() > 0`).bind(p.logId, e.id, p.id, p.requestId, p.ts),
    auditIfChangedStmt(db, { id: p.auditId, actorId: p.id, action: 'authority.evidence_retired', entityType: 'seller', entityId: e.sellerId, requestId: p.requestId, details: { seller: e.sellerReference, record: e.recordReference, evidenceId: e.id, reason: p.reason }, ts: p.ts }),
  ]);
  return (r[0]?.meta?.changes ?? 0) > 0;
}

/** Marks the bytes for deletion and redacts the filename. The purge job (and the caller, best effort) removes the R2 object. */
export async function requestPurge(db: D1Database, p: Actor & { evidence: EvidenceRef; reason: string; logId: string; auditId: string }): Promise<boolean> {
  const e = p.evidence;
  const r = await db.batch([
    db.prepare("UPDATE seller_authority_evidence SET purge_pending = 1, filename = '[redacted]', status = 'RETIRED', retired_by = COALESCE(retired_by, ?), retired_at = COALESCE(retired_at, ?), updated_at = ? WHERE id = ? AND purged_at IS NULL AND purge_pending = 0").bind(p.id, p.ts, p.ts, e.id),
    db.prepare(`${LOG} SELECT ?, ?, ?, 'delete_requested', ?, ? WHERE changes() > 0`).bind(p.logId, e.id, p.id, p.requestId, p.ts),
    auditIfChangedStmt(db, { id: p.auditId, actorId: p.id, action: 'authority.evidence_delete_requested', entityType: 'seller', entityId: e.sellerId, requestId: p.requestId, details: { seller: e.sellerReference, record: e.recordReference, evidenceId: e.id, reason: p.reason }, ts: p.ts }),
  ]);
  return (r[0]?.meta?.changes ?? 0) > 0;
}

export async function listPurgePending(db: D1Database, limit: number): Promise<Array<{ id: string; r2Key: string }>> {
  const r = await db.prepare('SELECT id, r2_key AS r2Key FROM seller_authority_evidence WHERE purge_pending = 1 AND purged_at IS NULL AND r2_key IS NOT NULL ORDER BY updated_at LIMIT ?').bind(limit).all<{ id: string; r2Key: string }>();
  return r.results ?? [];
}
/** Call only after the R2 object is confirmed deleted (or absent). */
export async function markPurged(db: D1Database, p: { evidenceId: string; logId: string; ts: string }): Promise<boolean> {
  const r = await db.batch([
    db.prepare("UPDATE seller_authority_evidence SET r2_key = NULL, purged_at = ?, updated_at = ? WHERE id = ? AND purge_pending = 1 AND purged_at IS NULL").bind(p.ts, p.ts, p.evidenceId),
    db.prepare(`${LOG} SELECT ?, ?, NULL, 'purged', 'scheduled', ? WHERE changes() > 0`).bind(p.logId, p.evidenceId, p.ts),
  ]);
  return (r[0]?.meta?.changes ?? 0) > 0;
}
