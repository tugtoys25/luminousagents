import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { findNdaRequest, findSignedPdf, listNdaRequests, reviewNdaRequest } from '../../src/admin/repos/nda-requests-repo';

// These steps share database state and must run in order. The Workers test pool undoes storage after
// every test, so they run as steps inside one test instead of as separate `it` blocks.
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof Error) error.message = `[${name}] ${error.message}`;
    throw error;
  }
}

const ts = '2026-03-01T10:00:00.000Z';
let oppA = '';
let oppB = '';
const user = (id: string, type: string, role: string) =>
  env.DB.prepare(
    "INSERT INTO users (id, email, display_name, role, user_type, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)",
  ).bind(id, `${id}@example.com`, id, role, type, ts, ts).run();
const request = (id: string, opp: string) =>
  env.DB.prepare(
    "INSERT INTO nda_requests (id, user_id, opportunity_id, status, created_at, updated_at) VALUES (?, 'nr-buyer', ?, 'pending', ?, ?)",
  ).bind(id, opp, ts, ts).run();
const args = (id: string, over: Record<string, unknown> = {}) => ({
  request: { id, userId: 'nr-buyer', opportunityId: oppA, status: 'pending' },
  decision: 'approved' as const, reason: 'fine', tier: 2 as const, staffId: 'nr-staff', requestId: 'rq',
  timestamp: '2026-04-01T00:00:00.000Z', expiry: '2026-05-01T00:00:00.000Z',
  grantId: `grant-${id}`, auditId: `aud-${id}`, decisionJobId: `job-${id}`, ...over,
});
const count = async (sql: string, ...b: unknown[]) =>
  (await env.DB.prepare(sql).bind(...b).first<{ n: number }>())!.n;

describe('nda requests repo', () => {
  it('runs its steps in order', async () => {
    await step('lists requests with broker scoping and status filtering', async () => {
      await user('nr-staff', 'staff', 'broker');
      await user('nr-buyer', 'buyer', 'buyer');
      const opps = (await env.DB.prepare('SELECT id FROM opportunities LIMIT 2').all<{ id: string }>()).results;
      oppA = opps[0]!.id;
      oppB = opps[1]!.id;
      await env.DB.prepare('UPDATE opportunities SET assigned_broker_id = ? WHERE id = ?').bind('nr-staff', oppA).run();
      await request('nr-1', oppA);
      await request('nr-2', oppB);
  
      const adminView = await listNdaRequests(env.DB, { status: '', brokerOnly: 0, staffId: 'x' });
      expect(adminView.map((r) => r['id']).sort()).toEqual(['nr-1', 'nr-2']);
      const brokerView = await listNdaRequests(env.DB, { status: '', brokerOnly: 1, staffId: 'nr-staff' });
      expect(brokerView.map((r) => r['id'])).toEqual(['nr-1']);
      expect((await listNdaRequests(env.DB, { status: 'approved', brokerOnly: 0, staffId: 'x' })).length).toBe(0);
      expect(brokerView[0]!['hasSignedPdf']).toBe(0);
    });

    await step('approval records the decision, grant, audit and notification job together', async () => {
      await reviewNdaRequest(env.DB, args('nr-1'));
      expect((await findNdaRequest(env.DB, 'nr-1'))?.status).toBe('approved');
      const grant = await env.DB.prepare("SELECT tier, expires_at AS e, user_id AS u FROM access_grants WHERE id='grant-nr-1'").first<{ tier: number; e: string; u: string }>();
      expect(grant).toMatchObject({ tier: 2, e: '2026-05-01T00:00:00.000Z', u: 'nr-buyer' });
      const a = await env.DB.prepare("SELECT action, details_json AS d FROM audit_logs WHERE id='aud-nr-1'").first<{ action: string; d: string }>();
      expect(a?.action).toBe('nda.approved');
      expect(JSON.parse(a!.d).expiresAt).toBe('2026-05-01T00:00:00.000Z');
      expect(await count("SELECT COUNT(*) AS n FROM notification_jobs WHERE id='job-nr-1' AND job_type='nda.decision' AND status='queued'")).toBe(1);
    });

    await step('rejection creates no grant and records no expiry', async () => {
      await reviewNdaRequest(env.DB, args('nr-2', { decision: 'rejected', request: { id: 'nr-2', userId: 'nr-buyer', opportunityId: oppB, status: 'pending' } }));
      expect((await findNdaRequest(env.DB, 'nr-2'))?.status).toBe('rejected');
      expect(await count("SELECT COUNT(*) AS n FROM access_grants WHERE nda_request_id='nr-2'")).toBe(0);
      const a = await env.DB.prepare("SELECT action, details_json AS d FROM audit_logs WHERE id='aud-nr-2'").first<{ action: string; d: string }>();
      expect(a?.action).toBe('nda.rejected');
      expect(JSON.parse(a!.d).expiresAt).toBeNull();
    });

    await step('is atomic: a failing statement leaves the request pending with no grant or job', async () => {
      await request('nr-3', oppA);
      let threw = false;
      try {
        await reviewNdaRequest(env.DB, args('nr-3', { auditId: 'aud-nr-1' })); // duplicate audit id
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
      expect((await findNdaRequest(env.DB, 'nr-3'))?.status).toBe('pending');
      expect(await count("SELECT COUNT(*) AS n FROM access_grants WHERE id='grant-nr-3'")).toBe(0);
      expect(await count("SELECT COUNT(*) AS n FROM notification_jobs WHERE id='job-nr-3'")).toBe(0);
    });

    await step('finds signed-PDF references and returns null for unknown requests', async () => {
      await env.DB.prepare("UPDATE nda_requests SET signed_pdf_r2_key='k', signed_pdf_sha256='abc' WHERE id='nr-3'").run();
      expect(await findSignedPdf(env.DB, 'nr-3')).toMatchObject({ id: 'nr-3', r2Key: 'k', sha256: 'abc' });
      expect((await findSignedPdf(env.DB, 'nr-1'))?.r2Key).toBeNull();
      expect(await findSignedPdf(env.DB, 'nope')).toBeNull();
      expect(await findNdaRequest(env.DB, 'nope')).toBeNull();
    });
  });
});
