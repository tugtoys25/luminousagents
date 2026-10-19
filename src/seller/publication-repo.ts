/** SQL for the seller publication review, gate inputs, and conversion of a qualified enquiry into a private draft opportunity. */
import { auditIfChangedStmt } from './audit-repo';
import type { GateInput, GateLink } from './gates';
import type { Actor, SellerScope } from './seller-repo';
type Row = Record<string, unknown>;

export async function loadGateInput(db: D1Database, opportunityId: string): Promise<GateInput> {
  const links = await db.prepare('SELECT l.id, x.reference AS sellerReference, l.relationship_status AS relationshipStatus, l.review_status AS reviewStatus FROM seller_opportunity_links l JOIN sellers x ON x.id = l.seller_id WHERE l.opportunity_id = ?').bind(opportunityId).all<{ id: string } & Omit<GateLink, 'records'>>();
  const recs = await db.prepare('SELECT r.link_id AS linkId, r.authority_type AS authorityType, r.status, r.valid_from AS validFrom, r.valid_until AS validUntil FROM seller_authority_records r JOIN seller_opportunity_links l ON l.id = r.link_id WHERE l.opportunity_id = ?').bind(opportunityId).all<{ linkId: string; authorityType: string; status: string; validFrom: string | null; validUntil: string | null }>();
  const review = await db.prepare('SELECT status, scope_confirmed AS scopeConfirmed, confidentiality_reviewed AS confidentialityReviewed, public_fields_approved AS publicFieldsApproved, sensitive_data_reviewed AS sensitiveDataReviewed, image_rights_checked AS imageRightsChecked, legal_review_completed AS legalReviewCompleted FROM seller_publication_reviews WHERE opportunity_id = ?').bind(opportunityId).first<NonNullable<GateInput['review']>>();
  return {
    links: (links.results ?? []).map((l) => ({ sellerReference: l.sellerReference, relationshipStatus: l.relationshipStatus, reviewStatus: l.reviewStatus, records: (recs.results ?? []).filter((r) => r.linkId === l.id) })),
    review: review ?? null,
  };
}

export interface ReviewRow { id: string; status: string; version: number; preparedBy: string; [k: string]: unknown }
export function getReview(db: D1Database, opportunityId: string): Promise<ReviewRow | null> {
  return db.prepare(`SELECT id, status, scope_text AS scopeText, scope_confirmed AS scopeConfirmed, confidentiality_reviewed AS confidentialityReviewed, public_fields_approved AS publicFieldsApproved,
      sensitive_data_reviewed AS sensitiveDataReviewed, image_rights_checked AS imageRightsChecked, legal_review_completed AS legalReviewCompleted, notes, prepared_by AS preparedBy,
      approved_by AS approvedBy, approved_at AS approvedAt, revoked_at AS revokedAt, version, updated_at AS updatedAt FROM seller_publication_reviews WHERE opportunity_id = ?`).bind(opportunityId).first<ReviewRow>();
}
export function listPublicationEvents(db: D1Database, opportunityId: string): Promise<Row[]> {
  return db.prepare('SELECT e.action, e.note, e.created_at AS createdAt, u.display_name AS actorName FROM seller_publication_events e LEFT JOIN users u ON u.id = e.actor_user_id WHERE e.opportunity_id = ? ORDER BY e.created_at DESC LIMIT 50').bind(opportunityId).all<Row>().then((r) => r.results ?? []);
}

export interface OpportunityRef { id: string; slug: string; country: string | null; title: string; live: number }
/** Brokers reach an opportunity only through a seller they own or an assignment to them. */
export function opportunityInScope(db: D1Database, opportunityId: string, s: SellerScope): Promise<OpportunityRef | null> {
  return db.prepare(`SELECT o.id, o.slug, o.country, o.title, CASE WHEN o.public_visibility = 1 OR o.lifecycle = 'published' THEN 1 ELSE 0 END AS live FROM opportunities o
    WHERE o.id = ? AND (? = 0 OR o.assigned_broker_id = ? OR EXISTS (SELECT 1 FROM seller_opportunity_links l JOIN sellers x ON x.id = l.seller_id WHERE l.opportunity_id = o.id AND x.relationship_owner = ?))`).bind(opportunityId, s.brokerOnly, s.staffId, s.staffId).first<OpportunityRef>();
}

export interface ReviewFlags { scopeText: string; scopeConfirmed: number; confidentialityReviewed: number; publicFieldsApproved: number; sensitiveDataReviewed: number; imageRightsChecked: number; legalReviewCompleted: number; notes: string }
const EVENT = 'INSERT INTO seller_publication_events (id, review_id, opportunity_id, action, note, actor_user_id, created_at)';

/** Creates the DRAFT review for an opportunity that has a seller link. */
export async function createReview(db: D1Database, p: Actor & { reviewId: string; opportunityId: string; flags: ReviewFlags; eventId: string; auditId: string }): Promise<boolean> {
  const f = p.flags;
  const r = await db.batch([
    db.prepare(`INSERT INTO seller_publication_reviews (id, opportunity_id, status, scope_text, scope_confirmed, confidentiality_reviewed, public_fields_approved, sensitive_data_reviewed, image_rights_checked, legal_review_completed, notes, prepared_by, version, created_at, updated_at)
        SELECT ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ? WHERE EXISTS (SELECT 1 FROM seller_opportunity_links WHERE opportunity_id = ?) AND NOT EXISTS (SELECT 1 FROM seller_publication_reviews WHERE opportunity_id = ?)`)
      .bind(p.reviewId, p.opportunityId, f.scopeText, f.scopeConfirmed, f.confidentialityReviewed, f.publicFieldsApproved, f.sensitiveDataReviewed, f.imageRightsChecked, f.legalReviewCompleted, f.notes, p.id, p.ts, p.ts, p.opportunityId, p.opportunityId),
    db.prepare(`${EVENT} SELECT ?, ?, ?, 'created', '', ?, ? WHERE changes() > 0`).bind(p.eventId, p.reviewId, p.opportunityId, p.id, p.ts),
    auditIfChangedStmt(db, { id: p.auditId, actorId: p.id, action: 'seller_publication.review_created', entityType: 'opportunity', entityId: p.opportunityId, requestId: p.requestId, details: {}, ts: p.ts }),
  ]);
  return (r[0]?.meta?.changes ?? 0) > 0;
}

export async function saveReview(db: D1Database, p: Actor & { review: ReviewRow; opportunityId: string; flags: ReviewFlags; eventId: string; auditId: string }): Promise<boolean> {
  const f = p.flags;
  const r = await db.batch([
    db.prepare("UPDATE seller_publication_reviews SET status = 'DRAFT', scope_text = ?, scope_confirmed = ?, confidentiality_reviewed = ?, public_fields_approved = ?, sensitive_data_reviewed = ?, image_rights_checked = ?, legal_review_completed = ?, notes = ?, approved_by = NULL, approved_at = NULL, version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND status <> 'APPROVED'")
      .bind(f.scopeText, f.scopeConfirmed, f.confidentialityReviewed, f.publicFieldsApproved, f.sensitiveDataReviewed, f.imageRightsChecked, f.legalReviewCompleted, f.notes, p.ts, p.review.id, p.review.version),
    db.prepare(`${EVENT} SELECT ?, ?, ?, 'saved', '', ?, ? WHERE changes() > 0`).bind(p.eventId, p.review.id, p.opportunityId, p.id, p.ts),
    auditIfChangedStmt(db, { id: p.auditId, actorId: p.id, action: 'seller_publication.review_saved', entityType: 'opportunity', entityId: p.opportunityId, requestId: p.requestId, details: { version: p.review.version + 1 }, ts: p.ts }),
  ]);
  return (r[0]?.meta?.changes ?? 0) > 0;
}

/** approve | reject | revoke. Revoke also withdraws the listing from the website atomically. */
export async function decideReview(db: D1Database, p: Actor & { review: ReviewRow; opportunityId: string; decision: 'approve' | 'reject' | 'revoke'; note: string; eventId: string; auditId: string }): Promise<boolean> {
  const to = p.decision === 'approve' ? 'APPROVED' : p.decision === 'reject' ? 'REJECTED' : 'REVOKED';
  const from = p.decision === 'revoke' ? "status = 'APPROVED'" : "status = 'DRAFT'";
  const stmts: D1PreparedStatement[] = [
    db.prepare(`UPDATE seller_publication_reviews SET status = ?, approved_by = CASE WHEN ? = 'APPROVED' THEN ? ELSE approved_by END, approved_at = CASE WHEN ? = 'APPROVED' THEN ? ELSE approved_at END,
        revoked_by = CASE WHEN ? = 'REVOKED' THEN ? ELSE revoked_by END, revoked_at = CASE WHEN ? = 'REVOKED' THEN ? ELSE revoked_at END, version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND ${from}`)
      .bind(to, to, p.id, to, p.ts, to, p.id, to, p.ts, p.ts, p.review.id, p.review.version),
    db.prepare(`${EVENT} SELECT ?, ?, ?, ?, ?, ?, ? WHERE changes() > 0`).bind(p.eventId, p.review.id, p.opportunityId, p.decision, p.note, p.id, p.ts),
    auditIfChangedStmt(db, { id: p.auditId, actorId: p.id, action: `seller_publication.${p.decision}`, entityType: 'opportunity', entityId: p.opportunityId, requestId: p.requestId, details: { fromStatus: p.review.status, to }, ts: p.ts }),
  ];
  if (p.decision === 'revoke') {
    const guard = "EXISTS (SELECT 1 FROM seller_publication_reviews WHERE id = ? AND status = 'REVOKED' AND version = ?)";
    stmts.push(
      db.prepare(`INSERT INTO audit_logs (id, actor_user_id, actor_type, action, entity_type, entity_id, request_id, details_json, created_at)
          SELECT lower(hex(randomblob(16))), ?, 'staff', 'seller_publication.opportunity_withdrawn', 'opportunity', o.id, ?, '{}', ? FROM opportunities o WHERE o.id = ? AND (o.public_visibility = 1 OR o.lifecycle = 'published') AND ${guard}`)
        .bind(p.id, p.requestId, p.ts, p.opportunityId, p.review.id, p.review.version + 1),
      db.prepare(`UPDATE opportunities SET lifecycle = CASE WHEN lifecycle = 'published' THEN 'in_review' ELSE lifecycle END, public_visibility = 0, updated_at = ? WHERE id = ? AND (public_visibility = 1 OR lifecycle = 'published') AND ${guard}`)
        .bind(p.ts, p.opportunityId, p.review.id, p.review.version + 1),
    );
  }
  const r = await db.batch(stmts);
  return (r[0]?.meta?.changes ?? 0) > 0;
}

export interface ConversionInput {
  enquiryId: string; enquiryReference: string; expectedVersion: number; sellerId: string; sellerReference: string; role: string; assignedBrokerId: string | null;
  opportunityId: string; slug: string; title: string; country: string; opportunityType: string; snapshotJson: string;
  linkId: string; versionId: string; historyId: string; auditEnquiryId: string; auditOpportunityId: string;
}
/**
 * Explicit conversion: a QUALIFIED enquiry with a linked seller becomes CONVERTED and a private draft opportunity is created and linked,
 * all in one transaction guarded by the enquiry version. Nothing is copied into public fields; the draft starts confidential, unreviewed, not public.
 */
export async function convertEnquiry(db: D1Database, p: Actor & ConversionInput): Promise<boolean> {
  const guard = "id = ? AND version = ? AND status = 'QUALIFIED' AND seller_id = ? AND anonymised_at IS NULL";
  const r = await db.batch([
    db.prepare(`INSERT INTO opportunities (id, slug, title, country, opportunity_type, classification, labels_json, price_text, price_visibility, lifecycle, content_review_status, summary, body_html, availability, public_visibility, seo_title, seo_description, assigned_broker_id, created_at, updated_at)
        SELECT ?, ?, ?, ?, ?, 'confidential', '[]', '', 0, 'draft', 'pending', '', '', '', 0, '', '', ?, ?, ? FROM seller_enquiries WHERE ${guard}`)
      .bind(p.opportunityId, p.slug, p.title, p.country, p.opportunityType, p.assignedBrokerId, p.ts, p.ts, p.enquiryId, p.expectedVersion, p.sellerId),
    db.prepare('INSERT INTO opportunity_versions (id, opportunity_id, version_number, snapshot_json, changed_by, change_reason, created_at) SELECT ?, ?, 1, ?, ?, ?, ? WHERE changes() > 0')
      .bind(p.versionId, p.opportunityId, p.snapshotJson, p.id, `Created from seller enquiry ${p.enquiryReference}`, p.ts),
    db.prepare("INSERT INTO seller_opportunity_links (id, seller_id, opportunity_id, role, relationship_status, started_at, review_status, created_by, created_at, updated_at) SELECT ?, ?, ?, ?, 'ACTIVE', ?, 'PENDING', ?, ?, ? WHERE changes() > 0")
      .bind(p.linkId, p.sellerId, p.opportunityId, p.role, p.ts, p.id, p.ts, p.ts),
    db.prepare(`UPDATE seller_enquiries SET status = 'CONVERTED', version = version + 1, updated_at = ?, closed_at = ?, closure_reason = 'Converted to a seller opportunity' WHERE ${guard} AND EXISTS (SELECT 1 FROM opportunities WHERE id = ?)`)
      .bind(p.ts, p.ts, p.enquiryId, p.expectedVersion, p.sellerId, p.opportunityId),
    db.prepare("INSERT INTO seller_enquiry_status_history (id, enquiry_id, from_status, to_status, reason, actor_user_id, created_at) SELECT ?, ?, 'QUALIFIED', 'CONVERTED', 'Converted to a private draft opportunity', ?, ? WHERE changes() > 0")
      .bind(p.historyId, p.enquiryId, p.id, p.ts),
    auditIfChangedStmt(db, { id: p.auditEnquiryId, actorId: p.id, action: 'seller_enquiry.converted', entityType: 'seller_enquiry', entityId: p.enquiryId, requestId: p.requestId, details: { reference: p.enquiryReference, seller: p.sellerReference, opportunityId: p.opportunityId }, ts: p.ts }),
    auditIfChangedStmt(db, { id: p.auditOpportunityId, actorId: p.id, action: 'opportunity.created_from_seller_enquiry', entityType: 'opportunity', entityId: p.opportunityId, requestId: p.requestId, details: { slug: p.slug, role: p.role }, ts: p.ts }),
  ]);
  return (r[3]?.meta?.changes ?? 0) > 0;
}
