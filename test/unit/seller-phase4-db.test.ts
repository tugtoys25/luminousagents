import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { contentHash, renderSellerFollowup, renderSellerMaterialInterest, TEMPLATE_FOLLOWUP, TEMPLATE_MATERIAL_INTEREST } from '../../src/seller/emails-outbound';
import { findInterest, insertInterest, reviewInterest } from '../../src/seller/interest-repo';
import { handleSellerJob } from '../../src/seller/jobs';
import { approveAndQueue, cancelMessage, findMessage, insertDraft } from '../../src/seller/message-repo';
import { anonymiseEnquiry, findPrivacyEnquiry, retentionCandidates, setLegalHold } from '../../src/seller/privacy-repo';
import { adminScope, convertedSeller, makeStaff, plainEnquiry, reviewTheLink, revokeAuthority, rid, ts, verifiedAuthority } from '../support/seller-db';

const db = env.DB;
const broker = { name: 'Test Broker', title: 'Director', email: 'broker@example.test', telephone: null, website: 'https://example.test' };
type Sent = { to: string | string[]; subject: string; html: string; text: string };

/** A fake provider: records what would be sent. */
function sender() {
  const sent: Sent[] = [];
  return { sent, send: async (_e: unknown, to: string | string[], subject: string, html: string, text: string) => { sent.push({ to, subject, html, text }); } };
}
const dispatch = (messageId: string, fake: ReturnType<typeof sender>) => {
  const jobId = rid();
  return handleSellerJob(env, { id: jobId, job_type: 'seller.message_send' }, { messageId }, fake.send as never);
};

async function followupDraft(ctx: { enquiryId: string; enquiryReference: string }, author: string) {
  const mail = renderSellerFollowup({ contactName: 'Jane Owner', reference: ctx.enquiryReference, questions: ['Who owns the licence?', 'What is the timing?'], broker });
  const messageId = rid();
  expect(await insertDraft(db, { id: author, requestId: 'r', ts: ts(), messageId, auditId: rid(), kind: 'FOLLOWUP', enquiryId: ctx.enquiryId, enquiryReference: ctx.enquiryReference, sellerId: null, opportunityId: null, interestId: null, interestVersion: null, templateId: TEMPLATE_FOLLOWUP, recipient: 'jane@example.com', subject: mail.subject, text: mail.text, html: mail.html, requireOpenEnquiry: true })).toBe(true);
  return { messageId, mail };
}
async function approve(messageId: string, approver: string) {
  const message = (await findMessage(db, messageId, adminScope))!;
  const hash = await contentHash({ subject: message.subject, text: message.bodyText, html: message.bodyHtml, recipient: message.recipient });
  return approveAndQueue(db, { id: approver, requestId: 'r', ts: ts(), message, contentHash: hash, jobId: rid(), auditId: rid() });
}

describe('staff follow-up email (real D1)', () => {
  it('a draft is never sent; approval sends exactly once and is retry-safe', async () => {
    const owner = await makeStaff(db, 'broker');
    const ctx = await convertedSeller(db, owner);
    const { messageId } = await followupDraft(ctx, owner);
    const fake = sender();
    await expect(dispatch(messageId, fake)).rejects.toThrow(/never approved/);
    expect(fake.sent).toHaveLength(0);

    expect(await approve(messageId, owner)).toBe(true);
    expect(await approve(messageId, owner)).toBe(false); // double click: no second approval or job
    expect((await db.prepare("SELECT COUNT(*) AS n FROM notification_jobs WHERE dedupe_key = ?").bind(`seller_message:${messageId}`).first<{ n: number }>())?.n).toBe(1);
    await expect(db.prepare("UPDATE seller_outbound_messages SET body_text = 'altered' WHERE id = ?").bind(messageId).run()).rejects.toThrow(/frozen/);

    expect(await dispatch(messageId, fake)).toBe(true);
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]!.to).toBe('jane@example.com');
    expect(fake.sent[0]!.text).toContain('Who owns the licence?');
    expect(await dispatch(messageId, fake)).toBe(true); // queue redelivery / retry
    expect(fake.sent).toHaveLength(1);
    expect((await findMessage(db, messageId, adminScope))!.status).toBe('SENT');
    const comm = await db.prepare("SELECT delivery_status AS d, actor_type AS a FROM seller_communications WHERE enquiry_id = ? AND template_id = ?").bind(ctx.enquiryId, TEMPLATE_FOLLOWUP).first();
    expect(comm).toEqual({ d: 'ACCEPTED_BY_PROVIDER', a: 'staff' });
    expect((await db.prepare('SELECT first_response_at AS f FROM seller_enquiries WHERE id = ?').bind(ctx.enquiryId).first<{ f: string | null }>())?.f).not.toBeNull();
  });

  it('a revoked (cancelled) message is not sent, and a sent message cannot be cancelled', async () => {
    const owner = await makeStaff(db, 'broker');
    const ctx = await convertedSeller(db, owner);
    const { messageId } = await followupDraft(ctx, owner);
    await approve(messageId, owner);
    const message = (await findMessage(db, messageId, adminScope))!;
    expect(await cancelMessage(db, { id: owner, requestId: 'r', ts: ts(), message, reason: 'Changed my mind', auditId: rid() })).toBe(true);
    const fake = sender();
    expect(await dispatch(messageId, fake)).toBe(true);
    expect(fake.sent).toHaveLength(0);

    const second = await followupDraft(ctx, owner);
    await approve(second.messageId, owner);
    await dispatch(second.messageId, fake);
    const sentMsg = (await findMessage(db, second.messageId, adminScope))!;
    expect(await cancelMessage(db, { id: owner, requestId: 'r', ts: ts(), message: sentMsg, reason: 'Too late to cancel', auditId: rid() })).toBe(false);
  });

  it('refuses to send if the recipient changed after approval', async () => {
    const owner = await makeStaff(db, 'broker');
    const ctx = await convertedSeller(db, owner);
    const { messageId } = await followupDraft(ctx, owner);
    await approve(messageId, owner);
    await db.prepare("UPDATE seller_enquiries SET email = 'someone-else@example.com' WHERE id = ?").bind(ctx.enquiryId).run();
    const fake = sender();
    expect(await dispatch(messageId, fake)).toBe(true);
    expect(fake.sent).toHaveLength(0);
    expect((await findMessage(db, messageId, adminScope))!.status).toBe('CANCELLED');
  });
});

/** Seller entitled to be told: link reviewed + a verified representation authority. */
async function entitledSeller() {
  const owner = await makeStaff(db, 'broker');
  const recorder = await makeStaff(db, 'admin');
  const approver = await makeStaff(db, 'admin');
  const ctx = await convertedSeller(db, owner);
  await reviewTheLink(db, ctx, approver);
  const authority = await verifiedAuthority(db, ctx, recorder, approver, 'AUTHORITY_TO_REPRESENT');
  return { owner, recorder, approver, ctx, authority };
}
async function approvedInterest(s: Awaited<ReturnType<typeof entitledSeller>>) {
  const reference = `CM-M-${rid().slice(0, 6).toUpperCase().replace(/[01OI]/g, 'E')}`;
  expect(await insertInterest(db, { id: s.owner, requestId: 'r', ts: ts(), interestId: rid(), reference, eventId: rid(), auditId: rid(), sellerId: s.ctx.sellerId, sellerReference: s.ctx.reference, linkId: s.ctx.linkId, interestType: 'INDICATION_OF_INTEREST', receivedAt: ts(), source: 'Phone call', summary: 'INTERNAL: Acme Holdings offered 40m', buyerReference: 'BUYER-ACME' })).toBe(true);
  const step = async (action: 'start_review' | 'approve', extra: Partial<{ approvedSummary: string; proposedNextStep: string; stageLabel: string }> = {}) => {
    const interest = (await findInterest(db, reference, adminScope))!;
    return reviewInterest(db, { id: s.approver, requestId: 'r', ts: ts(), interest, action, note: 'Reviewed', eventId: rid(), auditId: rid(), approvedSummary: extra.approvedSummary ?? '', proposedNextStep: extra.proposedNextStep ?? '', stageLabel: extra.stageLabel ?? '' }, ts());
  };
  expect(await step('start_review')).toBe(true);
  return { reference, step, approve: () => step('approve', { approvedSummary: 'A party has expressed preliminary interest in the asset.', proposedNextStep: 'Schedule a call this week', stageLabel: 'Early expression of interest' }) };
}
async function noticeDraft(s: Awaited<ReturnType<typeof entitledSeller>>, reference: string) {
  const interest = (await findInterest(db, reference, adminScope))!;
  const mail = renderSellerMaterialInterest({ contactName: interest.sellerContactName, assetReference: interest.opportunityTitle, interestType: interest.interestType, interestStage: interest.stageLabel, approvedSummary: interest.approvedSummary, proposedNextStep: interest.proposedNextStep, broker });
  const messageId = rid();
  const ok = await insertDraft(db, { id: s.owner, requestId: 'r', ts: ts(), messageId, auditId: rid(), kind: 'MATERIAL_INTEREST', enquiryId: s.ctx.enquiryId, enquiryReference: reference, sellerId: interest.sellerId, opportunityId: interest.opportunityId, interestId: interest.id, interestVersion: interest.version, templateId: TEMPLATE_MATERIAL_INTEREST, recipient: interest.sellerEmail, subject: mail.subject, text: mail.text, html: mail.html, requireOpenEnquiry: false });
  return { ok, messageId, mail };
}

describe('material-interest notification (real D1)', () => {
  it('cannot be approved for a seller who is not entitled', async () => {
    const owner = await makeStaff(db, 'broker');
    const approver = await makeStaff(db, 'admin');
    const ctx = await convertedSeller(db, owner); // link NOT reviewed, no authority
    const s = { owner, recorder: approver, approver, ctx, authority: '' };
    const i = await approvedInterest(s);
    expect(await i.approve()).toBe(false);
    expect((await findInterest(db, i.reference, adminScope))!.stage).toBe('UNDER_REVIEW');
  });

  it('sends only the approved fields, once, and marks the interest NOTIFIED', async () => {
    const s = await entitledSeller();
    const i = await approvedInterest(s);
    expect(await i.approve()).toBe(true);
    const { ok, messageId, mail } = await noticeDraft(s, i.reference);
    expect(ok).toBe(true);
    expect(mail.text + mail.html).not.toMatch(/Acme|BUYER-ACME|40m|INTERNAL/);
    expect(mail.subject).toBe('Confidential Update Regarding Confidential casino opportunity');
    expect(await approve(messageId, s.approver)).toBe(true);
    const fake = sender();
    expect(await dispatch(messageId, fake)).toBe(true);
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]!.text).toContain('A party has expressed preliminary interest');
    expect(fake.sent[0]!.text + fake.sent[0]!.html).not.toMatch(/Acme|BUYER-ACME|40m/);
    expect((await findInterest(db, i.reference, adminScope))!.stage).toBe('NOTIFIED');
    expect((await db.prepare("SELECT COUNT(*) AS n FROM seller_material_interest_events WHERE action = 'seller_notified'").first<{ n: number }>())!.n).toBeGreaterThanOrEqual(1);
    await dispatch(messageId, fake);
    expect(fake.sent).toHaveLength(1); // redelivery sends nothing
    expect((await noticeDraft(s, i.reference)).ok).toBe(false); // one notice per approved interest
  });

  it('does not send if the interest approval is withdrawn before dispatch', async () => {
    const s = await entitledSeller();
    const i = await approvedInterest(s);
    await i.approve();
    const { messageId } = await noticeDraft(s, i.reference);
    await approve(messageId, s.approver);
    const interest = (await findInterest(db, i.reference, adminScope))!;
    expect(await reviewInterest(db, { id: s.approver, requestId: 'r', ts: ts(), interest, action: 'withdraw', note: 'Buyer pulled out', eventId: rid(), auditId: rid(), approvedSummary: '', proposedNextStep: '', stageLabel: '' }, ts())).toBe(true);
    const fake = sender();
    expect(await dispatch(messageId, fake)).toBe(true);
    expect(fake.sent).toHaveLength(0);
    expect((await findMessage(db, messageId, adminScope))!.status).toBe('CANCELLED');
  });

  it('does not send if the seller loses entitlement before dispatch', async () => {
    const s = await entitledSeller();
    const i = await approvedInterest(s);
    await i.approve();
    const { messageId } = await noticeDraft(s, i.reference);
    await approve(messageId, s.approver);
    await revokeAuthority(db, s.authority, s.approver);
    const fake = sender();
    expect(await dispatch(messageId, fake)).toBe(true);
    expect(fake.sent).toHaveLength(0);
    const m = await db.prepare('SELECT status, cancel_reason AS r FROM seller_outbound_messages WHERE id = ?').bind(messageId).first<{ status: string; r: string }>();
    expect(m?.status).toBe('CANCELLED');
    expect(m?.r).toMatch(/no longer entitled/);
  });

  it('refuses tampered content (hash mismatch is impossible to bypass through the frozen-content trigger)', async () => {
    const s = await entitledSeller();
    const i = await approvedInterest(s);
    await i.approve();
    const { messageId } = await noticeDraft(s, i.reference);
    await approve(messageId, s.approver);
    await expect(db.prepare("UPDATE seller_outbound_messages SET recipient_email = 'attacker@example.com' WHERE id = ?").bind(messageId).run()).rejects.toThrow(/frozen/);
  });
});

describe('retention, legal hold and anonymisation (real D1)', () => {
  const OLD = '2020-01-01T00:00:00.000Z';
  const anon = async (admin: string, reference: string) => anonymiseEnquiry(db, { id: admin, requestId: 'r', ts: ts(), enquiry: (await findPrivacyEnquiry(db, reference))!, reason: 'Erasure request', auditId: rid() });

  it('anonymises a closed, unlinked enquiry and redacts the staff free text attached to it, once', async () => {
    const owner = await makeStaff(db, 'broker');
    const admin = await makeStaff(db, 'admin');
    const e = await plainEnquiry(db, owner, 'CLOSED', OLD);
    expect(await anon(admin, e.reference)).toBe(true);
    const row = await db.prepare('SELECT contact_name AS n, email, telephone, asset_description AS d, original_submission_json AS o, source_ip_hash AS ip, anonymised_at AS at, reference FROM seller_enquiries WHERE id = ?').bind(e.id).first<Record<string, string | null>>();
    expect(row).toMatchObject({ n: 'Anonymised', telephone: null, d: '[removed]', o: '{}', ip: null, reference: e.reference });
    expect(row?.email).toMatch(/^anonymised-.*@invalid\.example$/);
    expect(row?.at).not.toBeNull();
    expect((await db.prepare('SELECT note FROM seller_enquiry_notes WHERE enquiry_id = ?').bind(e.id).first())).toEqual({ note: '[redacted]' });
    expect((await db.prepare("SELECT title FROM staff_tasks WHERE related_entity_id = ?").bind(e.id).first())).toEqual({ title: '[redacted]' });
    const audit = await db.prepare("SELECT details_json AS d FROM audit_logs WHERE entity_id = ? AND action = 'seller_enquiry.anonymised'").bind(e.id).first<{ d: string }>();
    expect(audit?.d).not.toMatch(/Jane/);
    expect(await anon(admin, e.reference)).toBe(false); // already anonymised
  });

  it('refuses open, held and seller-linked enquiries, and keeps held ones out of the review list', async () => {
    const owner = await makeStaff(db, 'broker');
    const admin = await makeStaff(db, 'admin');
    const open = await plainEnquiry(db, owner, 'QUALIFICATION');
    expect(await anon(admin, open.reference)).toBe(false);

    const held = await plainEnquiry(db, owner, 'DECLINED', OLD);
    const heldRef = (await findPrivacyEnquiry(db, held.reference))!;
    expect(await setLegalHold(db, { id: admin, requestId: 'r', ts: ts(), enquiry: heldRef, hold: true, reason: 'Litigation hold', auditId: rid() })).toBe(true);
    expect(await anon(admin, held.reference)).toBe(false);
    const listed = (await retentionCandidates(db, '2021-01-01T00:00:00.000Z', 100)).map((r) => r.reference);
    expect(listed).not.toContain(held.reference);
    expect(listed).not.toContain(open.reference);
    expect(await setLegalHold(db, { id: admin, requestId: 'r', ts: ts(), enquiry: heldRef, hold: false, reason: 'Hold released', auditId: rid() })).toBe(true);
    expect((await retentionCandidates(db, '2021-01-01T00:00:00.000Z', 100)).map((r) => r.reference)).toContain(held.reference);
    expect(await anon(admin, held.reference)).toBe(true);

    const ctx = await convertedSeller(db, owner); // linked to a seller
    await db.prepare("UPDATE seller_enquiries SET status = 'CLOSED', closed_at = ? WHERE id = ?").bind(OLD, ctx.enquiryId).run();
    expect(await anon(admin, ctx.enquiryReference)).toBe(false);
  });

  it('redaction is the only permitted change to append-only history', async () => {
    const owner = await makeStaff(db, 'broker');
    const e = await plainEnquiry(db, owner, 'NEW');
    const note = await db.prepare('SELECT id FROM seller_enquiry_notes WHERE enquiry_id = ?').bind(e.id).first<{ id: string }>();
    await expect(db.prepare("UPDATE seller_enquiry_notes SET note = 'edited' WHERE id = ?").bind(note!.id).run()).rejects.toThrow(/append-only/);
    await db.prepare("UPDATE seller_enquiry_notes SET note = '[redacted]' WHERE id = ?").bind(note!.id).run();
    await expect(db.prepare('DELETE FROM seller_enquiry_notes WHERE id = ?').bind(note!.id).run()).rejects.toThrow(/append-only/);
  });

  it('privacy requests cannot be closed without an outcome note', async () => {
    const admin = await makeStaff(db, 'admin');
    const at = ts();
    await expect(db.prepare("INSERT INTO seller_privacy_requests (id, reference, request_type, status, received_at, outcome_note, created_by, created_at, updated_at) VALUES (?, 'CM-P-AAAAAA', 'ERASURE', 'COMPLETED', ?, '', ?, ?, ?)").bind(rid(), at, admin, at, at).run()).rejects.toThrow();
  });
});
