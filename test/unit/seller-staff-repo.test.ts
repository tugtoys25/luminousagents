import { describe, expect, it } from 'vitest';
import { applyStatusOrAssignment, completeFollowup, enqueueReminderJob, insertNote, listEnquiries, type EnquiryRef } from '../../src/seller/staff-repo';

type Stmt = { sql: string; args: unknown[] };
const fake = (changes = 1) => {
  const batches: Stmt[][] = [];
  const queries: Stmt[] = [];
  const db = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({ sql, args, all: async () => (queries.push({ sql, args }), { results: [] }), first: async () => (queries.push({ sql, args }), { total: 0 }) }),
    }),
    batch: async (s: Stmt[]) => (batches.push(s), s.map(() => ({ meta: { changes } }))),
  };
  return { db: db as unknown as D1Database, batches, queries };
};
const enquiry: EnquiryRef = { id: 'e1', reference: 'CM-S-ABC234', status: 'NEW', assignedTo: null, version: 3, firstResponseAt: null };
const actor = { id: 'u1', requestId: 'r1', ts: '2026-10-18T10:00:00.000Z' };

describe('staff repository', () => {
  it('guards updates on the expected version and writes history/audit only when the row changed', async () => {
    const f = fake(1);
    expect(await applyStatusOrAssignment(f.db, { ...actor, enquiry, toStatus: 'ASSIGNED', toAssignee: 'u2', reason: null, closing: false, ids: ['h1', 'a1'], action: 'seller_enquiry.assigned' })).toBe(true);
    const [update, history, audit] = f.batches[0]!;
    expect(update!.sql).toContain('version = version + 1');
    expect(update!.sql).toContain('WHERE id = ? AND version = ?');
    expect(update!.args.slice(-2)).toEqual(['e1', 3]);
    expect(history!.sql).toContain('WHERE changes() > 0');
    expect(audit!.sql).toContain('WHERE changes() > 0');
  });
  it('reports a version conflict when no row changed', async () => {
    const f = fake(0);
    expect(await applyStatusOrAssignment(f.db, { ...actor, enquiry, toStatus: 'CLOSED', toAssignee: null, reason: 'No fit', closing: true, ids: ['h1', 'a1'], action: 'x' })).toBe(false);
  });
  it('never puts note text into the audit payload', async () => {
    const f = fake();
    await insertNote(f.db, { ...actor, enquiry, noteId: 'n1', auditId: 'a1', classification: 'GENERAL', note: 'TOP SECRET TERMS' });
    expect(JSON.stringify(f.batches[0]![1]!.args)).not.toContain('TOP SECRET');
  });
  it('only completes tasks that belong to the enquiry', async () => {
    const f = fake(1);
    await completeFollowup(f.db, { ...actor, enquiry, taskId: 't1', auditId: 'a1', outcome: 'Done' });
    const sql = f.batches[0]![0]!.sql;
    expect(sql).toContain("related_entity_type = 'seller_enquiry'");
    expect(sql).toContain('related_entity_id = ?');
  });
  it('creates a reminder job once per dedupe key and only counts a reminder when created', async () => {
    const f = fake(1);
    expect(await enqueueReminderJob(f.db, { jobId: 'j1', taskId: 't1', enquiryId: 'e1', dedupeKey: 'seller_followup_due:t1:0', escalate: false, ts: actor.ts })).toBe(true);
    expect(f.batches[0]![0]!.sql).toContain('INSERT OR IGNORE');
    expect(f.batches[0]![1]!.sql).toContain('changes() > 0');
    expect(await enqueueReminderJob(fake(0).db, { jobId: 'j2', taskId: 't1', enquiryId: 'e1', dedupeKey: 'seller_followup_due:t1:0', escalate: false, ts: actor.ts })).toBe(false);
  });
  it('scopes brokers to their own enquiries and keeps contact details out of the list', async () => {
    const f = fake();
    await listEnquiries(f.db, { page: 1 }, { brokerOnly: 1, staffId: 'u9' }, actor.ts);
    const q = f.queries[0]!;
    expect(q.sql).toContain('e.assigned_to = ?');
    expect(q.args).toContain('u9');
    expect(q.sql).not.toMatch(/e\.telephone|e\.asset_description|SELECT e\.email/);
  });
});
