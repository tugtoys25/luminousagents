import { describe, expect, it } from 'vitest';
import { PERMISSIONS } from '../../src/permissions/permissions';
import { sellerAssignRoles, sellerNoteRoles, sellerReadRoles, sellerWorkRoles } from '../../src/admin/shared';
import { assignSchema, communicationSchema, followupSchema, listQuerySchema, noteSchema, qualificationSchema, statusSchema } from '../../src/seller/staff-schemas';
import { QUALIFICATION_ITEMS } from '../../src/seller/lifecycle';
import { reminderPolicy, reminderWindow } from '../../src/seller/reminders';
import { renderSellerFollowupDue } from '../../src/seller/emails';
import type { Env } from '../../src/env';

const sorted = (a: readonly string[]) => [...a].sort();
const U = '11111111-1111-4111-8111-111111111111';

describe('seller permissions', () => {
  it('route role lists equal the permission map', () => {
    expect(sorted(sellerReadRoles)).toEqual(sorted(PERMISSIONS['seller_enquiries.read']));
    expect(sorted(sellerAssignRoles)).toEqual(sorted(PERMISSIONS['seller_enquiries.assign']));
    for (const key of ['seller_enquiries.update_status', 'seller_enquiries.record_communication', 'seller_followups.manage'] as const)
      expect(sorted(sellerWorkRoles)).toEqual(sorted(PERMISSIONS[key]));
    // Compliance may add notes but not change status or record communications, so notes have their own list.
    expect(sorted(sellerNoteRoles)).toEqual(sorted(PERMISSIONS['seller_enquiries.add_note']));
  });
  it('does not grant seller data to editors, publishers or auditors, and keeps assignment/closure with managers', () => {
    for (const role of ['editor', 'publisher', 'auditor']) expect(sellerReadRoles).not.toContain(role);
    expect(sellerAssignRoles).not.toContain('broker');
    expect(PERMISSIONS['seller_enquiries.close']).not.toContain('broker');
  });
});

describe('staff input schemas', () => {
  it('requires explicit confirmation to assign and a real assignee', () => {
    expect(assignSchema.safeParse({ assigneeId: U, expectedVersion: 1, confirm: true }).success).toBe(true);
    expect(assignSchema.safeParse({ assigneeId: U, expectedVersion: 1 }).success).toBe(false);
    expect(assignSchema.safeParse({ assigneeId: 'x', expectedVersion: 1, confirm: true }).success).toBe(false);
  });
  it('validates status requests and ignores client-supplied extras', () => {
    expect(statusSchema.safeParse({ to: 'CLOSED', expectedVersion: 2, reason: 'No mandate', confirm: true }).success).toBe(true);
    expect(statusSchema.safeParse({ to: 'BOGUS', expectedVersion: 2 }).success).toBe(false);
    const r = statusSchema.parse({ to: 'QUALIFIED', expectedVersion: 1, assignedTo: U, status: 'CONVERTED' });
    expect(Object.keys(r)).not.toContain('assignedTo');
  });
  it('rejects control characters and bad lengths in notes and communications', () => {
    expect(noteSchema.safeParse({ note: 'ok note' }).success).toBe(true);
    expect(noteSchema.safeParse({ note: 'x' }).success).toBe(false);
    expect(noteSchema.safeParse({ note: 'bad\u0000note' }).success).toBe(false);
    expect(communicationSchema.safeParse({ direction: 'OUTBOUND', channel: 'TELEPHONE', outcome: 'CONNECTED', summary: 'Spoke briefly' }).success).toBe(true);
    expect(communicationSchema.safeParse({ direction: 'SIDEWAYS', channel: 'TELEPHONE', outcome: 'CONNECTED', summary: 'x' }).success).toBe(false);
  });
  it('requires every qualification item exactly once', () => {
    const items = QUALIFICATION_ITEMS.map((key) => ({ key, answer: 'YES' as const }));
    expect(qualificationSchema.safeParse({ items, outcome: 'PASS', nextAction: 'Request evidence' }).success).toBe(true);
    expect(qualificationSchema.safeParse({ items: items.slice(1), outcome: 'PASS', nextAction: 'x y z' }).success).toBe(false);
    expect(qualificationSchema.safeParse({ items: [...items.slice(1), items[1]!], outcome: 'PASS', nextAction: 'x y z' }).success).toBe(false);
  });
  it('defaults bad list filters instead of failing', () => {
    const q = listQuerySchema.parse({ status: 'WRONG', page: 'abc', country: 'gb', assigned: 'nope' });
    expect(q.status).toBeUndefined();
    expect(q.page).toBe(1);
    expect(q.country).toBeUndefined();
    expect(q.assigned).toBeUndefined();
  });
  it('requires a future-capable ISO due time for follow-ups', () => {
    expect(followupSchema.safeParse({ title: 'Call seller', dueAt: '2026-11-01T09:00:00.000Z' }).success).toBe(true);
    expect(followupSchema.safeParse({ title: 'Call seller', dueAt: 'tomorrow' }).success).toBe(false);
  });
});

describe('reminder policy and windows', () => {
  it('defaults to enabled, 24h interval, escalation off, and is adjustable by configuration', () => {
    const p = reminderPolicy({} as Env);
    expect(p).toMatchObject({ enabled: true, intervalMs: 86_400_000, escalateAfterMs: 0 });
    expect(reminderPolicy({ SELLER_REMINDERS_ENABLED: 'false' } as Env).enabled).toBe(false);
    expect(reminderPolicy({ SELLER_REMINDER_INTERVAL_HOURS: '6', SELLER_ESCALATION_AFTER_HOURS: '48', SELLER_ESCALATION_RECIPIENTS: 'a@b.co' } as Env)).toMatchObject({ intervalMs: 21_600_000, escalateAfterMs: 172_800_000, hasEscalationRecipients: true });
  });
  it('is stable within a window and advances in the next (idempotent per window)', () => {
    const due = Date.parse('2026-10-18T09:00:00Z');
    const h = 3_600_000;
    expect(reminderWindow(due, due + 1, 24 * h)).toBe(0);
    expect(reminderWindow(due, due + 23 * h, 24 * h)).toBe(0);
    expect(reminderWindow(due, due + 25 * h, 24 * h)).toBe(1);
    expect(reminderWindow(due, due - h, 24 * h)).toBe(0);
  });
  it('renders the internal reminder with the required fields and no seller free text', () => {
    const m = renderSellerFollowupDue(
      { taskId: 't', taskStatus: 'open', title: 'Chase <b>evidence</b>', dueAt: '2026-10-18T09:00:00.000Z', reference: 'CM-S-ABC234', contactName: 'Jane', enquiryStatus: 'QUALIFICATION', assigneeName: 'Bo', assigneeEmail: 'bo@x.co', lastContactAt: null },
      { baseUrl: 'https://example.test', companyWebsite: 'https://example.test', includePhone: false, includePrice: false }, true);
    expect(m.subject).toBe('Escalated: Seller Follow-up Due — CM-S-ABC234');
    expect(m.text).toContain('This is an internal reminder.');
    expect(m.text).toContain('https://example.test/dashboard/seller-enquiries/ui?selected=CM-S-ABC234');
    expect(m.html).not.toContain('<b>evidence</b>');
  });
});
