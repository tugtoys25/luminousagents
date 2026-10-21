import { z } from 'zod';
import { AUTHORITY_STATUSES, AUTHORITY_TYPES, EVIDENCE_TYPES, isSafeEvidenceRef } from './authority';
import { OPPORTUNITY_TYPES } from './seller-constants';

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const text = (min: number, max: number) => z.string().trim().min(min).max(max).refine((v) => !CONTROL.test(v), 'Unsupported characters');
const optionalText = (max: number) => z.string().trim().max(max).refine((v) => !CONTROL.test(v), 'Unsupported characters').optional();
const uuid = z.string().uuid();
const version = z.number().int().min(1);
const isoDate = z.string().datetime();
export const LINK_ROLES = ['OWNER', 'AUTHORISED_REPRESENTATIVE', 'BROKER_INTERMEDIARY', 'PROFESSIONAL_ADVISER', 'OTHER'] as const;

export const sellerListQuery = z.object({
  q: z.string().trim().max(100).optional().catch(undefined),
  status: z.enum(['ACTIVE', 'RESTRICTED', 'INACTIVE']).optional().catch(undefined),
  page: z.coerce.number().int().min(1).max(10_000).catch(1),
});
export const sellerFromEnquirySchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('create'), expectedVersion: version, confirm: z.literal(true) }),
  z.object({ mode: z.literal('link'), sellerReference: z.string().regex(/^CM-C-[A-HJ-NP-Z2-9]{6}$/), expectedVersion: version, confirm: z.literal(true) }),
]);
export const sellerUpdateSchema = z.object({
  expectedVersion: version,
  reason: text(5, 500),
  changes: z.object({
    displayName: text(2, 160), organisation: text(1, 160).nullable(), contactName: text(2, 120), contactEmail: z.string().trim().max(254).email(),
    contactTelephone: text(5, 40).nullable(), status: z.enum(['ACTIVE', 'RESTRICTED', 'INACTIVE']), confidentialityRestrictions: optionalText(2000),
  }).partial().refine((v) => Object.keys(v).length > 0, 'Provide at least one change'),
});
export const linkSchema = z.object({ opportunityId: uuid, role: z.enum(LINK_ROLES), confidentialityRestrictions: optionalText(2000), confirm: z.literal(true) });
export const linkReviewSchema = z.object({ confirm: z.literal(true) });
export const convertSchema = z.object({
  title: text(3, 180),
  country: optionalText(100),
  opportunityType: z.enum(OPPORTUNITY_TYPES).default('casino-hotel'),
  role: z.enum(LINK_ROLES),
  expectedVersion: version,
  confirm: z.literal(true),
});
export const authorityCreateSchema = z.object({
  authorityType: z.enum(AUTHORITY_TYPES),
  evidenceType: z.enum(EVIDENCE_TYPES).default('NONE'),
  evidenceRef: z.string().trim().refine(isSafeEvidenceRef, 'Use a storage or compliance-system reference, not a URL').optional(),
  scope: optionalText(1000), limitations: optionalText(1000), exclusive: z.boolean().default(false),
  validFrom: isoDate.optional(), validUntil: isoDate.optional(),
});
export const authorityTransitionSchema = z.object({
  to: z.enum(AUTHORITY_STATUSES), expectedVersion: version, note: text(3, 1000), confirm: z.boolean().optional(),
  evidenceType: z.enum(EVIDENCE_TYPES).optional(),
  evidenceRef: z.string().trim().refine(isSafeEvidenceRef, 'Use a storage or compliance-system reference, not a URL').optional(),
  scope: optionalText(1000), limitations: optionalText(1000), validFrom: isoDate.optional(), validUntil: isoDate.optional(),
});
export const publicationReviewSchema = z.object({
  action: z.enum(['save', 'approve', 'reject', 'revoke']),
  expectedVersion: version.optional(),
  scopeText: optionalText(1000),
  scopeConfirmed: z.boolean().optional(), confidentialityReviewed: z.boolean().optional(), publicFieldsApproved: z.boolean().optional(),
  sensitiveDataReviewed: z.boolean().optional(), imageRightsChecked: z.boolean().optional(), legalReviewCompleted: z.boolean().optional(),
  notes: optionalText(2000), reason: optionalText(500), confirm: z.boolean().optional(),
});

// ---- Phase 4 ----
const PHONE = /^[0-9+()\-.\s/xX#]{5,40}$/;
export const followupDraftSchema = z.object({
  questions: z.array(text(5, 300)).min(1).max(8),
  brokerTitle: text(2, 80),
  brokerTelephone: z.string().trim().regex(PHONE).optional(),
});
export const sendMessageSchema = z.object({ expectedVersion: version, confirm: z.literal(true) });
export const cancelMessageSchema = z.object({ reason: text(5, 500), confirm: z.literal(true) });
export const INTEREST_TYPES = ['INITIAL_ENQUIRY', 'REQUEST_FOR_INFORMATION', 'MEETING_REQUEST', 'INDICATION_OF_INTEREST', 'INDICATIVE_PROPOSAL', 'FORMAL_OFFER'] as const;
export const interestRecordSchema = z.object({
  interestType: z.enum(INTEREST_TYPES), receivedAt: isoDate.optional(), source: text(2, 200), summary: text(2, 2000), buyerReference: optionalText(120),
});
export const interestReviewSchema = z.object({
  action: z.enum(['start_review', 'approve', 'reject', 'withdraw']), expectedVersion: version, note: text(3, 1000), confirm: z.boolean().optional(),
  approvedSummary: optionalText(1500), proposedNextStep: optionalText(500), stageLabel: optionalText(120),
  confidentialityChecked: z.boolean().optional(), notificationEligible: z.boolean().optional(),
});
export const notificationDraftSchema = z.object({ brokerTitle: text(2, 80), brokerTelephone: z.string().trim().regex(PHONE).optional() });
export const anonymiseSchema = z.object({ reason: text(5, 500), confirmReference: z.string().regex(/^CM-S-[A-HJ-NP-Z2-9]{6}$/), confirm: z.literal(true) });
export const legalHoldSchema = z.object({ hold: z.boolean(), reason: text(5, 500), confirm: z.literal(true) });
export const privacyRequestSchema = z.object({
  requestType: z.enum(['ACCESS', 'ERASURE', 'RECTIFICATION', 'RESTRICTION', 'MARKETING_WITHDRAWAL', 'OTHER']),
  enquiryReference: z.string().regex(/^CM-S-[A-HJ-NP-Z2-9]{6}$/).optional(), receivedAt: isoDate.optional(), dueAt: isoDate.optional(),
});
export const privacyUpdateSchema = z.object({ status: z.enum(['IN_PROGRESS', 'COMPLETED', 'REFUSED']), outcomeNote: text(5, 1000), expectedVersion: version, confirm: z.literal(true) });

// ---- Gap closure ----
export const contactSchema = z.object({
  name: text(2, 120), roleTitle: optionalText(120), email: z.string().trim().max(254).email(),
  telephone: z.string().trim().regex(/^[0-9+()\-.\s/xX#]{5,40}$/).optional(),
});
export const sellerAnonymiseSchema = z.object({ reason: text(5, 500), confirmReference: z.string().regex(/^CM-C-[A-HJ-NP-Z2-9]{6}$/), confirm: z.literal(true) });

// ---- Editable policy ----
export const policyChangeSchema = z.object({
  value: z.unknown().optional(), reset: z.boolean().optional(), expectedVersion: z.number().int().min(0), reason: text(5, 500), confirm: z.literal(true),
});

// ---- Evidence ----
export const evidenceReasonSchema = z.object({ reason: text(5, 500), confirm: z.literal(true) });
export const evidenceDeleteSchema = z.object({ reason: text(5, 500), confirmId: uuid, confirm: z.literal(true) });
