/** SQL for staff-sent seller emails. A message is drafted, approved (content frozen + hashed + queued), claimed, sent, and recorded. */
import { auditIfChangedStmt } from './audit-repo';
import type { Actor, SellerScope } from './seller-repo';
type Row = Record<string, unknown>;

export interface MessageRow {
  id: string; kind: string; enquiryId: string; sellerId: string | null; opportunityId: string | null; interestId: string | null; interestVersion: number | null;
  templateId: string; recipient: string; subject: string; bodyText: string; bodyHtml: string; status: string; version: number; createdBy: string;
  approvedBy: string | null; contentHash: string | null; enquiryReference: string;
}
const MSG_COLS = `m.id, m.kind, m.enquiry_id AS enquiryId, m.seller_id AS sellerId, m.opportunity_id AS opportunityId, m.interest_id AS interestId, m.interest_version AS interestVersion,
  m.template_id AS templateId, m.recipient_email AS recipient, m.subject, m.body_text AS bodyText, m.body_html AS bodyHtml, m.status, m.version, m.created_by AS createdBy,
  m.approved_by AS approvedBy, m.content_hash AS contentHash, e.reference AS enquiryReference`;

/** Brokers reach a message through an enquiry assigned to them or a seller they own. */
export function findMessage(db: D1Database, messageId: string, s: SellerScope): Promise<MessageRow | null> {
  return db.prepare(`SELECT ${MSG_COLS} FROM seller_outbound_messages m JOIN seller_enquiries e ON e.id = m.enquiry_id LEFT JOIN sellers x ON x.id = m.seller_id
    WHERE m.id = ? AND e.anonymised_at IS NULL AND (? = 0 OR e.assigned_to = ? OR x.relationship_owner = ?)`).bind(messageId, s.brokerOnly, s.staffId, s.staffId).first<MessageRow>();
}

export interface NewDraft {
  messageId: string; auditId: string; kind: 'FOLLOWUP' | 'MATERIAL_INTEREST'; enquiryId: string; enquiryReference: string; sellerId: string | null; opportunityId: string | null;
  interestId: string | null; interestVersion: number | null; templateId: string; recipient: string; subject: string; text: string; html: string; requireOpenEnquiry: boolean;
}
export async function insertDraft(db: D1Database, p: Actor & NewDraft): Promise<boolean> {
  const r = await db.batch([
    db.prepare(`INSERT INTO seller_outbound_messages (id, kind, enquiry_id, seller_id, opportunity_id, interest_id, interest_version, template_id, recipient_email, subject, body_text, body_html, status, created_by, version, created_at, updated_at)
        SELECT ?, ?, id, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, 1, ?, ? FROM seller_enquiries WHERE id = ? AND anonymised_at IS NULL AND (? = 0 OR status NOT IN ('DECLINED','CLOSED','CONVERTED'))
        AND (? IS NULL OR NOT EXISTS (SELECT 1 FROM seller_outbound_messages WHERE interest_id = ? AND status IN ('QUEUED','SENDING','SENT')))`)
      .bind(p.messageId, p.kind, p.sellerId, p.opportunityId, p.interestId, p.interestVersion, p.templateId, p.recipient, p.subject, p.text, p.html, p.id, p.ts, p.ts, p.enquiryId, p.requireOpenEnquiry ? 1 : 0, p.interestId, p.interestId),
    auditIfChangedStmt(db, { id: p.auditId, actorId: p.id, action: 'seller_message.drafted', entityType: 'seller_enquiry', entityId: p.enquiryId, requestId: p.requestId, details: { reference: p.enquiryReference, messageId: p.messageId, kind: p.kind, templateId: p.templateId }, ts: p.ts }),
  ]);
  return (r[0]?.meta?.changes ?? 0) > 0;
}

/** Approval: freezes the content hash, records the approver and creates the single outbox job (unique logical key). Double-clicks create nothing new. */
export async function approveAndQueue(db: D1Database, p: Actor & { message: MessageRow; contentHash: string; jobId: string; auditId: string }): Promise<boolean> {
  const m = p.message;
  const r = await db.batch([
    db.prepare("UPDATE seller_outbound_messages SET status = 'QUEUED', approved_by = ?, approved_at = ?, content_hash = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND status = 'DRAFT'").bind(p.id, p.ts, p.contentHash, p.ts, m.id, m.version),
    db.prepare("INSERT OR IGNORE INTO notification_jobs (id, job_type, payload_json, status, attempts, available_at, created_at, updated_at, dedupe_key) SELECT ?, 'seller.message_send', ?, 'queued', 0, ?, ?, ?, ? WHERE changes() > 0")
      .bind(p.jobId, JSON.stringify({ messageId: m.id }), p.ts, p.ts, p.ts, `seller_message:${m.id}`),
    auditIfChangedStmt(db, { id: p.auditId, actorId: p.id, action: 'seller_message.approved', entityType: 'seller_enquiry', entityId: m.enquiryId, requestId: p.requestId, details: { reference: m.enquiryReference, messageId: m.id, kind: m.kind, templateId: m.templateId, contentHash: p.contentHash }, ts: p.ts }),
  ]);
  return (r[0]?.meta?.changes ?? 0) > 0;
}

/** Cancel before dispatch. A message already SENDING or SENT cannot be cancelled. */
export async function cancelMessage(db: D1Database, p: Actor & { message: MessageRow; reason: string; auditId: string }): Promise<boolean> {
  const m = p.message;
  const r = await db.batch([
    db.prepare("UPDATE seller_outbound_messages SET status = 'CANCELLED', cancel_reason = ?, version = version + 1, updated_at = ? WHERE id = ? AND status IN ('DRAFT','QUEUED')").bind(p.reason, p.ts, m.id),
    auditIfChangedStmt(db, { id: p.auditId, actorId: p.id, action: 'seller_message.cancelled', entityType: 'seller_enquiry', entityId: m.enquiryId, requestId: p.requestId, details: { reference: m.enquiryReference, messageId: m.id, kind: m.kind }, ts: p.ts }),
  ]);
  return (r[0]?.meta?.changes ?? 0) > 0;
}

export interface DispatchView extends MessageRow {
  enquiryEmail: string; sellerEmail: string | null; interestStage: string | null; currentInterestVersion: number | null; entitled: number; approverName: string | null;
}
const ENTITLED = `EXISTS (SELECT 1 FROM seller_opportunity_links l WHERE l.id = i.link_id AND l.relationship_status = 'ACTIVE' AND l.review_status = 'REVIEWED' AND EXISTS (
  SELECT 1 FROM seller_authority_records r WHERE r.link_id = l.id AND r.authority_type IN ('AUTHORITY_TO_REPRESENT','BROKERAGE_MANDATE')
  AND (r.status = 'NOT_REQUIRED_WITH_RECORDED_REASON' OR (r.status = 'VERIFIED' AND (r.valid_from IS NULL OR r.valid_from <= ?1) AND (r.valid_until IS NULL OR r.valid_until > ?1)))))`;
/** Everything the dispatcher must re-check at send time, in one read. */
export function dispatchView(db: D1Database, messageId: string, nowIso: string): Promise<DispatchView | null> {
  return db.prepare(`SELECT ${MSG_COLS}, e.email AS enquiryEmail, x.contact_email AS sellerEmail, i.stage AS interestStage, i.version AS currentInterestVersion, u.display_name AS approverName,
      CASE WHEN i.id IS NOT NULL AND ${ENTITLED} THEN 1 ELSE 0 END AS entitled
    FROM seller_outbound_messages m JOIN seller_enquiries e ON e.id = m.enquiry_id LEFT JOIN sellers x ON x.id = m.seller_id LEFT JOIN seller_material_interests i ON i.id = m.interest_id LEFT JOIN users u ON u.id = m.approved_by
    WHERE m.id = ?2`).bind(nowIso, messageId).first<DispatchView>();
}

export async function claimForSend(db: D1Database, messageId: string, ts: string): Promise<boolean> {
  const r = await db.prepare("UPDATE seller_outbound_messages SET status = 'SENDING', updated_at = ? WHERE id = ? AND status IN ('QUEUED','SENDING')").bind(ts, messageId).run();
  return (r.meta?.changes ?? 0) > 0;
}
/** Dispatch-time refusal (eligibility lost). Safe to call repeatedly. */
export async function cancelIneligible(db: D1Database, m: { id: string; enquiryId: string; kind: string }, reason: string, ts: string): Promise<void> {
  await db.batch([
    db.prepare("UPDATE seller_outbound_messages SET status = 'CANCELLED', cancel_reason = ?, version = version + 1, updated_at = ? WHERE id = ? AND status IN ('QUEUED','SENDING')").bind(reason, ts, m.id),
    db.prepare("INSERT INTO audit_logs (id, actor_user_id, actor_type, action, entity_type, entity_id, request_id, details_json, created_at) SELECT lower(hex(randomblob(16))), NULL, 'system', 'seller_message.cancelled_ineligible', 'seller_enquiry', ?, 'queue', ?, ? WHERE changes() > 0")
      .bind(m.enquiryId, JSON.stringify({ messageId: m.id, kind: m.kind, reason }), ts),
  ]);
}

/**
 * Records the provider's acceptance. The communication row is keyed by the job id (INSERT OR IGNORE) so a retry after a crash
 * cannot duplicate it. A material-interest send also moves the interest to NOTIFIED.
 */
export async function completeSend(db: D1Database, p: { message: DispatchView; jobId: string; commId: string; eventId: string; auditId: string; ts: string }): Promise<void> {
  const m = p.message;
  const stmts: D1PreparedStatement[] = [
    db.prepare("UPDATE seller_outbound_messages SET status = 'SENT', sent_at = ?, version = version + 1, updated_at = ? WHERE id = ? AND status = 'SENDING'").bind(p.ts, p.ts, m.id),
    db.prepare(`INSERT OR IGNORE INTO seller_communications (id, enquiry_id, direction, channel, occurred_at, actor_type, actor_user_id, template_id, summary, outcome, delivery_status, notification_job_id, opportunity_id, created_at)
        SELECT ?, ?, 'OUTBOUND', 'EMAIL', ?, 'staff', ?, ?, ?, 'SENT', 'ACCEPTED_BY_PROVIDER', ?, ?, ? WHERE EXISTS (SELECT 1 FROM seller_outbound_messages WHERE id = ? AND status = 'SENT' AND sent_at = ?)`)
      .bind(p.commId, m.enquiryId, p.ts, m.approvedBy, m.templateId, `${m.kind === 'FOLLOWUP' ? 'Follow-up' : 'Material-interest update'} sent; accepted by the email provider (inbox delivery not confirmed).`, p.jobId, m.opportunityId, p.ts, m.id, p.ts),
    db.prepare('UPDATE seller_enquiries SET first_response_at = COALESCE(first_response_at, ?), updated_at = ? WHERE id = ? AND ? = 1').bind(p.ts, p.ts, m.enquiryId, m.kind === 'FOLLOWUP' ? 1 : 0),
  ];
  if (m.kind === 'MATERIAL_INTEREST' && m.interestId) {
    stmts.push(
      db.prepare("UPDATE seller_material_interests SET stage = 'NOTIFIED', notified_at = ?, version = version + 1, updated_at = ? WHERE id = ? AND stage = 'APPROVED' AND version = ?").bind(p.ts, p.ts, m.interestId, m.interestVersion),
      db.prepare("INSERT INTO seller_material_interest_events (id, interest_id, action, from_stage, to_stage, note, actor_user_id, created_at) SELECT ?, ?, 'seller_notified', 'APPROVED', 'NOTIFIED', ?, ?, ? WHERE EXISTS (SELECT 1 FROM seller_material_interests WHERE id = ? AND stage = 'NOTIFIED' AND notified_at = ?)")
        .bind(p.eventId, m.interestId, `Message ${m.id} accepted by the email provider`, m.approvedBy, p.ts, m.interestId, p.ts),
    );
  }
  stmts.push(db.prepare("INSERT INTO audit_logs (id, actor_user_id, actor_type, action, entity_type, entity_id, request_id, details_json, created_at) SELECT ?, ?, 'system', 'seller_message.sent', 'seller_enquiry', ?, 'queue', ?, ? WHERE EXISTS (SELECT 1 FROM seller_outbound_messages WHERE id = ? AND status = 'SENT' AND sent_at = ?)")
    .bind(p.auditId, m.approvedBy, m.enquiryId, JSON.stringify({ messageId: m.id, kind: m.kind, templateId: m.templateId, deliveryState: 'accepted_by_provider' }), p.ts, m.id, p.ts));
  await db.batch(stmts);
}

export async function listMessages(db: D1Database, enquiryId: string): Promise<Row[]> {
  const r = await db.prepare(`SELECT m.id, m.kind, m.status, m.subject, m.template_id AS templateId, m.created_at AS createdAt, m.approved_at AS approvedAt, m.sent_at AS sentAt, m.cancel_reason AS cancelReason, m.version,
      cu.display_name AS createdByName, au.display_name AS approvedByName, j.status AS jobStatus, j.attempts AS jobAttempts
    FROM seller_outbound_messages m JOIN users cu ON cu.id = m.created_by LEFT JOIN users au ON au.id = m.approved_by LEFT JOIN notification_jobs j ON j.dedupe_key = 'seller_message:' || m.id
    WHERE m.enquiry_id = ? ORDER BY m.created_at DESC LIMIT 50`).bind(enquiryId).all<Row>();
  return r.results ?? [];
}

/** Subject export includes the text sent about the person (it is their own correspondence). */
export async function listMessagesForExport(db: D1Database, enquiryId: string): Promise<Row[]> {
  const r = await db.prepare("SELECT m.kind, m.status, m.subject, m.body_text AS bodyText, m.template_id AS templateId, m.created_at AS createdAt, m.sent_at AS sentAt FROM seller_outbound_messages m WHERE m.enquiry_id = ? AND m.status IN ('SENT','CANCELLED','QUEUED','SENDING') ORDER BY m.created_at").bind(enquiryId).all<Row>();
  return r.results ?? [];
}
