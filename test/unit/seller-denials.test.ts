import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AdminApp } from '../../src/admin/shared';
import { auditSellerDenials, routePattern } from '../../src/seller/denial-audit';
import { stepUpResponse, type Ctx } from '../../src/seller/staff-access';

function harness(respond: () => Response | Promise<Response>, dbFails = false) {
  const rows: unknown[][] = [];
  const db = { prepare: (sql: string) => ({ bind: (...args: unknown[]) => ({ run: async () => { if (dbFails) throw new Error('audit store down'); rows.push([sql, ...args]); return { meta: { changes: 1 } }; } }) }) };
  const app = new Hono<AdminApp>();
  app.use('*', async (c, next) => { c.set('staff', { id: 'staff-1', role: 'broker' } as never); c.set('requestId', 'req-1'); await next(); });
  app.use('/sellers/*', auditSellerDenials);
  app.get('/sellers/:ref', () => respond());
  const call = (path: string) => app.request(path, {}, { DB: db } as never);
  return { call, rows };
}
const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('audit of refused seller requests', () => {
  it('records a role refusal with the route shape and role, not the record identifier', async () => {
    const h = harness(() => json({ error: { code: 'FORBIDDEN' } }, 403));
    expect((await h.call('/sellers/CM-C-ABC234')).status).toBe(403);
    expect(h.rows).toHaveLength(1);
    const args = h.rows[0]!.slice(1);
    expect(args).toContain('seller.permission_denied');
    expect(args).toContain('/sellers/:id');
    expect(JSON.stringify(args)).not.toContain('CM-C-ABC234');
    expect(JSON.stringify(args)).toContain('broker');
  });
  it('distinguishes a missing step-up from a role refusal', async () => {
    const h = harness(() => json({ error: { code: 'STEP_UP_REQUIRED' } }, 403));
    await h.call('/sellers/CM-C-ABC234');
    expect(h.rows[0]!.slice(1)).toContain('seller.step_up_required');
  });
  it('does not log successes or not-found responses (404 is deliberate for out-of-scope records)', async () => {
    for (const status of [200, 404, 409]) {
      const h = harness(() => json({ ok: true }, status));
      await h.call('/sellers/CM-C-ABC234');
      expect(h.rows).toHaveLength(0);
    }
  });
  it('never turns a refusal into an error if the audit write fails', async () => {
    const h = harness(() => json({ error: { code: 'FORBIDDEN' } }, 403), true);
    expect((await h.call('/sellers/CM-C-ABC234')).status).toBe(403);
  });
  it('route patterns hide references and UUIDs', () => {
    expect(routePattern('/dashboard/seller-enquiries/CM-S-ABC234/followups/11111111-1111-4111-8111-111111111111/complete')).toBe('/dashboard/seller-enquiries/:id/followups/:id/complete');
    expect(routePattern('/dashboard/sellers/ui')).toBe('/dashboard/sellers/ui');
  });
});

describe('inline step-up check', () => {
  const ctx = (mfa: unknown): Ctx => ({ get: (k: string) => (k === 'mfa' ? mfa : 'req-1'), json: (body: unknown, status: number) => json(body, status) }) as unknown as Ctx;
  it('refuses without a recent second factor and passes with one', async () => {
    const refused = stepUpResponse(ctx({ enrolled: true, verifiedAt: null }), '/dashboard/seller-enquiries/ui');
    expect(refused?.status).toBe(403);
    expect(((await refused!.json()) as { error: { code: string } }).error.code).toBe('STEP_UP_REQUIRED');
    expect(stepUpResponse(ctx({ enrolled: true, verifiedAt: new Date().toISOString() }), '/dashboard/seller-enquiries/ui')).toBeNull();
  });
});
