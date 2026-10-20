import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { renderSellerAssignment } from '../../src/seller/emails-internal';
import { insertInterest, reviewInterest, findInterest } from '../../src/seller/interest-repo';
import { handleSellerJob } from '../../src/seller/jobs';
import { insertDraft, listMessagesForExport } from '../../src/seller/message-repo';
import { anonymiseSeller, findPrivacySeller, setSellerLegalHold } from '../../src/seller/privacy-repo';
import { insertContact, listSellerContacts, removeContact } from '../../src/seller/seller-repo';
import { applyStatusOrAssignment, findAssignmentNotice, findRef } from '../../src/seller/staff-repo';
import { adminScope, convertedSeller, makeStaff, plainEnquiry, rid, ts, verifiedAuthority } from '../support/seller-db';

const db = env.DB;
type Sent = { to: string | string[]; subject: string; html: string; text: string };
function sender() {
  const sent: Sent[] = [];
  return { sent, send: async (_e: unknown, to: string | string[], subject: string, html: string, text: string) => { sent.push({ to, subject, html, text }); } };
}
const run = (jobType: string, payload: Record<string, unknown>, fake: ReturnType<typeof sender>) => handleSellerJob(env, { id: rid(), job_type: jobType }, payload, fake.send as never);

describe('assignment notification (real D1)', () => {
  async function newEnquiry() {
    const admin = await makeStaff(db, 'admin');
    const broker = await makeStaff(db, 'broker');
    const e = await plainEnquiry(db, admin, 'NEW');
    await db.prepare('UPDATE seller_enquiries SET assigned_to = NULL WHERE id = ?').bind(e.id).run();
    return { admin, broker, e, ref: (await findRef(db, e.reference, adminScope))! };
  }
  const assign = (admin: string, ref: Awaited<ReturnType<typeof findRef>> & object, to: string, notify: boolean) =>
    applyStatusOrAssignment(db, { id: admin, requestId: 'r', ts: ts(), enquiry: ref, toStatus: 'ASSIGNED', toAssignee: to, reason: null, closing: false, ids: [rid(), rid()], action: 'seller_enquiry.assigned', ...(notify ? { notify: { jobId: rid(), dedupeKey: `seller_assignment:${ref.id}:${ref.version + 1}` } } : {}) });

  it('queues one job per assignment, only when applied, and emails only the new owner with minimal data', async () => {
    const { admin, broker, e, ref } = await newEnquiry();
    const stale = { ...ref, version: ref.version - 1 };
    expect(await assign(admin, stale, broker, true)).toBe(false);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM notification_jobs WHERE instr(dedupe_key, ?) > 0").bind(`seller_assignment:${e.id}:`).first<{ n: number }>())?.n).toBe(0);
    expect(await assign(admin, ref, broker, true)).toBe(true);
    const job = await db.prepare("SELECT payload_json AS p FROM notification_jobs WHERE dedupe_key = ?").bind(`seller_assignment:${e.id}:${ref.version + 1}`).first<{ p: string }>();
    expect(JSON.parse(job!.p)).toEqual({ enquiryId: e.id, assigneeId: broker });

    const fake = sender();
    expect(await run('seller.enquiry_assigned', JSON.parse(job!.p), fake)).toBe(true);
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]!.to).toHaveLength(1);
    expect(fake.sent[0]!.subject).toBe(`Seller Enquiry Assigned — ${e.reference}`);
    expect(fake.sent[0]!.text).not.toMatch(/Jane Personal|jane@example\.com|asking|@example\.com\b.*broker/);
    expect(fake.sent[0]!.text).toContain('unqualified lead');
  });

  it('is skipped if the enquiry was reassigned before the job ran, and not queued for self-assignment', async () => {
    const { admin, broker, e, ref } = await newEnquiry();
    const other = await makeStaff(db, 'broker');
    await assign(admin, ref, broker, true);
    await db.prepare('UPDATE seller_enquiries SET assigned_to = ? WHERE id = ?').bind(other, e.id).run();
    const fake = sender();
    expect(await run('seller.enquiry_assigned', { enquiryId: e.id, assigneeId: broker }, fake)).toBe(true);
    expect(fake.sent).toHaveLength(0);
    const second = await newEnquiry();
    expect(await assign(second.admin, second.ref, second.admin, false)).toBe(true);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM notification_jobs WHERE dedupe_key = ?").bind(`seller_assignment:${second.e.id}:${second.ref.version + 1}`).first<{ n: number }>())?.n).toBe(0);
    expect((await findAssignmentNotice(db, second.e.id))?.assigneeId).toBe(second.admin);
  });

  it('template escapes names and carries the required internal-use notice', () => {
    const m = renderSellerAssignment({ reference: 'CM-S-ABC234', status: 'ASSIGNED', assetType: 'CASINO', assetCountry: 'GB', confidentialityPreference: 'DISCUSS_WITH_BROKER', assetNameConfidential: 1, assigneeId: 'x', assigneeName: '<b>Bo</b>', assigneeEmail: 'bo@example.test' }, { baseUrl: 'https://example.test', companyWebsite: 'https://example.test', includePhone: false, includePrice: false });
    expect(m.html).not.toContain('<b>Bo</b>');
    expect(m.text).toContain('https://example.test/dashboard/seller-enquiries/ui?selected=CM-S-ABC234');
    expect(m.text).toContain('internal use only');
  });
});

describe('additional seller contacts (real D1)', () => {
  it('adds and soft-removes contacts, never on an inactive seller', async () => {
    const owner = await makeStaff(db, 'broker');
    const ctx = await convertedSeller(db, owner);
    const seller = { id: ctx.sellerId, reference: ctx.reference, status: 'ACTIVE', version: 2, owner };
    const contactId = rid();
    expect(await insertContact(db, { id: owner, requestId: 'r', ts: ts(), seller, contactId, name: 'Second Person', roleTitle: 'CFO', email: 'cfo@example.test', telephone: null, auditId: rid() })).toBe(true);
    expect((await listSellerContacts(db, ctx.sellerId)).map((c) => c.name)).toEqual(['Second Person']);
    expect(await removeContact(db, { id: owner, requestId: 'r', ts: ts(), seller, contactId, auditId: rid() })).toBe(true);
    expect(await listSellerContacts(db, ctx.sellerId)).toHaveLength(0);
    expect(await removeContact(db, { id: owner, requestId: 'r', ts: ts(), seller, contactId, auditId: rid() })).toBe(false);
    await db.prepare("UPDATE sellers SET status = 'INACTIVE' WHERE id = ?").bind(ctx.sellerId).run();
    expect(await insertContact(db, { id: owner, requestId: 'r', ts: ts(), seller, contactId: rid(), name: 'Late Add', roleTitle: '', email: 'x@example.test', telephone: null, auditId: rid() })).toBe(false);
  });
});

describe('seller erasure (real D1)', () => {
  async function fullySetUp() {
    const owner = await makeStaff(db, 'broker');
    const admin = await makeStaff(db, 'admin');
    const approver = await makeStaff(db, 'admin');
    const ctx = await convertedSeller(db, owner);
    const seller = { id: ctx.sellerId, reference: ctx.reference, status: 'ACTIVE', version: 2, owner };
    await insertContact(db, { id: owner, requestId: 'r', ts: ts(), seller, contactId: rid(), name: 'Second Person', roleTitle: 'CFO', email: 'cfo@example.test', telephone: '+44 20 7946 0000', auditId: rid() });
    const mandate = await verifiedAuthority(db, ctx, admin, approver, 'BROKERAGE_MANDATE');
    const interestRef = `CM-M-${rid().slice(0, 6).toUpperCase().replace(/[01OI]/g, 'G')}`;
    await insertInterest(db, { id: owner, requestId: 'r', ts: ts(), interestId: rid(), reference: interestRef, eventId: rid(), auditId: rid(), sellerId: ctx.sellerId, sellerReference: ctx.reference, linkId: ctx.linkId, interestType: 'REQUEST_FOR_INFORMATION', receivedAt: ts(), source: 'Acme call', summary: 'Acme wants the accounts', buyerReference: 'BUYER-ACME' });
    await db.prepare("INSERT INTO seller_enquiry_notes (id, enquiry_id, author_id, note, created_at) VALUES (?, ?, ?, 'Seller mentioned divorce', ?)").bind(rid(), ctx.enquiryId, owner, ts()).run();
    await insertDraft(db, { id: owner, requestId: 'r', ts: ts(), messageId: rid(), auditId: rid(), kind: 'FOLLOWUP', enquiryId: ctx.enquiryId, enquiryReference: ctx.enquiryReference, sellerId: null, opportunityId: null, interestId: null, interestVersion: null, templateId: 'seller_enquiry_followup_v1', recipient: 'jane@example.com', subject: 'Follow-up', text: 'Personal text', html: '<p>Personal text</p>', requireOpenEnquiry: false });
    return { owner, admin, ctx, mandate, interestRef };
  }
  const anon = async (admin: string, reference: string) => anonymiseSeller(db, { id: admin, requestId: 'r', ts: ts(), seller: (await findPrivacySeller(db, reference))!, reason: 'Erasure request', auditId: rid() });
  async function windDown(s: Awaited<ReturnType<typeof fullySetUp>>) {
    const interest = (await findInterest(db, s.interestRef, adminScope))!;
    await reviewInterest(db, { id: s.admin, requestId: 'r', ts: ts(), interest, action: 'withdraw', note: 'Buyer withdrew', eventId: rid(), auditId: rid(), approvedSummary: '', proposedNextStep: '', stageLabel: '' }, ts());
    await db.prepare("UPDATE seller_opportunity_links SET relationship_status = 'ENDED' WHERE id = ?").bind(s.ctx.linkId).run();
    await db.prepare("UPDATE seller_enquiries SET status = 'CLOSED' WHERE id = ?").bind(s.ctx.enquiryId).run();
    await db.prepare("UPDATE sellers SET status = 'INACTIVE' WHERE id = ?").bind(s.ctx.sellerId).run();
  }

  it('is refused while the seller is active, has an open interest, or is under legal hold', async () => {
    const s = await fullySetUp();
    expect(await anon(s.admin, s.ctx.reference)).toBe(false); // ACTIVE
    await db.prepare("UPDATE sellers SET status = 'INACTIVE' WHERE id = ?").bind(s.ctx.sellerId).run();
    expect(await anon(s.admin, s.ctx.reference)).toBe(false); // active link, open enquiry, open interest
    await windDown(s);
    const seller = (await findPrivacySeller(db, s.ctx.reference))!;
    expect(await setSellerLegalHold(db, { id: s.admin, requestId: 'r', ts: ts(), seller, hold: true, reason: 'Litigation hold', auditId: rid() })).toBe(true);
    expect(await anon(s.admin, s.ctx.reference)).toBe(false);
    expect((await findPrivacySeller(db, s.ctx.reference))!.anonymisedAt).toBeNull();
  });

  it('removes personal data everywhere it was copied, keeps structure and constraints valid, and runs once', async () => {
    const s = await fullySetUp();
    await windDown(s);
    expect(await anon(s.admin, s.ctx.reference)).toBe(true);
    const seller = await db.prepare('SELECT display_name AS d, contact_name AS n, contact_email AS e, contact_telephone AS t, organisation AS o, anonymised_at AS a, reference FROM sellers WHERE id = ?').bind(s.ctx.sellerId).first<Record<string, string | null>>();
    expect(seller).toMatchObject({ d: 'Anonymised seller', n: 'Anonymised', t: null, o: null, reference: s.ctx.reference });
    expect(seller?.e).toMatch(/^anonymised-.*@invalid\.example$/);
    expect(seller?.a).not.toBeNull();
    expect(await db.prepare('SELECT contact_name AS n, asset_description AS d, original_submission_json AS o FROM seller_enquiries WHERE id = ?').bind(s.ctx.enquiryId).first()).toEqual({ n: 'Anonymised', d: '[removed]', o: '{}' });
    expect(await db.prepare('SELECT name, telephone FROM seller_contacts WHERE seller_id = ?').bind(s.ctx.sellerId).first()).toEqual({ name: 'Anonymised', telephone: null });
    expect(await db.prepare('SELECT note FROM seller_enquiry_notes WHERE enquiry_id = ?').bind(s.ctx.enquiryId).first()).toEqual({ note: '[redacted]' });
    expect(await db.prepare('SELECT subject, body_text AS b FROM seller_outbound_messages WHERE enquiry_id = ?').bind(s.ctx.enquiryId).first()).toEqual({ subject: '[redacted]', b: '[redacted]' });
    const interest = await db.prepare('SELECT buyer_reference AS b, summary_internal AS s, source FROM seller_material_interests WHERE reference = ?').bind(s.interestRef).first();
    expect(interest).toEqual({ b: '', s: '[redacted]', source: '' });
    const record = await db.prepare('SELECT status, scope, evidence_ref AS e FROM seller_authority_records WHERE reference = ?').bind(s.mandate).first();
    expect(record).toEqual({ status: 'VERIFIED', scope: '[redacted]', e: null });
    expect((await db.prepare("SELECT COUNT(*) AS n FROM seller_authority_events WHERE record_id IN (SELECT id FROM seller_authority_records WHERE reference = ?) AND note <> '[redacted]' AND note <> ''").bind(s.mandate).first<{ n: number }>())?.n).toBe(0);
    const audit = await db.prepare("SELECT details_json AS d FROM audit_logs WHERE action = 'seller.anonymised' AND entity_id = ?").bind(s.ctx.sellerId).first<{ d: string }>();
    expect(audit?.d).not.toMatch(/Jane|jane@|Acme/);
    expect(await anon(s.admin, s.ctx.reference)).toBe(false);
  });
});

describe('subject export includes message text (real D1)', () => {
  it('returns the body of emails sent about the enquiry', async () => {
    const owner = await makeStaff(db, 'broker');
    const ctx = await convertedSeller(db, owner);
    const messageId = rid();
    await insertDraft(db, { id: owner, requestId: 'r', ts: ts(), messageId, auditId: rid(), kind: 'FOLLOWUP', enquiryId: ctx.enquiryId, enquiryReference: ctx.enquiryReference, sellerId: null, opportunityId: null, interestId: null, interestVersion: null, templateId: 'seller_enquiry_followup_v1', recipient: 'jane@example.com', subject: 'S', text: 'Body text here', html: '<p>x</p>', requireOpenEnquiry: false });
    await db.prepare("UPDATE seller_outbound_messages SET status = 'CANCELLED', cancel_reason = 'test' WHERE id = ?").bind(messageId).run();
    expect((await listMessagesForExport(db, ctx.enquiryId)).map((m) => m.bodyText)).toContain('Body text here');
  });
});
