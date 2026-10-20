/** Shared helpers for seller integration tests that run against the real D1 test database. Synthetic data only. */
import { changeAuthority, findAuthority, insertAuthority } from '../../src/seller/authority-repo';
import { insertSellerEnquiry } from '../../src/seller/repo';
import { createSellerFromEnquiry, insertLink, reviewLink } from '../../src/seller/seller-repo';
import { normaliseSellerEnquiry, sellerEnquirySchema } from '../../src/seller/schema';
import { valid } from './seller-fixtures';

export const rid = (): string => crypto.randomUUID();
export const ts = (): string => new Date().toISOString();
export const adminScope = { brokerOnly: 0 as const, staffId: 'x' };

export async function makeStaff(db: D1Database, role = 'admin'): Promise<string> {
  const id = rid();
  await db.prepare("INSERT INTO users (id,email,display_name,user_type,role,status,password_hash,must_change_password,created_at,updated_at) VALUES (?,?,?,'staff',?,'active','x',0,?,?)")
    .bind(id, `${role}-${id}@example.test`, `Test ${role}`, role, ts(), ts()).run();
  return id;
}

/** A QUALIFIED enquiry owned by `owner`, a seller created from it, and a private opportunity linked to that seller. */
export async function convertedSeller(db: D1Database, owner: string) {
  const enquiryId = rid();
  const enquiryReference = `CM-S-${enquiryId.slice(0, 6).toUpperCase().replace(/[01OI]/g, 'C')}`;
  const data = normaliseSellerEnquiry(sellerEnquirySchema.parse({ ...valid(), idempotency_key: `k${enquiryId.replace(/-/g, '')}` }), false);
  await insertSellerEnquiry(db, { id: enquiryId, reference: enquiryReference, data, idempotencyHash: `h-${enquiryId}`, sourceIpHash: null, requestId: 'r', auditId: rid(), ackJobId: rid(), alertJobId: rid(), timestamp: ts() });
  await db.prepare("UPDATE seller_enquiries SET status = 'QUALIFICATION', assigned_to = ? WHERE id = ?").bind(owner, enquiryId).run();
  const sellerId = rid();
  const reference = `CM-C-${sellerId.slice(0, 6).toUpperCase().replace(/[01OI]/g, 'D')}`;
  await createSellerFromEnquiry(db, { id: owner, requestId: 'r', ts: ts(), enquiryId, expectedVersion: 1, sellerId, reference, ownerId: owner, auditId: rid(), enquiryReference });
  const opportunityId = rid();
  await db.prepare("INSERT INTO opportunities (id, slug, title, created_at, updated_at) VALUES (?, ?, 'Confidential casino opportunity', ?, ?)").bind(opportunityId, `slug-${opportunityId}`, ts(), ts()).run();
  const linkId = rid();
  await insertLink(db, { id: owner, requestId: 'r', ts: ts(), linkId, sellerId, sellerReference: reference, opportunityId, role: 'OWNER', restrictions: '', auditId: rid() });
  return { enquiryId, enquiryReference, sellerId, reference, opportunityId, linkId };
}

export async function reviewTheLink(db: D1Database, ctx: { linkId: string; sellerId: string; opportunityId: string; reference: string }, reviewer: string): Promise<void> {
  await reviewLink(db, { id: reviewer, requestId: 'r', ts: ts(), link: { id: ctx.linkId, sellerId: ctx.sellerId, opportunityId: ctx.opportunityId, relationshipStatus: 'ACTIVE', reviewStatus: 'PENDING' }, sellerReference: ctx.reference, auditId: rid() });
}

/** Records an authority claim and walks it to VERIFIED through the real repository functions. Returns its reference. */
export async function verifiedAuthority(db: D1Database, ctx: { sellerId: string; reference: string; linkId: string }, creator: string, reviewer: string, authorityType: string): Promise<string> {
  const reference = `CM-A-${rid().slice(0, 6).toUpperCase().replace(/[01OI]/g, 'B')}`;
  await insertAuthority(db, { id: creator, requestId: 'r', ts: ts(), recordId: rid(), reference, eventId: rid(), auditId: rid(), sellerId: ctx.sellerId, sellerReference: ctx.reference, linkId: ctx.linkId, authorityType, evidenceType: 'SIGNED_MANDATE', evidenceRef: 'DOC-0042', scope: 'Representation of the seller', limitations: '', exclusive: false, validFrom: null, validUntil: null });
  for (const to of ['UNDER_REVIEW', 'VERIFIED']) {
    const record = (await findAuthority(db, reference, adminScope))!;
    await changeAuthority(db, { id: reviewer, requestId: 'r', ts: ts(), record, to, note: 'Reviewed evidence', reviewerId: reviewer, eventId: rid(), auditId: rid(), withdrawAuditAction: 'authority.test_withdrew', evidenceType: null, evidenceRef: null, scope: null, limitations: null, validFrom: null, validUntil: null });
  }
  return reference;
}

export async function revokeAuthority(db: D1Database, reference: string, reviewer: string): Promise<void> {
  const record = (await findAuthority(db, reference, adminScope))!;
  await changeAuthority(db, { id: reviewer, requestId: 'r', ts: ts(), record, to: 'REVOKED', note: 'Seller withdrew it', reviewerId: reviewer, eventId: rid(), auditId: rid(), withdrawAuditAction: 'authority.revoked_withdrew_listing', evidenceType: null, evidenceRef: null, scope: null, limitations: null, validUntil: null, validFrom: null });
}

/** An enquiry with no seller link, in the given status (closed_at set when terminal), plus staff free text attached to it. */
export async function plainEnquiry(db: D1Database, owner: string, status: string, closedAt: string | null = null) {
  const id = rid();
  const reference = `CM-S-${id.slice(0, 6).toUpperCase().replace(/[01OI]/g, 'F')}`;
  const data = normaliseSellerEnquiry(sellerEnquirySchema.parse({ ...valid(), idempotency_key: `k${id.replace(/-/g, '')}`, contact_name: 'Jane Personal' }), false);
  await insertSellerEnquiry(db, { id, reference, data, idempotencyHash: `h-${id}`, sourceIpHash: 'iphash', requestId: 'r', auditId: rid(), ackJobId: rid(), alertJobId: rid(), timestamp: ts() });
  await db.prepare('UPDATE seller_enquiries SET status = ?, closed_at = ?, assigned_to = ? WHERE id = ?').bind(status, closedAt, owner, id).run();
  await db.prepare("INSERT INTO seller_enquiry_notes (id, enquiry_id, author_id, note, created_at) VALUES (?, ?, ?, 'Jane said her husband is the real owner', ?)").bind(rid(), id, owner, ts()).run();
  await db.prepare("INSERT INTO staff_tasks (id, title, description, status, priority, due_at, assigned_to, related_entity_type, related_entity_id, created_by, created_at, updated_at) VALUES (?, 'Call Jane Personal', 'about her husband', 'done', 'normal', ?, ?, 'seller_enquiry', ?, ?, ?, ?)").bind(rid(), ts(), owner, id, owner, ts(), ts()).run();
  return { id, reference };
}
