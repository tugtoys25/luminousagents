import { z } from 'zod';
import { QUALIFICATION_ITEMS, SELLER_STATUSES } from './lifecycle';
import { ASSET_TYPES } from './schema';

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const text = (min: number, max: number) => z.string().trim().min(min).max(max).refine((v) => !CONTROL.test(v), 'Unsupported characters');
const uuid = z.string().uuid();
const version = z.number().int().min(1);

export const listQuerySchema = z.object({
  status: z.enum(SELLER_STATUSES).optional().catch(undefined),
  assigned: z.union([z.literal('unassigned'), uuid]).optional().catch(undefined),
  country: z.string().regex(/^[A-Z]{2}$/).optional().catch(undefined),
  assetType: z.enum(ASSET_TYPES).optional().catch(undefined),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().catch(undefined),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().catch(undefined),
  due: z.enum(['overdue', 'today']).optional().catch(undefined),
  q: z.string().trim().max(100).optional().catch(undefined),
  page: z.coerce.number().int().min(1).max(10_000).catch(1),
});

export const assignSchema = z.object({ assigneeId: uuid, expectedVersion: version, confirm: z.literal(true) });
export const statusSchema = z.object({
  to: z.enum(SELLER_STATUSES),
  expectedVersion: version,
  reason: text(5, 1000).optional(),
  confirm: z.boolean().optional(),
});
export const noteSchema = z.object({
  note: text(2, 3000),
  classification: z.enum(['GENERAL', 'QUALIFICATION', 'CONFIDENTIALITY', 'AUTHORITY', 'COMPLIANCE']).default('GENERAL'),
});
export const communicationSchema = z.object({
  direction: z.enum(['INBOUND', 'OUTBOUND']),
  channel: z.enum(['EMAIL', 'TELEPHONE', 'MEETING', 'MESSAGE', 'OTHER']),
  outcome: z.enum(['CONNECTED', 'NO_ANSWER', 'LEFT_MESSAGE', 'SENT', 'RECEIVED', 'OTHER']),
  // A safe summary only: staff are told not to paste confidential content or secrets here.
  summary: text(2, 1000),
  occurredAt: z.string().datetime().optional(),
});
export const followupSchema = z.object({
  title: text(3, 160),
  taskType: z.enum(['CALL', 'EMAIL', 'REVIEW', 'AUTHORITY_CHASE', 'OTHER']).default('CALL'),
  dueAt: z.string().datetime(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  assignedTo: uuid.optional(),
});
export const completeFollowupSchema = z.object({ outcome: text(2, 1000) });
export const qualificationSchema = z.object({
  items: z.array(z.object({
    key: z.enum(QUALIFICATION_ITEMS),
    answer: z.enum(['YES', 'NO', 'UNKNOWN', 'NOT_APPLICABLE']),
    note: text(1, 500).optional(),
  })).length(QUALIFICATION_ITEMS.length)
    .refine((items) => new Set(items.map((i) => i.key)).size === QUALIFICATION_ITEMS.length, 'Each checklist item must be answered once'),
  outcome: z.enum(['PASS', 'FAIL', 'NEEDS_MORE_INFO']),
  nextAction: text(3, 500),
  // Records only that the matter was routed to the established legal/KYC/AML process; never that checks passed.
  complianceRouted: z.boolean().default(false),
});
