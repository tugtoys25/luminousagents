/** SQL for retention review, erasure (anonymisation), legal holds, privacy requests and consent withdrawal. */
import { auditIfChangedStmt, auditStmt } from './audit-repo';
import type { Actor } from './seller-repo';
type Row = Record<string, unknown>;

/** Enquiries that may be due for retention review under a policy the business has approved. Held, linked or open records are never listed. */
export async function retentionCandidates(db: D1Database, closedBeforeIso: string, limit: number): Promise<Row[]> {
  const r = await db.prepare(`SELECT reference, status, closed_at AS closedAt, asset_country AS assetCountry, asset_type AS assetType, created_at AS createdAt
    FROM seller_enquiries WHERE status IN ('DECLINED','CLOSED') AND closed_at IS NOT NULL AND closed_at <= ? AND anonymised_at IS NULL AND legal_hold = 0 AND seller_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM seller_privacy_requests q WHERE q.enquiry_id = seller_enquiries.id AND q.status IN ('OPEN','IN_PROGRESS') AND q.request_type = 'RESTRICTION')
    ORDER BY closed_at LIMIT ?`).bind(closedBeforeIso, limit).all<Row>();
  return r.results ?? [];
}

export interface PrivacyEnquiry { id: string; reference: string; status: string; sellerId: string | null; legalHold: number; anonymisedAt: string | null; marketingConsent: number; marketingWithdrawnAt: string | null }
export function findPrivacyEnquiry(db: D1Database, reference: string): Promise<PrivacyEnquiry | null> {
  return db.prepare('SELECT id, reference, status, seller_id AS sellerId, legal_hold AS legalHold, anonymised_at AS anonymisedAt, marketing_consent AS marketingConsent, marketing_consent_withdrawn_at AS marketingWithdrawnAt FROM seller_enquiries WHERE reference = ?').bind(reference).first<PrivacyEnquiry>();
}

/**
 * Irreversibly removes personal data from a closed or declined enquiry that has no seller link and no legal hold, and redacts staff free text
 * attached to it. Structural facts (reference, dates, status, country, asset type) are kept for statistics and audit. All in one transaction;
 * every redaction is guarded on the enquiry having actually been anonymised by this request.
 */
export async function anonymiseEnquiry(db: D1Database, p: Actor & { enquiry: PrivacyEnquiry; reason: string; auditId: string }): Promise<boolean> {
  const e = p.enquiry;
  const done = 'EXISTS (SELECT 1 FROM seller_enquiries WHERE id = ? AND anonymised_at = ?)';
  const r = await db.batch([
    db.prepare(`UPDATE seller_enquiries SET contact_name = 'Anonymised', contact_role_other = NULL, email = 'anonymised-' || id || '@invalid.example', telephone = NULL, organisation = NULL, asset_type_other = NULL, asset_name = NULL,
        asset_description = '[removed]', additional_information = NULL, asking_price_text = NULL, currency_other = NULL, original_submission_json = '{}', source_ip_hash = NULL, idempotency_hash = 'anonymised:' || id,
        anonymised_at = ?, version = version + 1, updated_at = ? WHERE id = ? AND anonymised_at IS NULL AND legal_hold = 0 AND seller_id IS NULL AND status IN ('DECLINED','CLOSED')`).bind(p.ts, p.ts, e.id),
    db.prepare(`UPDATE seller_enquiry_notes SET note = '[redacted]' WHERE enquiry_id = ? AND note <> '[redacted]' AND ${done}`).bind(e.id, e.id, p.ts),
    db.prepare(`UPDATE seller_communications SET summary = '[redacted]' WHERE enquiry_id = ? AND summary <> '[redacted]' AND ${done}`).bind(e.id, e.id, p.ts),
    db.prepare(`UPDATE seller_enquiry_status_history SET reason = '[redacted]' WHERE enquiry_id = ? AND reason IS NOT NULL AND reason <> '[redacted]' AND ${done}`).bind(e.id, e.id, p.ts),
    db.prepare(`UPDATE seller_enquiry_qualifications SET checklist_json = '[]', next_action = '[redacted]' WHERE enquiry_id = ? AND (checklist_json <> '[]' OR next_action <> '[redacted]') AND ${done}`).bind(e.id, e.id, p.ts),
    db.prepare(`UPDATE seller_outbound_messages SET subject = '[redacted]', body_text = '[redacted]', body_html = '[redacted]', recipient_email = 'redacted@invalid.example' WHERE enquiry_id = ? AND body_text <> '[redacted]' AND ${done}`).bind(e.id, e.id, p.ts),
    db.prepare(`UPDATE staff_tasks SET title = '[redacted]', description = '', outcome = NULL WHERE related_entity_type = 'seller_enquiry' AND related_entity_id = ? AND ${done}`).bind(e.id, e.id, p.ts),
    db.prepare(`INSERT INTO audit_logs (id, actor_user_id, actor_type, action, entity_type, entity_id, request_id, details_json, created_at) SELECT ?, ?, 'staff', 'seller_enquiry.anonymised', 'seller_enquiry', ?, ?, ?, ? WHERE ${done}`)
      .bind(p.auditId, p.id, e.id, p.requestId, JSON.stringify({ reference: e.reference, reason: p.reason }), p.ts, e.id, p.ts),
  ]);
  return (r[0]?.meta?.changes ?? 0) > 0;
}

export async function setLegalHold(db: D1Database, p: Actor & { enquiry: PrivacyEnquiry; hold: boolean; reason: string; auditId: string }): Promise<boolean> {
  const r = await db.batch([
    db.prepare('UPDATE seller_enquiries SET legal_hold = ?, version = version + 1, updated_at = ? WHERE id = ? AND anonymised_at IS NULL AND legal_hold <> ?').bind(p.hold ? 1 : 0, p.ts, p.enquiry.id, p.hold ? 1 : 0),
    auditIfChangedStmt(db, { id: p.auditId, actorId: p.id, action: p.hold ? 'seller_enquiry.legal_hold_set' : 'seller_enquiry.legal_hold_cleared', entityType: 'seller_enquiry', entityId: p.enquiry.id, requestId: p.requestId, details: { reference: p.enquiry.reference, reason: p.reason }, ts: p.ts }),
  ]);
  return (r[0]?.meta?.changes ?? 0) > 0;
}

/** Records the withdrawal; consent history is kept. Withdrawal never affects handling of the enquiry itself. */
export async function withdrawMarketingConsent(db: D1Database, p: Actor & { enquiry: PrivacyEnquiry; auditId: string }): Promise<boolean> {
  const r = await db.batch([
    db.prepare('UPDATE seller_enquiries SET marketing_consent_withdrawn_at = ?, version = version + 1, updated_at = ? WHERE id = ? AND marketing_consent = 1 AND marketing_consent_withdrawn_at IS NULL AND anonymised_at IS NULL').bind(p.ts, p.ts, p.enquiry.id),
    auditIfChangedStmt(db, { id: p.auditId, actorId: p.id, action: 'seller_enquiry.marketing_consent_withdrawn', entityType: 'seller_enquiry', entityId: p.enquiry.id, requestId: p.requestId, details: { reference: p.enquiry.reference }, ts: p.ts }),
  ]);
  return (r[0]?.meta?.changes ?? 0) > 0;
}

export async function insertPrivacyRequest(db: D1Database, p: Actor & { privacyId: string; reference: string; enquiryId: string | null; requestType: string; receivedAt: string; dueAt: string | null; auditId: string }): Promise<void> {
  await db.batch([
    db.prepare('INSERT INTO seller_privacy_requests (id, reference, enquiry_id, request_type, status, received_at, due_at, created_by, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)')
      .bind(p.privacyId, p.reference, p.enquiryId, p.requestType, 'OPEN', p.receivedAt, p.dueAt, p.id, p.ts, p.ts),
    auditStmt(db, { id: p.auditId, actorId: p.id, action: 'privacy_request.created', entityType: 'seller_privacy_request', entityId: p.privacyId, requestId: p.requestId, details: { reference: p.reference, requestType: p.requestType }, ts: p.ts }),
  ]);
}

export interface PrivacyRequestRow { id: string; reference: string; status: string; version: number; enquiryId: string | null }
export function findPrivacyRequest(db: D1Database, reference: string): Promise<PrivacyRequestRow | null> {
  return db.prepare('SELECT id, reference, status, version, enquiry_id AS enquiryId FROM seller_privacy_requests WHERE reference = ?').bind(reference).first<PrivacyRequestRow>();
}
export async function updatePrivacyRequest(db: D1Database, p: Actor & { request: PrivacyRequestRow; status: string; outcomeNote: string; auditId: string }): Promise<boolean> {
  const r = await db.batch([
    db.prepare("UPDATE seller_privacy_requests SET status = ?, outcome_note = ?, handled_by = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND status IN ('OPEN','IN_PROGRESS')").bind(p.status, p.outcomeNote, p.id, p.ts, p.request.id, p.request.version),
    auditIfChangedStmt(db, { id: p.auditId, actorId: p.id, action: 'privacy_request.updated', entityType: 'seller_privacy_request', entityId: p.request.id, requestId: p.requestId, details: { reference: p.request.reference, to: p.status }, ts: p.ts }),
  ]);
  return (r[0]?.meta?.changes ?? 0) > 0;
}
export async function listPrivacyRequests(db: D1Database, status: string): Promise<Row[]> {
  const r = await db.prepare(`SELECT q.reference, q.request_type AS requestType, q.status, q.received_at AS receivedAt, q.due_at AS dueAt, q.outcome_note AS outcomeNote, q.version, e.reference AS enquiryReference, u.display_name AS handledByName
    FROM seller_privacy_requests q LEFT JOIN seller_enquiries e ON e.id = q.enquiry_id LEFT JOIN users u ON u.id = q.handled_by WHERE (? = '' OR q.status = ?) ORDER BY (q.status IN ('COMPLETED','REFUSED')), q.due_at IS NULL, q.due_at, q.received_at LIMIT 100`).bind(status, status).all<Row>();
  return r.results ?? [];
}

/** Export is audited without its content. */
export async function recordExport(db: D1Database, p: Actor & { enquiryId: string; reference: string; auditId: string }): Promise<void> {
  await auditStmt(db, { id: p.auditId, actorId: p.id, action: 'seller_enquiry.exported', entityType: 'seller_enquiry', entityId: p.enquiryId, requestId: p.requestId, details: { reference: p.reference }, ts: p.ts }).run();
}
