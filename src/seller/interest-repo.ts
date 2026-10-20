/** SQL for material-interest records and their review. A record is internal; only the reviewed summary can ever reach a seller. */
import { auditIfChangedStmt } from './audit-repo';
import type { Actor, SellerScope } from './seller-repo';
type Row = Record<string, unknown>;

export interface InterestRef {
  id: string; reference: string; opportunityId: string; sellerId: string; sellerReference: string; linkId: string; interestType: string; stage: string; version: number;
  approvedSummary: string; proposedNextStep: string; stageLabel: string; opportunityTitle: string; sellerContactName: string; sellerEmail: string; sellerSourceEnquiryId: string | null;
  recordedBy: string;
}
const COLS = `i.id, i.reference, i.opportunity_id AS opportunityId, i.seller_id AS sellerId, x.reference AS sellerReference, i.link_id AS linkId, i.interest_type AS interestType, i.stage, i.version,
  i.approved_summary AS approvedSummary, i.proposed_next_step AS proposedNextStep, i.stage_label AS stageLabel, o.title AS opportunityTitle, x.contact_name AS sellerContactName,
  x.contact_email AS sellerEmail, x.source_enquiry_id AS sellerSourceEnquiryId, i.recorded_by AS recordedBy`;

export function findInterest(db: D1Database, reference: string, s: SellerScope): Promise<InterestRef | null> {
  return db.prepare(`SELECT ${COLS} FROM seller_material_interests i JOIN sellers x ON x.id = i.seller_id JOIN opportunities o ON o.id = i.opportunity_id
    WHERE i.reference = ? AND x.anonymised_at IS NULL AND (? = 0 OR x.relationship_owner = ?)`).bind(reference, s.brokerOnly, s.staffId).first<InterestRef>();
}

export async function insertInterest(db: D1Database, p: Actor & { interestId: string; reference: string; eventId: string; auditId: string; sellerId: string; sellerReference: string; linkId: string; interestType: string; receivedAt: string; source: string; summary: string; buyerReference: string }): Promise<boolean> {
  const r = await db.batch([
    db.prepare(`INSERT INTO seller_material_interests (id, reference, opportunity_id, seller_id, link_id, buyer_reference, interest_type, received_at, source, summary_internal, stage, recorded_by, version, created_at, updated_at)
        SELECT ?, ?, l.opportunity_id, l.seller_id, l.id, ?, ?, ?, ?, ?, 'RECORDED', ?, 1, ?, ? FROM seller_opportunity_links l WHERE l.id = ? AND l.seller_id = ? AND l.relationship_status = 'ACTIVE'`)
      .bind(p.interestId, p.reference, p.buyerReference, p.interestType, p.receivedAt, p.source, p.summary, p.id, p.ts, p.ts, p.linkId, p.sellerId),
    db.prepare("INSERT INTO seller_material_interest_events (id, interest_id, action, from_stage, to_stage, note, actor_user_id, created_at) SELECT ?, ?, 'recorded', NULL, 'RECORDED', '', ?, ? WHERE changes() > 0").bind(p.eventId, p.interestId, p.id, p.ts),
    auditIfChangedStmt(db, { id: p.auditId, actorId: p.id, action: 'material_interest.recorded', entityType: 'seller', entityId: p.sellerId, requestId: p.requestId, details: { seller: p.sellerReference, reference: p.reference, interestType: p.interestType }, ts: p.ts }),
  ]);
  return (r[0]?.meta?.changes ?? 0) > 0;
}

export interface ReviewChange {
  interest: InterestRef; action: 'start_review' | 'approve' | 'reject' | 'withdraw'; note: string; eventId: string; auditId: string;
  approvedSummary: string; proposedNextStep: string; stageLabel: string;
}
const FROM: Record<ReviewChange['action'], string[]> = { start_review: ['RECORDED'], approve: ['UNDER_REVIEW'], reject: ['UNDER_REVIEW'], withdraw: ['RECORDED', 'UNDER_REVIEW', 'APPROVED'] };
const TO: Record<ReviewChange['action'], string> = { start_review: 'UNDER_REVIEW', approve: 'APPROVED', reject: 'REJECTED', withdraw: 'WITHDRAWN' };
export const interestFromStages = (a: ReviewChange['action']): string[] => FROM[a];
export const interestToStage = (a: ReviewChange['action']): string => TO[a];

/**
 * Version- and stage-guarded transition. Approval also re-checks, inside the statement, that the seller is entitled to be told
 * (active relationship, reviewed confidentiality, a currently valid representation authority or mandate). Withdrawal cancels any
 * draft or queued notification for the interest in the same transaction.
 */
export async function reviewInterest(db: D1Database, p: Actor & ReviewChange, nowIso: string): Promise<boolean> {
  const i = p.interest;
  const to = TO[p.action];
  const from = FROM[p.action];
  const entitled = p.action === 'approve' ? `AND EXISTS (SELECT 1 FROM seller_opportunity_links l WHERE l.id = seller_material_interests.link_id AND l.relationship_status = 'ACTIVE' AND l.review_status = 'REVIEWED' AND EXISTS (
      SELECT 1 FROM seller_authority_records r WHERE r.link_id = l.id AND r.authority_type IN ('AUTHORITY_TO_REPRESENT','BROKERAGE_MANDATE')
      AND (r.status = 'NOT_REQUIRED_WITH_RECORDED_REASON' OR (r.status = 'VERIFIED' AND (r.valid_from IS NULL OR r.valid_from <= ?) AND (r.valid_until IS NULL OR r.valid_until > ?)))))` : '';
  const approving = p.action === 'approve' ? 1 : 0;
  const stmts: D1PreparedStatement[] = [
    db.prepare(`UPDATE seller_material_interests SET stage = ?, approved_summary = CASE WHEN ? = 1 THEN ? ELSE approved_summary END, proposed_next_step = CASE WHEN ? = 1 THEN ? ELSE proposed_next_step END,
        stage_label = CASE WHEN ? = 1 THEN ? ELSE stage_label END, confidentiality_checked = CASE WHEN ? = 1 THEN 1 ELSE confidentiality_checked END, notification_eligible = CASE WHEN ? = 1 THEN 1 ELSE notification_eligible END,
        reviewed_by = CASE WHEN ? IN ('approve','reject') THEN ? ELSE reviewed_by END, reviewed_at = CASE WHEN ? IN ('approve','reject') THEN ? ELSE reviewed_at END, version = version + 1, updated_at = ?
        WHERE id = ? AND version = ? AND stage IN (${from.map(() => '?').join(',')}) ${entitled}`)
      .bind(to, approving, p.approvedSummary, approving, p.proposedNextStep, approving, p.stageLabel, approving, approving, p.action, p.id, p.action, p.ts, p.ts, i.id, i.version, ...from, ...(approving ? [nowIso, nowIso] : [])),
    db.prepare('INSERT INTO seller_material_interest_events (id, interest_id, action, from_stage, to_stage, note, actor_user_id, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() > 0').bind(p.eventId, i.id, p.action, i.stage, to, p.note, p.id, p.ts),
    auditIfChangedStmt(db, { id: p.auditId, actorId: p.id, action: `material_interest.${p.action}`, entityType: 'seller', entityId: i.sellerId, requestId: p.requestId, details: { seller: i.sellerReference, reference: i.reference, from: i.stage, to }, ts: p.ts }),
  ];
  if (p.action === 'withdraw') {
    stmts.push(db.prepare("UPDATE seller_outbound_messages SET status = 'CANCELLED', cancel_reason = 'Interest withdrawn', version = version + 1, updated_at = ? WHERE interest_id = ? AND status IN ('DRAFT','QUEUED') AND EXISTS (SELECT 1 FROM seller_material_interests WHERE id = ? AND stage = 'WITHDRAWN' AND version = ?)")
      .bind(p.ts, i.id, i.id, i.version + 1));
  }
  const r = await db.batch(stmts);
  return (r[0]?.meta?.changes ?? 0) > 0;
}

export async function listInterests(db: D1Database, sellerId: string): Promise<Row[]> {
  const r = await db.prepare(`SELECT i.reference, i.interest_type AS interestType, i.received_at AS receivedAt, i.source, i.summary_internal AS summaryInternal, i.buyer_reference AS buyerReference, i.stage, i.stage_label AS stageLabel,
      i.approved_summary AS approvedSummary, i.proposed_next_step AS proposedNextStep, i.confidentiality_checked AS confidentialityChecked, i.version, i.link_id AS linkId, o.title AS opportunityTitle, i.notified_at AS notifiedAt,
      u.display_name AS recordedByName, rv.display_name AS reviewedByName
    FROM seller_material_interests i JOIN opportunities o ON o.id = i.opportunity_id JOIN users u ON u.id = i.recorded_by LEFT JOIN users rv ON rv.id = i.reviewed_by
    WHERE i.seller_id = ? ORDER BY i.created_at DESC LIMIT 100`).bind(sellerId).all<Row>();
  return r.results ?? [];
}
