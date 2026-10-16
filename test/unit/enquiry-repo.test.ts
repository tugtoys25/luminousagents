import { describe, expect, it } from 'vitest';
import { insertEnquiryBundle, type EnquiryBundle } from '../../src/enquiries/repo';

type Call = { sql: string; args: unknown[] };
function fakeDb() {
  const calls: Call[] = [];
  let batches = 0;
  const db = {
    prepare(sql: string) {
      return { bind: (...args: unknown[]) => ({ sql, args }) };
    },
    async batch(stmts: Call[]) {
      batches++;
      calls.push(...stmts);
    },
  };
  return { db: db as unknown as D1Database, calls, batches: () => batches };
}
const bundle = (over: Partial<EnquiryBundle> = {}): EnquiryBundle => ({
  enquiryId: 'e1', opportunityId: 'o1', opportunityTitle: 'Hotel', assignedBrokerId: 'b1',
  name: 'N', email: 'n@x.com', company: '', message: 'hello there friend', ipHash: null,
  requestId: 'r1', taskId: 't1', auditId: 'a1', jobId: 'j1', acknowledgementJobId: 'j2',
  brokerJobId: 'j3', timestamp: '2026-01-01T00:00:00.000Z', dueAt: '2026-01-02T16:00:00.000Z', ...over,
});

describe('insertEnquiryBundle', () => {
  it('writes enquiry, task, audit and three jobs in ONE batch when a broker is assigned', async () => {
    const f = fakeDb();
    await insertEnquiryBundle(f.db, bundle());
    expect(f.batches()).toBe(1);
    expect(f.calls).toHaveLength(6);
    expect(f.calls.filter((c) => c.sql.includes('notification_jobs'))).toHaveLength(3);
  });
  it('skips the broker job when nobody is assigned', async () => {
    const f = fakeDb();
    await insertEnquiryBundle(f.db, bundle({ assignedBrokerId: null, brokerJobId: null }));
    expect(f.calls).toHaveLength(5);
  });
  it('puts the opportunity title in the task description', async () => {
    const f = fakeDb();
    await insertEnquiryBundle(f.db, bundle());
    expect(String(f.calls[1]!.args[2])).toContain('Opportunity: Hotel');
  });
});
