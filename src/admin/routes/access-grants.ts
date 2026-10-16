import { requireRole } from '../../auth/staff-session';
import { z } from 'zod';
import { Hono } from 'hono';
import { type AdminApp, id, now } from '../shared';
import { findGrant, listGrants, revokeGrant } from '../repos/access-grants-repo';

const admin = new Hono<AdminApp>();

admin.get('/access-grants/ui', requireRole('admin', 'publisher', 'super_admin'), async (c) =>
  c.html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Data-room access · Casinos of Mayfair</title><link rel="stylesheet" href="/static/css/site.css"><link rel="stylesheet" href="/static/css/dashboard.css"></head><body><main class="admin"><p class="eyebrow">STAFF WORKSPACE</p><h1>Data-room access grants</h1><p class="muted">Access is time-limited, independent from account status and revocable. Every revocation requires a reason and is audited.</p><nav class="admin-nav"><a href="/dashboard">Overview</a><a href="/dashboard/nda-requests/ui">NDA requests</a><a href="/dashboard/access-grants/ui">Access grants</a><a href="/dashboard/buyers/ui">Buyer access</a><a href="/admin/logout">Sign out</a></nav><p id="notice" role="status"></p><section id="grants">Loading access grants…</section></main><script src="/static/js/dashboard-access-grants.js" defer></script></body></html>`,
  ),
);

admin.get(
  '/access-grants',
  requireRole('admin', 'publisher', 'auditor', 'super_admin'),
  async (c) => {
    return c.json({ data: await listGrants(c.env.DB, now()) });
  },
);

admin.post(
  '/access-grants/:id/revoke',
  requireRole('admin', 'publisher', 'super_admin'),
  async (c) => {
    const parsed = z
      .object({ reason: z.string().trim().min(3).max(1000) })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'A revocation reason is required.' } },
        422,
      );
    const grant = await findGrant(c.env.DB, c.req.param('id'));
    if (!grant)
      return c.json({ error: { code: 'NOT_FOUND', message: 'Access grant not found.' } }, 404);
    if (grant.revokedAt)
      return c.json({ data: { id: grant.id, revoked: true, alreadyRevoked: true } });
    const timestamp = now();
    await revokeGrant(c.env.DB, {
      grant,
      staffId: c.get('staff').id,
      requestId: c.get('requestId'),
      reason: parsed.data.reason,
      auditId: id(),
      timestamp,
    });
    return c.json({ data: { id: grant.id, revoked: true, revokedAt: timestamp } });
  },
);

export default admin;
