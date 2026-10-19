import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { runAuthorityExpiry } from '../../src/seller/authority-expiry';
import { changeAuthority, findAuthority, insertAuthority } from '../../src/seller/authority-repo';
import { sellerGateResult } from '../../src/seller/gate-check';
import { convertEnquiry, createReview, decideReview, getReview } from '../../src/seller/publication-repo';
import { insertSellerEnquiry } from '../../src/seller/repo';
import { createSellerFromEnquiry, insertLink, reviewLink } from '../../src/seller/seller-repo';
import { normaliseSellerEnquiry, sellerEnquirySchema } from '../../src/seller/schema';
import { valid } from '../support/seller-fixtures';

const db = env.DB;
const rid = () => crypto.randomUUID();
const ts = () => new Date().toISOString();
const scope = { brokerOnly: 0 as const, staffId: 'x' };

async function makeStaff(role = 'admin'): Promise<string> {
  const id = rid();
  const at = ts();
  await db.prepare("INSERT INTO users (id,email,display_name,user_type,role,status,password_hash,must_change_password,created_at,updated_at) VALUES (?,?,?,'staff',?,'active','x',0,?,?)")
    .bind(id, `${role}-${id}@example.test`, `Test ${role}`, role, at, at).run();
  return id;
}
async function makeOpportunity(): Promise<string> {
  const id = rid();
  await db.prepare("INSERT INTO opportunities (id, slug, title, created_at, updated_at) VALUES (?, ?, 'Confidential test opportunity', ?, ?)").bind(id, `slug-${id}`, ts(), ts()).run();
  return id;
}
const publish = (opportunityId: string) => db.prepare("UPDATE opportunities SET lifecycle = 'published', public_visibility = 1 WHERE id = ?").bind(opportunityId).run();
const state = (opportunityId: string) => db.prepare('SELECT lifecycle, public_visibility AS vis FROM opportunities WHERE id = ?').bind(opportunityId).first<{ lifecycle: string; vis: number }>();

/** A seller (inserted directly) linked to a fresh private opportunity through the real repository. */
async function sellerWithLink(actorId: string) {
  const sellerId = rid();
  const reference = `CM-C-${sellerId.slice(0, 6).toUpperCase().replace(/[01OI]/g, 'A')}`;
  await db.prepare("INSERT INTO sellers (id, reference, display_name, contact_name, contact_email, status, version, created_at, updated_at) VALUES (?, ?, 'Seller', 'Jane', 'jane@example.test', 'ACTIVE', 1, ?, ?)").bind(sellerId, reference, ts(), ts()).run();
  const opportunityId = await makeOpportunity();
  const linkId = rid();
  const ok = await insertLink(db, { id: actorId, requestId: 'r', ts: ts(), linkId, sellerId, sellerReference: reference, opportunityId, role: 'OWNER', restrictions: '', auditId: rid() });
  expect(ok).toBe(true);
  return { sellerId, reference, opportunityId, linkId };
}

/** Records an authority claim and walks it NOT_REVIEWED -> UNDER_REVIEW -> VERIFIED through the real repository. */
async function verified(ctx: { sellerId: string; reference: string; linkId: string }, creator: string, reviewer: string, authorityType: string, validUntil: string | null = null) {
  const reference = `CM-A-${rid().slice(0, 6).toUpperCase().replace(/[01OI]/g, 'B')}`;
  const base = { id: creator, requestId: 'r', ts: ts() };
  expect(await insertAuthority(db, { ...base, recordId: rid(), reference, eventId: rid(), auditId: rid(), sellerId: ctx.sellerId, sellerReference: ctx.reference, linkId: ctx.linkId, authorityType, evidenceType: 'SIGNED_MANDATE', evidenceRef: 'DOC-0042', scope: 'Marketing of the asset', limitations: '', exclusive: false, validFrom: null, validUntil })).toBe(true);
  const step = async (to: string, extra: { validUntil?: string | null } = {}) => {
    const record = await findAuthority(db, reference, scope);
    expect(record).not.toBeNull();
    expect(await changeAuthority(db, { id: reviewer, requestId: 'r', ts: ts(), record: record!, to, note: 'Reviewed evidence', reviewerId: reviewer, eventId: rid(), auditId: rid(), withdrawAuditAction: 'authority.test_withdrew', evidenceType: null, evidenceRef: null, scope: null, limitations: null, validFrom: null, validUntil: extra.validUntil ?? null })).toBe(true);
  };
  await step('UNDER_REVIEW');
  await step('VERIFIED');
  return reference;
}
async function approvedReview(opportunityId: string, preparer: string, approver: string) {
  const flags = { scopeText: 'Public listing of the asset in the stated market', scopeConfirmed: 1, confidentialityReviewed: 1, publicFieldsApproved: 1, sensitiveDataReviewed: 1, imageRightsChecked: 1, legalReviewCompleted: 1, notes: '' };
  expect(await createReview(db, { id: preparer, requestId: 'r', ts: ts(), reviewId: rid(), opportunityId, flags, eventId: rid(), auditId: rid() })).toBe(true);
  const review = (await getReview(db, opportunityId))!;
  expect(await decideReview(db, { id: approver, requestId: 'r', ts: ts(), review, opportunityId, decision: 'approve', note: '', eventId: rid(), auditId: rid() })).toBe(true);
}

describe('publication gate trigger (real D1)', () => {
  it('leaves opportunities that were never seller-linked untouched', async () => {
    const opp = await makeOpportunity();
    await publish(opp);
    expect(await state(opp)).toEqual({ lifecycle: 'published', vis: 1 });
  });

  it('blocks publication of a seller-linked opportunity until every gate is met, then allows it', async () => {
    const admin = await makeStaff('admin');
    const other = await makeStaff('admin');
    const ctx = await sellerWithLink(admin);
    await expect(publish(ctx.opportunityId)).rejects.toThrow(/gates not satisfied/);
    expect((await sellerGateResult(db, ctx.opportunityId)).unmet.length).toBeGreaterThan(0);

    expect(await reviewLink(db, { id: other, requestId: 'r', ts: ts(), link: { id: ctx.linkId, sellerId: ctx.sellerId, opportunityId: ctx.opportunityId, relationshipStatus: 'ACTIVE', reviewStatus: 'PENDING' }, sellerReference: ctx.reference, auditId: rid() })).toBe(true);
    await verified(ctx, admin, other, 'AUTHORITY_TO_MARKET');
    await expect(publish(ctx.opportunityId)).rejects.toThrow(/gates not satisfied/); // mandate and review still missing
    await verified(ctx, admin, other, 'BROKERAGE_MANDATE');
    await expect(publish(ctx.opportunityId)).rejects.toThrow(/gates not satisfied/); // review still missing
    await approvedReview(ctx.opportunityId, admin, other);

    expect((await sellerGateResult(db, ctx.opportunityId)).unmet).toEqual([]);
    await publish(ctx.opportunityId);
    expect(await state(ctx.opportunityId)).toEqual({ lifecycle: 'published', vis: 1 });
  });

  it('revoking the mandate withdraws the live listing and audits it in the same transaction', async () => {
    const admin = await makeStaff('admin');
    const other = await makeStaff('admin');
    const ctx = await sellerWithLink(admin);
    await reviewLink(db, { id: other, requestId: 'r', ts: ts(), link: { id: ctx.linkId, sellerId: ctx.sellerId, opportunityId: ctx.opportunityId, relationshipStatus: 'ACTIVE', reviewStatus: 'PENDING' }, sellerReference: ctx.reference, auditId: rid() });
    await verified(ctx, admin, other, 'AUTHORITY_TO_MARKET');
    const mandate = await verified(ctx, admin, other, 'BROKERAGE_MANDATE');
    await approvedReview(ctx.opportunityId, admin, other);
    await publish(ctx.opportunityId);

    const record = (await findAuthority(db, mandate, scope))!;
    expect(await changeAuthority(db, { id: other, requestId: 'r', ts: ts(), record, to: 'REVOKED', note: 'Seller withdrew the mandate', reviewerId: other, eventId: rid(), auditId: rid(), withdrawAuditAction: 'authority.revoked_withdrew_listing', evidenceType: null, evidenceRef: null, scope: null, limitations: null, validFrom: null, validUntil: null })).toBe(true);
    expect(await state(ctx.opportunityId)).toEqual({ lifecycle: 'in_review', vis: 0 });
    const audit = await db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE entity_type = 'opportunity' AND entity_id = ? AND action = 'authority.revoked_withdrew_listing'").bind(ctx.opportunityId).first<{ n: number }>();
    expect(audit?.n).toBe(1);
    await expect(publish(ctx.opportunityId)).rejects.toThrow(/gates not satisfied/);
  });

  it('a stale version changes nothing (optimistic concurrency)', async () => {
    const admin = await makeStaff('admin');
    const ctx = await sellerWithLink(admin);
    const reference = await verified(ctx, admin, await makeStaff('admin'), 'AUTHORITY_TO_NEGOTIATE');
    const record = (await findAuthority(db, reference, scope))!;
    const stale = { ...record, version: record.version - 1 };
    expect(await changeAuthority(db, { id: admin, requestId: 'r', ts: ts(), record: stale, to: 'REVOKED', note: 'stale attempt', reviewerId: admin, eventId: rid(), auditId: rid(), withdrawAuditAction: 'x', evidenceType: null, evidenceRef: null, scope: null, limitations: null, validFrom: null, validUntil: null })).toBe(false);
    expect((await findAuthority(db, reference, scope))!.status).toBe('VERIFIED');
  });

  it('the expiry sweep marks lapsed authority EXPIRED and withdraws the dependent listing', async () => {
    const admin = await makeStaff('admin');
    const other = await makeStaff('admin');
    const ctx = await sellerWithLink(admin);
    await reviewLink(db, { id: other, requestId: 'r', ts: ts(), link: { id: ctx.linkId, sellerId: ctx.sellerId, opportunityId: ctx.opportunityId, relationshipStatus: 'ACTIVE', reviewStatus: 'PENDING' }, sellerReference: ctx.reference, auditId: rid() });
    const soon = new Date(Date.now() + 3_000).toISOString();
    const market = await verified(ctx, admin, other, 'AUTHORITY_TO_MARKET', null);
    await verified(ctx, admin, other, 'BROKERAGE_MANDATE', null);
    await approvedReview(ctx.opportunityId, admin, other);
    await publish(ctx.opportunityId);
    await db.prepare("UPDATE seller_authority_records SET valid_until = '2020-01-01T00:00:00.000Z' WHERE reference = ?").bind(market).run();
    const result = await runAuthorityExpiry(env, new Date(Date.now() + 1000).toISOString());
    void soon;
    expect(result.expired).toBeGreaterThanOrEqual(1);
    expect((await findAuthority(db, market, scope))!.status).toBe('EXPIRED');
    expect(await state(ctx.opportunityId)).toEqual({ lifecycle: 'in_review', vis: 0 });
  });
});

describe('database constraints (real D1)', () => {
  it('VERIFIED cannot be stored without evidence, and APPROVED reviews need every confirmation', async () => {
    const admin = await makeStaff('admin');
    const ctx = await sellerWithLink(admin);
    const at = ts();
    await expect(db.prepare("INSERT INTO seller_authority_records (id, reference, link_id, authority_type, evidence_type, status, scope, reviewed_by, reviewed_at, created_by, created_at, updated_at) VALUES (?, 'CM-A-ZZZZZZ', ?, 'AUTHORITY_TO_MARKET', 'NONE', 'VERIFIED', 'some scope', ?, ?, ?, ?, ?)").bind(rid(), ctx.linkId, admin, at, admin, at, at).run()).rejects.toThrow();
    await expect(db.prepare("INSERT INTO seller_publication_reviews (id, opportunity_id, status, scope_text, prepared_by, created_at, updated_at) VALUES (?, ?, 'APPROVED', 'long enough scope text', ?, ?, ?)").bind(rid(), ctx.opportunityId, admin, at, at).run()).rejects.toThrow();
  });

  it('history tables are append-only', async () => {
    const admin = await makeStaff('admin');
    const ctx = await sellerWithLink(admin);
    const reference = await verified(ctx, admin, await makeStaff('admin'), 'AUTHORITY_TO_REPRESENT');
    const rec = (await findAuthority(db, reference, scope))!;
    await expect(db.prepare("UPDATE seller_authority_events SET note = 'tampered' WHERE record_id = ?").bind(rec.id).run()).rejects.toThrow(/append-only/);
    await expect(db.prepare('DELETE FROM seller_authority_events WHERE record_id = ?').bind(rec.id).run()).rejects.toThrow(/append-only/);
  });
});

describe('enquiry to seller to private draft opportunity (real D1)', () => {
  async function qualifiedEnquiry(owner: string) {
    const id = rid();
    const reference = `CM-S-${id.slice(0, 6).toUpperCase().replace(/[01OI]/g, 'C')}`;
    const data = normaliseSellerEnquiry(sellerEnquirySchema.parse({ ...valid(), idempotency_key: `k${id.replace(/-/g, '')}` }), false);
    await insertSellerEnquiry(db, { id, reference, data, idempotencyHash: `h-${id}`, sourceIpHash: null, requestId: 'r', auditId: rid(), ackJobId: rid(), alertJobId: rid(), timestamp: ts() });
    await db.prepare("UPDATE seller_enquiries SET status = 'QUALIFIED', assigned_to = ? WHERE id = ?").bind(owner, id).run();
    return { id, reference };
  }

  it('creates the seller from stored data, converts explicitly, and leaves the draft private', async () => {
    const owner = await makeStaff('broker');
    const enquiry = await qualifiedEnquiry(owner);
    const sellerId = rid();
    const sellerReference = `CM-C-${sellerId.slice(0, 6).toUpperCase().replace(/[01OI]/g, 'D')}`;
    expect(await createSellerFromEnquiry(db, { id: owner, requestId: 'r', ts: ts(), enquiryId: enquiry.id, expectedVersion: 1, sellerId, reference: sellerReference, ownerId: owner, auditId: rid(), enquiryReference: enquiry.reference })).toBe(true);
    const seller = await db.prepare('SELECT contact_name, contact_email, relationship_owner, source_enquiry_id FROM sellers WHERE id = ?').bind(sellerId).first<Record<string, string>>();
    expect(seller).toMatchObject({ contact_name: 'Jane Owner', contact_email: 'jane@example.com', relationship_owner: owner, source_enquiry_id: enquiry.id });
    // Creating a seller does NOT convert the enquiry.
    expect((await db.prepare('SELECT status, version FROM seller_enquiries WHERE id = ?').bind(enquiry.id).first<{ status: string; version: number }>())).toEqual({ status: 'QUALIFIED', version: 2 });

    const opportunityId = rid();
    const input = { id: owner, requestId: 'r', ts: ts(), enquiryId: enquiry.id, enquiryReference: enquiry.reference, expectedVersion: 2, sellerId, sellerReference, role: 'OWNER', assignedBrokerId: owner, opportunityId, slug: `slug-${opportunityId}`, title: 'Confidential casino opportunity', country: '', opportunityType: 'casino', snapshotJson: '{}', linkId: rid(), versionId: rid(), historyId: rid(), auditEnquiryId: rid(), auditOpportunityId: rid() };
    expect(await convertEnquiry(db, { ...input, expectedVersion: 1 })).toBe(false); // stale version: nothing happens
    expect(await db.prepare('SELECT id FROM opportunities WHERE id = ?').bind(opportunityId).first()).toBeNull();

    expect(await convertEnquiry(db, input)).toBe(true);
    expect(await db.prepare('SELECT status FROM seller_enquiries WHERE id = ?').bind(enquiry.id).first()).toEqual({ status: 'CONVERTED' });
    expect(await state(opportunityId)).toEqual({ lifecycle: 'draft', vis: 0 });
    const opp = await db.prepare('SELECT classification, content_review_status AS review, price_text AS price FROM opportunities WHERE id = ?').bind(opportunityId).first();
    expect(opp).toEqual({ classification: 'confidential', review: 'pending', price: '' });
    expect(await db.prepare("SELECT review_status FROM seller_opportunity_links WHERE opportunity_id = ?").bind(opportunityId).first()).toEqual({ review_status: 'PENDING' });
    const audits = await db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action IN ('seller_enquiry.converted','opportunity.created_from_seller_enquiry') AND entity_id IN (?, ?)").bind(enquiry.id, opportunityId).first<{ n: number }>();
    expect(audits?.n).toBe(2);
    expect(await convertEnquiry(db, { ...input, opportunityId: rid(), slug: 'another', linkId: rid(), versionId: rid(), historyId: rid(), auditEnquiryId: rid(), auditOpportunityId: rid(), expectedVersion: 3 })).toBe(false); // already converted
    // The converted draft is seller-gated from the start.
    await expect(publish(opportunityId)).rejects.toThrow(/gates not satisfied/);
  });
});
