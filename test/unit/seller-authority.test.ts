import { describe, expect, it } from 'vitest';
import { AUTHORITY_STATUSES, APPROVAL_STATUSES, canAuthorityTransition, isSafeEvidenceRef, recordSatisfies } from '../../src/seller/authority';
import { evaluatePublicationGates, type GateInput } from '../../src/seller/gates';
import { authorityCreateSchema, authorityTransitionSchema, convertSchema, linkSchema, publicationReviewSchema, sellerFromEnquirySchema, sellerUpdateSchema } from '../../src/seller/seller-schemas';
import { AUTHORITY_REF_PATTERN, SELLER_REF_PATTERN, generateRef } from '../../src/seller/reference';
import { PERMISSIONS } from '../../src/permissions/permissions';

const NOW = '2026-10-18T12:00:00.000Z';
const U = '11111111-1111-4111-8111-111111111111';
const rec = (authorityType: string, status: string, validFrom: string | null = null, validUntil: string | null = null) => ({ authorityType, status, validFrom, validUntil });

describe('authority transitions', () => {
  it('permits the documented review path and blocks shortcuts', () => {
    expect(canAuthorityTransition('NOT_REVIEWED', 'UNDER_REVIEW')).toBe(true);
    expect(canAuthorityTransition('UNDER_REVIEW', 'VERIFIED')).toBe(true);
    expect(canAuthorityTransition('NOT_REVIEWED', 'VERIFIED')).toBe(false);
    expect(canAuthorityTransition('EVIDENCE_REQUESTED', 'VERIFIED')).toBe(false);
    expect(canAuthorityTransition('REJECTED', 'VERIFIED')).toBe(false);
    expect(canAuthorityTransition('VERIFIED', 'REVOKED')).toBe(true);
    expect(canAuthorityTransition('REVOKED', 'UNDER_REVIEW')).toBe(false);
    expect(canAuthorityTransition('EXPIRED', 'VERIFIED')).toBe(false);
    for (const s of AUTHORITY_STATUSES) expect(canAuthorityTransition(s, s)).toBe(false);
  });
  it('treats verification, not-required, revoke and expiry as approvals', () => {
    expect([...APPROVAL_STATUSES].sort()).toEqual(['EXPIRED', 'NOT_REQUIRED_WITH_RECORDED_REASON', 'REVOKED', 'VERIFIED']);
  });
});

describe('recordSatisfies', () => {
  it('counts only verified records inside their validity window, or not-required records', () => {
    expect(recordSatisfies(rec('AUTHORITY_TO_MARKET', 'VERIFIED'), NOW)).toBe(true);
    expect(recordSatisfies(rec('AUTHORITY_TO_MARKET', 'VERIFIED', '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z'), NOW)).toBe(true);
    expect(recordSatisfies(rec('AUTHORITY_TO_MARKET', 'VERIFIED', null, '2026-10-18T12:00:00.000Z'), NOW)).toBe(false);
    expect(recordSatisfies(rec('AUTHORITY_TO_MARKET', 'VERIFIED', '2026-12-01T00:00:00.000Z'), NOW)).toBe(false);
    for (const s of ['NOT_REVIEWED', 'EVIDENCE_REQUESTED', 'UNDER_REVIEW', 'REJECTED', 'EXPIRED', 'REVOKED']) expect(recordSatisfies(rec('X', s), NOW)).toBe(false);
    expect(recordSatisfies(rec('BROKERAGE_MANDATE', 'NOT_REQUIRED_WITH_RECORDED_REASON'), NOW)).toBe(true);
  });
  it('accepts storage references and rejects URLs and traversal', () => {
    expect(isSafeEvidenceRef('DOC-2026-0042')).toBe(true);
    expect(isSafeEvidenceRef('vault:mandates/2026/abc')).toBe(true);
    expect(isSafeEvidenceRef('https://example.com/file.pdf')).toBe(false);
    expect(isSafeEvidenceRef('a b')).toBe(false);
    expect(isSafeEvidenceRef('../etc/passwd')).toBe(false);
    expect(isSafeEvidenceRef('ab')).toBe(false);
  });
});

const good = (): GateInput => ({
  links: [{ sellerReference: 'CM-C-AAAAAA', relationshipStatus: 'ACTIVE', reviewStatus: 'REVIEWED', records: [rec('AUTHORITY_TO_MARKET', 'VERIFIED'), rec('BROKERAGE_MANDATE', 'VERIFIED')] }],
  review: { status: 'APPROVED', scopeConfirmed: 1, confidentialityReviewed: 1, publicFieldsApproved: 1, sensitiveDataReviewed: 1, imageRightsChecked: 1, legalReviewCompleted: 1 },
});

describe('publication gates', () => {
  it('does not apply to opportunities that were never seller-sourced', () => {
    expect(evaluatePublicationGates({ links: [], review: null }, NOW)).toEqual({ applicable: false, unmet: [] });
  });
  it('passes only when every gate is met', () => {
    expect(evaluatePublicationGates(good(), NOW)).toEqual({ applicable: true, unmet: [] });
  });
  it('blocks on each missing control', () => {
    const noMarket = good(); noMarket.links[0]!.records = [rec('BROKERAGE_MANDATE', 'VERIFIED')];
    expect(evaluatePublicationGates(noMarket, NOW).unmet.join(' ')).toMatch(/authority to market/);
    const noMandate = good(); noMandate.links[0]!.records = [rec('AUTHORITY_TO_MARKET', 'VERIFIED')];
    expect(evaluatePublicationGates(noMandate, NOW).unmet.join(' ')).toMatch(/mandate/);
    const unreviewed = good(); unreviewed.links[0]!.reviewStatus = 'PENDING';
    expect(evaluatePublicationGates(unreviewed, NOW).unmet.join(' ')).toMatch(/confidentiality/);
    const noReview = good(); noReview.review = null;
    expect(evaluatePublicationGates(noReview, NOW).unmet).toContain('Publication review has not been approved.');
    const draft = good(); draft.review!.status = 'DRAFT';
    expect(evaluatePublicationGates(draft, NOW).unmet.length).toBe(1);
    const missingFlag = good(); missingFlag.review!.imageRightsChecked = 0;
    expect(evaluatePublicationGates(missingFlag, NOW).unmet.join(' ')).toMatch(/missing a required confirmation/);
  });
  it('blocks when authority is revoked, expired, or the relationship ended', () => {
    const revoked = good(); revoked.links[0]!.records = [rec('AUTHORITY_TO_MARKET', 'REVOKED'), rec('BROKERAGE_MANDATE', 'VERIFIED')];
    expect(evaluatePublicationGates(revoked, NOW).unmet.length).toBe(1);
    const expired = good(); expired.links[0]!.records = [rec('AUTHORITY_TO_MARKET', 'VERIFIED', null, '2026-10-01T00:00:00.000Z'), rec('BROKERAGE_MANDATE', 'VERIFIED')];
    expect(evaluatePublicationGates(expired, NOW).unmet.length).toBe(1);
    const ended = good(); ended.links[0]!.relationshipStatus = 'ENDED';
    expect(evaluatePublicationGates(ended, NOW).unmet.join(' ')).toMatch(/No active seller relationship/);
  });
  it('an authority of one type never satisfies another', () => {
    const wrong = good(); wrong.links[0]!.records = [rec('AUTHORITY_TO_REPRESENT', 'VERIFIED'), rec('AUTHORITY_TO_NEGOTIATE', 'VERIFIED'), rec('AUTHORITY_TO_SUBMIT', 'VERIFIED')];
    expect(evaluatePublicationGates(wrong, NOW).unmet.length).toBe(2); // still missing marketing authority and mandate
  });
  it('every active seller link must be satisfied', () => {
    const two = good();
    two.links.push({ sellerReference: 'CM-C-BBBBBB', relationshipStatus: 'ACTIVE', reviewStatus: 'REVIEWED', records: [rec('AUTHORITY_TO_MARKET', 'VERIFIED')] });
    expect(evaluatePublicationGates(two, NOW).unmet.join(' ')).toContain('CM-C-BBBBBB');
  });
});

describe('phase 3 schemas and references', () => {
  it('requires explicit confirmation and versions', () => {
    expect(sellerFromEnquirySchema.safeParse({ mode: 'create', expectedVersion: 1, confirm: true }).success).toBe(true);
    expect(sellerFromEnquirySchema.safeParse({ mode: 'create', expectedVersion: 1 }).success).toBe(false);
    expect(sellerFromEnquirySchema.safeParse({ mode: 'link', sellerReference: 'bad', expectedVersion: 1, confirm: true }).success).toBe(false);
    expect(convertSchema.safeParse({ title: 'Confidential Casino Opportunity', role: 'OWNER', expectedVersion: 2, confirm: true }).success).toBe(true);
    expect(convertSchema.safeParse({ title: 'ab', role: 'OWNER', expectedVersion: 2, confirm: true }).success).toBe(false);
    expect(linkSchema.safeParse({ opportunityId: U, role: 'OWNER', confirm: true }).success).toBe(true);
    expect(linkSchema.safeParse({ opportunityId: 'x', role: 'OWNER', confirm: true }).success).toBe(false);
  });
  it('rejects URL evidence references and bad dates', () => {
    expect(authorityCreateSchema.safeParse({ authorityType: 'BROKERAGE_MANDATE', evidenceType: 'SIGNED_MANDATE', evidenceRef: 'DOC-0042' }).success).toBe(true);
    expect(authorityCreateSchema.safeParse({ authorityType: 'BROKERAGE_MANDATE', evidenceType: 'SIGNED_MANDATE', evidenceRef: 'https://x.test/a.pdf' }).success).toBe(false);
    expect(authorityCreateSchema.safeParse({ authorityType: 'NOPE' }).success).toBe(false);
    expect(authorityTransitionSchema.safeParse({ to: 'VERIFIED', expectedVersion: 1, note: 'Reviewed signed mandate', confirm: true }).success).toBe(true);
    expect(authorityTransitionSchema.safeParse({ to: 'VERIFIED', expectedVersion: 1, note: 'x' }).success).toBe(false);
    expect(authorityTransitionSchema.safeParse({ to: 'VERIFIED', expectedVersion: 1, note: 'okay note', validUntil: 'next year' }).success).toBe(false);
  });
  it('requires a reason and at least one change for seller corrections, and ignores unknown fields', () => {
    expect(sellerUpdateSchema.safeParse({ expectedVersion: 1, reason: 'Typo in name', changes: { contactName: 'Jane Q Owner' } }).success).toBe(true);
    expect(sellerUpdateSchema.safeParse({ expectedVersion: 1, reason: 'Typo', changes: {} }).success).toBe(false);
    const r = sellerUpdateSchema.parse({ expectedVersion: 1, reason: 'Fix record', changes: { contactName: 'Jane', relationshipOwner: U } });
    expect(Object.keys(r.changes)).toEqual(['contactName']);
  });
  it('validates publication review input', () => {
    expect(publicationReviewSchema.safeParse({ action: 'approve', expectedVersion: 1, confirm: true }).success).toBe(true);
    expect(publicationReviewSchema.safeParse({ action: 'publish' }).success).toBe(false);
  });
  it('generates non-sequential references in the documented formats', () => {
    for (let i = 0; i < 100; i++) {
      expect(generateRef('CM-C')).toMatch(SELLER_REF_PATTERN);
      expect(generateRef('CM-A')).toMatch(AUTHORITY_REF_PATTERN);
    }
  });
  it('keeps verification and publication approval away from brokers', () => {
    expect(PERMISSIONS['authority.review']).not.toContain('broker');
    expect(PERMISSIONS['authority.approve']).not.toContain('broker');
    expect(PERMISSIONS['opportunities.approve_publication']).not.toContain('broker');
    expect(PERMISSIONS['authority.submit_evidence']).toContain('broker');
  });
});
