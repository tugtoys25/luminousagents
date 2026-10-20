/** SQL for seller relationship records and seller<->opportunity links. Brokers see only sellers they own. */
import { auditIfChangedStmt, auditStmt } from './audit-repo';
type Row = Record<string, unknown>;
export interface SellerScope { brokerOnly: 0 | 1; staffId: string }
export interface SellerRef { id: string; reference: string; status: string; version: number; owner: string | null }
export interface Actor { id: string; requestId: string; ts: string }
export const SELLER_PAGE_SIZE = 25;

export function findSellerRef(db: D1Database, reference: string, s: SellerScope): Promise<SellerRef | null> {
  return db.prepare('SELECT id, reference, status, version, relationship_owner AS owner FROM sellers WHERE reference = ? AND anonymised_at IS NULL AND (? = 0 OR relationship_owner = ?)').bind(reference, s.brokerOnly, s.staffId).first<SellerRef>();
}

/** For internal use after the caller has already been authorised for the owning enquiry. */
export function findSellerById(db: D1Database, sellerId: string): Promise<{ id: string; reference: string } | null> {
  return db.prepare('SELECT id, reference FROM sellers WHERE id = ? AND anonymised_at IS NULL').bind(sellerId).first<{ id: string; reference: string }>();
}

export async function listSellers(db: D1Database, f: { q?: string | undefined; status?: string | undefined; page: number }, s: SellerScope): Promise<{ rows: Row[]; total: number }> {
  const like = `%${(f.q ?? '').replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const where = `WHERE x.anonymised_at IS NULL AND (? = '' OR x.status = ?) AND (? = '' OR x.reference LIKE ? ESCAPE '\\' OR x.display_name LIKE ? ESCAPE '\\' OR x.organisation LIKE ? ESCAPE '\\' OR x.contact_email LIKE ? ESCAPE '\\') AND (? = 0 OR x.relationship_owner = ?)`;
  const binds = [f.status ?? '', f.status ?? '', f.q ?? '', like, like, like, like, s.brokerOnly, s.staffId];
  const rows = await db.prepare(`SELECT x.reference, x.display_name AS displayName, x.organisation, x.status, u.display_name AS ownerName, x.created_at AS createdAt,
      (SELECT COUNT(*) FROM seller_enquiries e WHERE e.seller_id = x.id) AS enquiryCount,
      (SELECT COUNT(*) FROM seller_opportunity_links l WHERE l.seller_id = x.id AND l.relationship_status = 'ACTIVE') AS opportunityCount
    FROM sellers x LEFT JOIN users u ON u.id = x.relationship_owner ${where} ORDER BY x.created_at DESC, x.id DESC LIMIT ${SELLER_PAGE_SIZE} OFFSET ?`).bind(...binds, (f.page - 1) * SELLER_PAGE_SIZE).all<Row>();
  const total = await db.prepare(`SELECT COUNT(*) AS total FROM sellers x ${where}`).bind(...binds).first<{ total: number }>();
  return { rows: rows.results ?? [], total: total?.total ?? 0 };
}

export function getSeller(db: D1Database, reference: string, s: SellerScope): Promise<Row | null> {
  return db.prepare(`SELECT x.id, x.reference, x.display_name AS displayName, x.organisation, x.contact_name AS contactName, x.contact_email AS contactEmail, x.contact_telephone AS contactTelephone,
      x.contact_country AS contactCountry, x.preferred_contact_method AS preferredContactMethod, x.relationship_owner AS ownerId, u.display_name AS ownerName,
      x.confidentiality_restrictions AS confidentialityRestrictions, x.status, x.version, x.created_at AS createdAt, x.updated_at AS updatedAt, x.retention_review_at AS retentionReviewAt
    FROM sellers x LEFT JOIN users u ON u.id = x.relationship_owner WHERE x.reference = ? AND x.anonymised_at IS NULL AND (? = 0 OR x.relationship_owner = ?)`).bind(reference, s.brokerOnly, s.staffId).first<Row>();
}
const all = async (st: D1PreparedStatement): Promise<Row[]> => (await st.all<Row>()).results ?? [];
export const listSellerEnquiries = (db: D1Database, sellerId: string) =>
  all(db.prepare('SELECT reference, status, asset_type AS assetType, asset_country AS assetCountry, created_at AS createdAt FROM seller_enquiries WHERE seller_id = ? ORDER BY created_at DESC LIMIT 50').bind(sellerId));
export const listSellerLinks = (db: D1Database, sellerId: string) =>
  all(db.prepare(`SELECT l.id, l.opportunity_id AS opportunityId, l.role, l.relationship_status AS relationshipStatus, l.review_status AS reviewStatus, l.confidentiality_restrictions AS confidentialityRestrictions,
      l.started_at AS startedAt, l.ended_at AS endedAt, o.title AS opportunityTitle, o.lifecycle, o.public_visibility AS publicVisibility, o.content_review_status AS contentReviewStatus
    FROM seller_opportunity_links l JOIN opportunities o ON o.id = l.opportunity_id WHERE l.seller_id = ? ORDER BY l.created_at DESC LIMIT 100`).bind(sellerId));
export const listSellerAuthority = (db: D1Database, sellerId: string) =>
  all(db.prepare(`SELECT r.reference, r.link_id AS linkId, r.authority_type AS authorityType, r.status, r.evidence_type AS evidenceType, r.evidence_ref AS evidenceRef, r.scope, r.limitations, r.exclusive,
      r.valid_from AS validFrom, r.valid_until AS validUntil, r.review_notes AS reviewNotes, r.reviewed_at AS reviewedAt, r.version, rv.display_name AS reviewerName, cr.display_name AS createdByName
    FROM seller_authority_records r JOIN seller_opportunity_links l ON l.id = r.link_id LEFT JOIN users rv ON rv.id = r.reviewed_by LEFT JOIN users cr ON cr.id = r.created_by
    WHERE l.seller_id = ? ORDER BY r.created_at DESC LIMIT 200`).bind(sellerId));
export const listSellerChanges = (db: D1Database, sellerId: string) =>
  all(db.prepare('SELECT c.field, c.old_value AS oldValue, c.new_value AS newValue, c.reason, c.created_at AS createdAt, u.display_name AS actorName FROM seller_changes c JOIN users u ON u.id = c.actor_user_id WHERE c.seller_id = ? ORDER BY c.created_at DESC LIMIT 100').bind(sellerId));
export const listSellerFollowups = (db: D1Database, sellerId: string) =>
  all(db.prepare("SELECT t.title, t.status, t.due_at AS dueAt, t.outcome FROM staff_tasks t JOIN seller_enquiries e ON e.id = t.related_entity_id WHERE t.related_entity_type = 'seller_enquiry' AND e.seller_id = ? ORDER BY (t.status IN ('done','cancelled')), t.due_at LIMIT 50").bind(sellerId));
export const listSellerCommunications = (db: D1Database, sellerId: string) =>
  all(db.prepare('SELECT c.direction, c.channel, c.outcome, c.summary, c.occurred_at AS occurredAt FROM seller_communications c JOIN seller_enquiries e ON e.id = c.enquiry_id WHERE e.seller_id = ? ORDER BY c.occurred_at DESC LIMIT 50').bind(sellerId));
export const listSellerNotes = (db: D1Database, sellerId: string) =>
  all(db.prepare('SELECT n.classification, n.note, n.created_at AS createdAt, u.display_name AS authorName FROM seller_enquiry_notes n JOIN seller_enquiries e ON e.id = n.enquiry_id JOIN users u ON u.id = n.author_id WHERE e.seller_id = ? ORDER BY n.created_at DESC LIMIT 50').bind(sellerId));
/** Hint only (never auto-merged): other sellers with the same contact email, managers only. */
export const sellersWithEmail = (db: D1Database, email: string) =>
  all(db.prepare('SELECT reference, display_name AS displayName FROM sellers WHERE contact_email = ? COLLATE NOCASE AND anonymised_at IS NULL LIMIT 10').bind(email));

const SELLER_COLS = `INSERT INTO sellers (id, reference, display_name, organisation, contact_name, contact_email, contact_telephone, contact_country, preferred_contact_method,
  relationship_owner, source_enquiry_id, confidentiality_restrictions, status, version, created_by, created_at, updated_at)`;

/**
 * Creates a seller from the enquiry's own stored data (never from client-supplied fields) and links the enquiry,
 * atomically and only if the enquiry is still unlinked at the expected version. Returns false if it changed.
 */
export async function createSellerFromEnquiry(db: D1Database, p: Actor & { enquiryId: string; expectedVersion: number; sellerId: string; reference: string; ownerId: string; auditId: string; enquiryReference: string }): Promise<boolean> {
  const r = await db.batch([
    db.prepare(`${SELLER_COLS} SELECT ?, ?, COALESCE(NULLIF(organisation, ''), contact_name), organisation, contact_name, email, telephone, contact_country, preferred_contact_method, ?, id,
        CASE confidentiality_preference WHEN 'CONTACT_BEFORE_PUBLIC_IDENTIFICATION' THEN 'Contact seller before any public identification of the asset.' ELSE '' END,
        'ACTIVE', 1, ?, ?, ? FROM seller_enquiries WHERE id = ? AND version = ? AND seller_id IS NULL AND anonymised_at IS NULL`)
      .bind(p.sellerId, p.reference, p.ownerId, p.id, p.ts, p.ts, p.enquiryId, p.expectedVersion),
    db.prepare('UPDATE seller_enquiries SET seller_id = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND seller_id IS NULL AND EXISTS (SELECT 1 FROM sellers WHERE id = ?)')
      .bind(p.sellerId, p.ts, p.enquiryId, p.expectedVersion, p.sellerId),
    auditIfChangedStmt(db, { id: p.auditId, actorId: p.id, action: 'seller.created_from_enquiry', entityType: 'seller', entityId: p.sellerId, requestId: p.requestId, details: { reference: p.reference, enquiry: p.enquiryReference }, ts: p.ts }),
  ]);
  return (r[1]?.meta?.changes ?? 0) > 0;
}

export async function linkEnquiryToSeller(db: D1Database, p: Actor & { enquiryId: string; expectedVersion: number; seller: SellerRef; auditId: string; enquiryReference: string }): Promise<boolean> {
  const r = await db.batch([
    db.prepare('UPDATE seller_enquiries SET seller_id = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND seller_id IS NULL').bind(p.seller.id, p.ts, p.enquiryId, p.expectedVersion),
    auditIfChangedStmt(db, { id: p.auditId, actorId: p.id, action: 'seller.enquiry_linked', entityType: 'seller', entityId: p.seller.id, requestId: p.requestId, details: { reference: p.seller.reference, enquiry: p.enquiryReference }, ts: p.ts }),
  ]);
  return (r[0]?.meta?.changes ?? 0) > 0;
}

/** Applies corrections as a version-checked update and records each changed field (old and new value) with the reason. */
export async function updateSeller(db: D1Database, p: Actor & { seller: SellerRef; changes: Array<{ column: string; field: string; oldValue: string | null; newValue: string | null; changeId: string }>; reason: string; auditId: string }): Promise<boolean> {
  const sets = p.changes.map((c) => `${c.column} = ?`).join(', ');
  const r = await db.batch([
    db.prepare(`UPDATE sellers SET ${sets}, version = version + 1, updated_at = ? WHERE id = ? AND version = ?`).bind(...p.changes.map((c) => c.newValue), p.ts, p.seller.id, p.seller.version),
    ...p.changes.map((c) => db.prepare('INSERT INTO seller_changes (id, seller_id, field, old_value, new_value, reason, actor_user_id, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() > 0').bind(c.changeId, p.seller.id, c.field, c.oldValue, c.newValue, p.reason, p.id, p.ts)),
    auditStmt(db, { id: p.auditId, actorId: p.id, action: 'seller.corrected', entityType: 'seller', entityId: p.seller.id, requestId: p.requestId, details: { reference: p.seller.reference, fields: p.changes.map((c) => c.field) }, ts: p.ts }),
  ]);
  return (r[0]?.meta?.changes ?? 0) > 0;
}

export interface LinkRef { id: string; sellerId: string; opportunityId: string; relationshipStatus: string; reviewStatus: string }
export function findLink(db: D1Database, sellerId: string, linkId: string): Promise<LinkRef | null> {
  return db.prepare('SELECT id, seller_id AS sellerId, opportunity_id AS opportunityId, relationship_status AS relationshipStatus, review_status AS reviewStatus FROM seller_opportunity_links WHERE id = ? AND seller_id = ?').bind(linkId, sellerId).first<LinkRef>();
}

/** Links an existing opportunity only while it is private (not public, not published). A live listing is never pulled under seller gates silently. */
export async function insertLink(db: D1Database, p: Actor & { linkId: string; sellerId: string; sellerReference: string; opportunityId: string; role: string; restrictions: string; auditId: string }): Promise<boolean> {
  const r = await db.batch([
    db.prepare(`INSERT INTO seller_opportunity_links (id, seller_id, opportunity_id, role, relationship_status, started_at, confidentiality_restrictions, review_status, created_by, created_at, updated_at)
        SELECT ?, ?, id, ?, 'ACTIVE', ?, ?, 'PENDING', ?, ?, ? FROM opportunities WHERE id = ? AND public_visibility = 0 AND lifecycle <> 'published'
        AND NOT EXISTS (SELECT 1 FROM seller_opportunity_links WHERE seller_id = ? AND opportunity_id = ?)`)
      .bind(p.linkId, p.sellerId, p.role, p.ts, p.restrictions, p.id, p.ts, p.ts, p.opportunityId, p.sellerId, p.opportunityId),
    auditIfChangedStmt(db, { id: p.auditId, actorId: p.id, action: 'seller.opportunity_linked', entityType: 'seller', entityId: p.sellerId, requestId: p.requestId, details: { reference: p.sellerReference, opportunityId: p.opportunityId, role: p.role }, ts: p.ts }),
  ]);
  return (r[0]?.meta?.changes ?? 0) > 0;
}

export async function reviewLink(db: D1Database, p: Actor & { link: LinkRef; sellerReference: string; auditId: string }): Promise<boolean> {
  const r = await db.batch([
    db.prepare("UPDATE seller_opportunity_links SET review_status = 'REVIEWED', reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ? AND relationship_status = 'ACTIVE'").bind(p.id, p.ts, p.ts, p.link.id),
    auditIfChangedStmt(db, { id: p.auditId, actorId: p.id, action: 'seller.link_confidentiality_reviewed', entityType: 'seller', entityId: p.link.sellerId, requestId: p.requestId, details: { reference: p.sellerReference, linkId: p.link.id }, ts: p.ts }),
  ]);
  return (r[0]?.meta?.changes ?? 0) > 0;
}

/** Ends a relationship only while the opportunity is not live. The opportunity stays seller-gated (the link row remains). */
export async function endLink(db: D1Database, p: Actor & { link: LinkRef; sellerReference: string; auditId: string }): Promise<boolean> {
  const r = await db.batch([
    db.prepare("UPDATE seller_opportunity_links SET relationship_status = 'ENDED', ended_at = ?, updated_at = ? WHERE id = ? AND relationship_status = 'ACTIVE' AND NOT EXISTS (SELECT 1 FROM opportunities o WHERE o.id = opportunity_id AND (o.public_visibility = 1 OR o.lifecycle = 'published'))").bind(p.ts, p.ts, p.link.id),
    auditIfChangedStmt(db, { id: p.auditId, actorId: p.id, action: 'seller.link_ended', entityType: 'seller', entityId: p.link.sellerId, requestId: p.requestId, details: { reference: p.sellerReference, linkId: p.link.id }, ts: p.ts }),
  ]);
  return (r[0]?.meta?.changes ?? 0) > 0;
}

export const listSellerContacts = (db: D1Database, sellerId: string) =>
  all(db.prepare("SELECT c.id, c.name, c.role_title AS roleTitle, c.email, c.telephone, c.created_at AS createdAt, u.display_name AS createdByName FROM seller_contacts c JOIN users u ON u.id = c.created_by WHERE c.seller_id = ? AND c.status = 'ACTIVE' ORDER BY c.created_at LIMIT 50").bind(sellerId));

/** Additional contacts are informational. Seller notices still go only to the seller's primary contact email. */
export async function insertContact(db: D1Database, p: Actor & { seller: SellerRef; contactId: string; name: string; roleTitle: string; email: string; telephone: string | null; auditId: string }): Promise<boolean> {
  const r = await db.batch([
    db.prepare("INSERT INTO seller_contacts (id, seller_id, name, role_title, email, telephone, status, created_by, created_at, updated_at) SELECT ?, id, ?, ?, ?, ?, 'ACTIVE', ?, ?, ? FROM sellers WHERE id = ? AND anonymised_at IS NULL AND status <> 'INACTIVE'")
      .bind(p.contactId, p.name, p.roleTitle, p.email, p.telephone, p.id, p.ts, p.ts, p.seller.id),
    auditIfChangedStmt(db, { id: p.auditId, actorId: p.id, action: 'seller.contact_added', entityType: 'seller', entityId: p.seller.id, requestId: p.requestId, details: { reference: p.seller.reference, contactId: p.contactId }, ts: p.ts }),
  ]);
  return (r[0]?.meta?.changes ?? 0) > 0;
}
export async function removeContact(db: D1Database, p: Actor & { seller: SellerRef; contactId: string; auditId: string }): Promise<boolean> {
  const r = await db.batch([
    db.prepare("UPDATE seller_contacts SET status = 'REMOVED', removed_by = ?, removed_at = ?, updated_at = ? WHERE id = ? AND seller_id = ? AND status = 'ACTIVE'").bind(p.id, p.ts, p.ts, p.contactId, p.seller.id),
    auditIfChangedStmt(db, { id: p.auditId, actorId: p.id, action: 'seller.contact_removed', entityType: 'seller', entityId: p.seller.id, requestId: p.requestId, details: { reference: p.seller.reference, contactId: p.contactId }, ts: p.ts }),
  ]);
  return (r[0]?.meta?.changes ?? 0) > 0;
}
