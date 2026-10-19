/** SQL for authority/mandate records. Every change is version-guarded and writes its event and audit rows in the same batch. */
import { auditIfChangedStmt } from './audit-repo';
import type { Actor, SellerScope } from './seller-repo';

export interface AuthorityRef {
  id: string; reference: string; linkId: string; sellerId: string; sellerReference: string; opportunityId: string; authorityType: string;
  status: string; version: number; createdBy: string; evidenceType: string; scope: string; validFrom: string | null; validUntil: string | null;
}
export function findAuthority(db: D1Database, reference: string, s: SellerScope): Promise<AuthorityRef | null> {
  return db.prepare(`SELECT r.id, r.reference, r.link_id AS linkId, l.seller_id AS sellerId, x.reference AS sellerReference, l.opportunity_id AS opportunityId, r.authority_type AS authorityType,
      r.status, r.version, r.created_by AS createdBy, r.evidence_type AS evidenceType, r.scope, r.valid_from AS validFrom, r.valid_until AS validUntil
    FROM seller_authority_records r JOIN seller_opportunity_links l ON l.id = r.link_id JOIN sellers x ON x.id = l.seller_id
    WHERE r.reference = ? AND x.anonymised_at IS NULL AND (? = 0 OR x.relationship_owner = ?)`).bind(reference, s.brokerOnly, s.staffId).first<AuthorityRef>();
}
export interface LinkedOpportunity { id: string; slug: string; country: string | null; live: number }
export function opportunityForLink(db: D1Database, linkId: string): Promise<LinkedOpportunity | null> {
  return db.prepare("SELECT o.id, o.slug, o.country, CASE WHEN o.public_visibility = 1 OR o.lifecycle = 'published' THEN 1 ELSE 0 END AS live FROM seller_opportunity_links l JOIN opportunities o ON o.id = l.opportunity_id WHERE l.id = ?").bind(linkId).first<LinkedOpportunity>();
}

export interface NewAuthority {
  recordId: string; reference: string; eventId: string; auditId: string; sellerId: string; sellerReference: string; linkId: string; authorityType: string;
  evidenceType: string; evidenceRef: string | null; scope: string; limitations: string; exclusive: boolean; validFrom: string | null; validUntil: string | null;
}
/** Only an ACTIVE link of this seller can receive a record. */
export async function insertAuthority(db: D1Database, p: Actor & NewAuthority): Promise<boolean> {
  const r = await db.batch([
    db.prepare(`INSERT INTO seller_authority_records (id, reference, link_id, authority_type, evidence_type, evidence_ref, status, scope, limitations, exclusive, valid_from, valid_until, created_by, version, created_at, updated_at)
        SELECT ?, ?, id, ?, ?, ?, 'NOT_REVIEWED', ?, ?, ?, ?, ?, ?, 1, ?, ? FROM seller_opportunity_links WHERE id = ? AND seller_id = ? AND relationship_status = 'ACTIVE'`)
      .bind(p.recordId, p.reference, p.authorityType, p.evidenceType, p.evidenceRef, p.scope, p.limitations, p.exclusive ? 1 : 0, p.validFrom, p.validUntil, p.id, p.ts, p.ts, p.linkId, p.sellerId),
    db.prepare("INSERT INTO seller_authority_events (id, record_id, from_status, to_status, note, actor_user_id, created_at) SELECT ?, ?, 'NOT_REVIEWED', 'NOT_REVIEWED', 'Record created', ?, ? WHERE changes() > 0").bind(p.eventId, p.recordId, p.id, p.ts),
    auditIfChangedStmt(db, { id: p.auditId, actorId: p.id, action: 'authority.recorded', entityType: 'seller', entityId: p.sellerId, requestId: p.requestId, details: { seller: p.sellerReference, reference: p.reference, authorityType: p.authorityType }, ts: p.ts }),
  ]);
  return (r[0]?.meta?.changes ?? 0) > 0;
}

export interface AuthorityChange {
  record: AuthorityRef; to: string; note: string; reviewerId: string | null; eventId: string; auditId: string; withdrawAuditAction: string;
  evidenceType: string | null; evidenceRef: string | null; scope: string | null; limitations: string | null; validFrom: string | null; validUntil: string | null;
}
const WITHDRAW_TYPES = ['AUTHORITY_TO_MARKET', 'BROKERAGE_MANDATE'];
const SATISFIED = `(r2.status = 'NOT_REQUIRED_WITH_RECORDED_REASON' OR (r2.status = 'VERIFIED' AND (r2.valid_from IS NULL OR r2.valid_from <= ?) AND (r2.valid_until IS NULL OR r2.valid_until > ?)))`;

/**
 * Moves a record to a new status if it is still at the expected version and status. A revoked/expired marketing authority
 * or mandate also takes any live dependent opportunity off the website in the same transaction, unless another valid
 * record of the same type still covers the link. Returns false if the record changed underneath the caller.
 */
export async function changeAuthority(db: D1Database, p: Actor & AuthorityChange): Promise<boolean> {
  const rec = p.record;
  const withdraws = (p.to === 'REVOKED' || p.to === 'EXPIRED') && WITHDRAW_TYPES.includes(rec.authorityType);
  const stmts: D1PreparedStatement[] = [
    db.prepare(`UPDATE seller_authority_records SET status = ?, evidence_type = COALESCE(?, evidence_type), evidence_ref = COALESCE(?, evidence_ref), scope = COALESCE(?, scope),
        limitations = COALESCE(?, limitations), valid_from = COALESCE(?, valid_from), valid_until = COALESCE(?, valid_until), reviewed_by = COALESCE(?, reviewed_by),
        reviewed_at = CASE WHEN ? IS NULL THEN reviewed_at ELSE ? END, review_notes = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND status = ?`)
      .bind(p.to, p.evidenceType, p.evidenceRef, p.scope, p.limitations, p.validFrom, p.validUntil, p.reviewerId, p.reviewerId, p.ts, p.note, p.ts, rec.id, rec.version, rec.status),
    db.prepare('INSERT INTO seller_authority_events (id, record_id, from_status, to_status, note, actor_user_id, created_at) SELECT ?, ?, ?, ?, ?, ?, ? WHERE changes() > 0').bind(p.eventId, rec.id, rec.status, p.to, p.note, p.reviewerId, p.ts),
    auditIfChangedStmt(db, { id: p.auditId, actorId: p.reviewerId, action: `authority.${p.to.toLowerCase()}`, entityType: 'seller', entityId: rec.sellerId, requestId: p.requestId, details: { seller: rec.sellerReference, reference: rec.reference, authorityType: rec.authorityType, from: rec.status, to: p.to }, ts: p.ts }),
  ];
  if (withdraws) {
    const guard = `EXISTS (SELECT 1 FROM seller_authority_records WHERE id = ? AND status = ? AND version = ?) AND NOT EXISTS (SELECT 1 FROM seller_authority_records r2 WHERE r2.link_id = ? AND r2.authority_type = ? AND r2.id <> ? AND ${SATISFIED})`;
    const guardBinds = [rec.id, p.to, rec.version + 1, rec.linkId, rec.authorityType, rec.id, p.ts, p.ts];
    stmts.push(
      db.prepare(`INSERT INTO audit_logs (id, actor_user_id, actor_type, action, entity_type, entity_id, request_id, details_json, created_at)
          SELECT lower(hex(randomblob(16))), ?, ?, ?, 'opportunity', o.id, ?, ?, ? FROM opportunities o JOIN seller_opportunity_links l ON l.opportunity_id = o.id
          WHERE l.id = ? AND (o.public_visibility = 1 OR o.lifecycle = 'published') AND ${guard}`)
        .bind(p.reviewerId, p.reviewerId ? 'staff' : 'system', p.withdrawAuditAction, p.requestId, JSON.stringify({ authority: rec.reference, status: p.to }), p.ts, rec.linkId, ...guardBinds),
      db.prepare(`UPDATE opportunities SET lifecycle = CASE WHEN lifecycle = 'published' THEN 'in_review' ELSE lifecycle END, public_visibility = 0, updated_at = ?
          WHERE id = (SELECT opportunity_id FROM seller_opportunity_links WHERE id = ?) AND (public_visibility = 1 OR lifecycle = 'published') AND ${guard}`)
        .bind(p.ts, rec.linkId, ...guardBinds),
    );
  }
  const r = await db.batch(stmts);
  return (r[0]?.meta?.changes ?? 0) > 0;
}

/** VERIFIED records whose validity window has closed. The publication gate already ignores them; this makes the status honest. */
export async function listExpiredVerified(db: D1Database, nowIso: string, limit: number): Promise<AuthorityRef[]> {
  const r = await db.prepare(`SELECT r.id, r.reference, r.link_id AS linkId, l.seller_id AS sellerId, x.reference AS sellerReference, l.opportunity_id AS opportunityId, r.authority_type AS authorityType,
      r.status, r.version, r.created_by AS createdBy, r.evidence_type AS evidenceType, r.scope, r.valid_from AS validFrom, r.valid_until AS validUntil FROM seller_authority_records r JOIN seller_opportunity_links l ON l.id = r.link_id JOIN sellers x ON x.id = l.seller_id
    WHERE r.status = 'VERIFIED' AND r.valid_until IS NOT NULL AND r.valid_until <= ? ORDER BY r.valid_until LIMIT ?`).bind(nowIso, limit).all<AuthorityRef>();
  return r.results ?? [];
}
