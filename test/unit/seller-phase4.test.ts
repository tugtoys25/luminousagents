import { describe, expect, it } from 'vitest';
import { PERMISSIONS } from '../../src/permissions/permissions';
import { sellerExportRoles, sellerInterestApproveRoles, sellerRetentionRoles, sellerWorkRoles } from '../../src/admin/shared';
import { contentHash, renderSellerFollowup, renderSellerMaterialInterest, TEMPLATE_FOLLOWUP, TEMPLATE_MATERIAL_INTEREST } from '../../src/seller/emails-outbound';
import { anonymiseSchema, followupDraftSchema, interestRecordSchema, interestReviewSchema, legalHoldSchema, notificationDraftSchema, privacyRequestSchema, privacyUpdateSchema, sendMessageSchema } from '../../src/seller/seller-schemas';

const sorted = (a: readonly string[]) => [...a].sort();
const broker = { name: 'Test <b>Broker</b>', title: 'Director', email: 'broker@example.test', telephone: '+44 20 7946 0958', website: 'https://example.test' };

describe('seller_enquiry_followup_v1', () => {
  const m = renderSellerFollowup({ contactName: 'Jane <i>Owner</i>', reference: 'CM-S-ABC234', questions: ['Who owns the licence?', 'Is <script>x</script> relevant?\nSecond line'], broker });
  it('has the approved id, subject, reference, signature and both bodies', () => {
    expect(TEMPLATE_FOLLOWUP).toBe('seller_enquiry_followup_v1');
    expect(m.subject).toBe('Casinos of Mayfair — Follow-up to Your Enquiry CM-S-ABC234');
    expect(m.text).toContain('your enquiry number is CM-S-ABC234');
    expect(m.text).toContain('1. Who owns the licence?');
    expect(m.text).toContain('Casinos of Mayfair International Ltd');
    expect(m.text).toContain('+44 20 7946 0958');
    expect(m.text).toContain('No brokerage appointment or marketing authority is created by this correspondence.');
    expect(m.html).toContain('<ol>');
  });
  it('escapes HTML and cannot be given extra lines through a question or name', () => {
    expect(m.html).not.toContain('<script>');
    expect(m.html).not.toContain('<i>Owner</i>');
    expect(m.html).not.toContain('<b>Broker</b>');
    expect(m.text).toContain('2. Is <script>x</script> relevant? Second line'); // plain text keeps the characters, on one line
  });
  it('omits the telephone line when none is given', () => {
    expect(renderSellerFollowup({ contactName: 'J', reference: 'CM-S-ABC234', questions: ['Q one?'], broker: { ...broker, telephone: null } }).text).not.toContain('+44');
  });
});

describe('seller_material_interest_v1', () => {
  const input = { contactName: 'Jane Owner', assetReference: 'Confidential casino opportunity', interestType: 'INDICATION_OF_INTEREST', interestStage: 'Early expression of interest', approvedSummary: 'A party has expressed preliminary interest.\nNo terms are agreed.', proposedNextStep: 'Schedule a call', broker };
  const m = renderSellerMaterialInterest(input);
  it('has the approved id, subject and the four structured fields', () => {
    expect(TEMPLATE_MATERIAL_INTEREST).toBe('seller_material_interest_v1');
    expect(m.subject).toBe('Confidential Update Regarding Confidential casino opportunity');
    expect(m.text).toContain('Nature of interest: Indication of interest');
    expect(m.text).toContain('Current stage: Early expression of interest');
    expect(m.text).toContain('Summary: A party has expressed preliminary interest.');
    expect(m.text).toContain('Proposed next step: Schedule a call');
    expect(m.text).toContain('should not be treated as a formal offer');
    expect(m.text).toContain('CONFIDENTIAL — FOR THE INTENDED RECIPIENT ONLY');
  });
  it('contains nothing but approved fields: no buyer identity or other record data can be injected', () => {
    expect(Object.keys(input).sort()).toEqual(['approvedSummary', 'assetReference', 'broker', 'contactName', 'interestStage', 'interestType', 'proposedNextStep']);
  });
  it('escapes HTML and keeps line breaks in the summary', () => {
    const x = renderSellerMaterialInterest({ ...input, approvedSummary: 'Line <b>one</b>\nLine two', assetReference: 'Asset\r\nBcc: x@y.z' });
    expect(x.html).not.toContain('<b>one</b>');
    expect(x.html).toContain('<br>Line two');
    expect(x.subject).not.toMatch(/[\r\n]/);
  });
  it('does not list the company website in the broker signature, per the approved wording', () => {
    expect(m.text).not.toContain('https://example.test');
  });
});

describe('content hash', () => {
  it('is deterministic, recipient-case-insensitive and changes with any content change', async () => {
    const base = { subject: 's', text: 't', html: 'h', recipient: 'A@B.com' };
    expect(await contentHash(base)).toBe(await contentHash({ ...base, recipient: 'a@b.com' }));
    expect(await contentHash(base)).toMatch(/^[0-9a-f]{64}$/);
    for (const change of [{ subject: 'x' }, { text: 'x' }, { html: 'x' }, { recipient: 'c@d.com' }]) expect(await contentHash({ ...base, ...change })).not.toBe(await contentHash(base));
  });
});

describe('phase 4 permissions', () => {
  it('route role lists equal the permission map', () => {
    expect(sorted(sellerInterestApproveRoles)).toEqual(sorted(PERMISSIONS['seller_material_interest.approve']));
    expect(sorted(sellerInterestApproveRoles)).toEqual(sorted(PERMISSIONS['seller_material_interest.send']));
    expect(sorted(sellerRetentionRoles)).toEqual(sorted(PERMISSIONS['seller_retention.manage']));
    expect(sorted(sellerExportRoles)).toEqual(sorted(PERMISSIONS['seller_enquiries.export']));
    expect(sorted(sellerWorkRoles)).toEqual(sorted(PERMISSIONS['seller_communications.send']));
    expect(sorted(sellerWorkRoles)).toEqual(sorted(PERMISSIONS['seller_material_interest.record']));
  });
  it('keeps approval, retention and export away from brokers; export is super admin only', () => {
    for (const k of ['seller_material_interest.approve', 'seller_material_interest.send', 'seller_retention.manage', 'seller_enquiries.export'] as const) expect(PERMISSIONS[k]).not.toContain('broker');
    expect(PERMISSIONS['seller_enquiries.export']).toEqual(['super_admin']);
    expect(PERMISSIONS['seller_material_interest.record']).toContain('broker');
  });
});

describe('phase 4 schemas', () => {
  it('limits follow-up questions and requires the broker title', () => {
    expect(followupDraftSchema.safeParse({ questions: ['What is the timing?'], brokerTitle: 'Director' }).success).toBe(true);
    expect(followupDraftSchema.safeParse({ questions: [], brokerTitle: 'Director' }).success).toBe(false);
    expect(followupDraftSchema.safeParse({ questions: Array(9).fill('A question?'), brokerTitle: 'Director' }).success).toBe(false);
    expect(followupDraftSchema.safeParse({ questions: ['What is the timing?'], brokerTitle: 'D' }).success).toBe(false);
    expect(followupDraftSchema.safeParse({ questions: ['What is the timing?'], brokerTitle: 'Director', brokerTelephone: 'call me' }).success).toBe(false);
  });
  it('requires explicit confirmation to send and a typed reference to anonymise', () => {
    expect(sendMessageSchema.safeParse({ expectedVersion: 1, confirm: true }).success).toBe(true);
    expect(sendMessageSchema.safeParse({ expectedVersion: 1 }).success).toBe(false);
    expect(anonymiseSchema.safeParse({ reason: 'Erasure request', confirmReference: 'CM-S-ABC234', confirm: true }).success).toBe(true);
    expect(anonymiseSchema.safeParse({ reason: 'x', confirmReference: 'CM-S-ABC234', confirm: true }).success).toBe(false);
    expect(anonymiseSchema.safeParse({ reason: 'Erasure request', confirmReference: 'nope', confirm: true }).success).toBe(false);
    expect(legalHoldSchema.safeParse({ hold: true, reason: 'Litigation hold', confirm: true }).success).toBe(true);
  });
  it('validates interest records, reviews, drafts and privacy requests', () => {
    expect(interestRecordSchema.safeParse({ interestType: 'FORMAL_OFFER', source: 'Email', summary: 'Received an offer' }).success).toBe(true);
    expect(interestRecordSchema.safeParse({ interestType: 'SOME_OTHER', source: 'Email', summary: 'x y' }).success).toBe(false);
    expect(interestReviewSchema.safeParse({ action: 'approve', expectedVersion: 2, note: 'Reviewed', confirm: true }).success).toBe(true);
    expect(interestReviewSchema.safeParse({ action: 'publish', expectedVersion: 2, note: 'Reviewed' }).success).toBe(false);
    expect(notificationDraftSchema.safeParse({ brokerTitle: 'Director' }).success).toBe(true);
    expect(privacyRequestSchema.safeParse({ requestType: 'ERASURE', enquiryReference: 'CM-S-ABC234' }).success).toBe(true);
    expect(privacyRequestSchema.safeParse({ requestType: 'ERASURE', enquiryReference: 'bad' }).success).toBe(false);
    expect(privacyUpdateSchema.safeParse({ status: 'COMPLETED', outcomeNote: 'Erased as requested', expectedVersion: 1, confirm: true }).success).toBe(true);
    expect(privacyUpdateSchema.safeParse({ status: 'OPEN', outcomeNote: 'Erased as requested', expectedVersion: 1, confirm: true }).success).toBe(false);
  });
});
