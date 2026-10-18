import { requireRole } from '../../auth/staff-session';
import { requireRecentMfa } from '../../auth/step-up';
import { z } from 'zod';
import { issueResetToken } from '../../auth/password';
import { Hono } from 'hono';
import { activateInvitedBuyer, createActiveBuyer, findAccountByEmail, findActiveBuyerContact, findBuyer, findBuyerContact, listBuyers, setBuyerStatus } from '../repos/buyers-repo';
import { type AdminApp, audit, id, issueTemporaryPassword, now } from '../shared';

const admin = new Hono<AdminApp>();

admin.get('/buyers/ui', requireRole('admin', 'super_admin'), async (c) =>
  c.html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Buyer access · Casinos of Mayfair</title><link rel="stylesheet" href="/static/css/site.css"><link rel="stylesheet" href="/static/css/dashboard.css"></head><body><main class="admin"><p class="eyebrow">STAFF WORKSPACE</p><h1>Buyer access</h1><nav class="admin-nav"><a href="/dashboard">Overview</a><a href="/dashboard/opportunities/ui">Opportunity CMS</a><a href="/dashboard/nda-requests/ui">NDA requests</a><a href="/dashboard/access-grants/ui">Access grants</a><a href="/admin/logout">Sign out</a></nav><p class="muted">Approve new registrations, suspend access and reset passwords. Approving a buyer allows sign-in only; confidential data-room access still needs an approved NDA.</p><div class="dx-toolbar"><div class="dx-tabs" id="buyer-tabs" role="tablist"><button type="button" class="dx-tab" role="tab" data-tab="invited" aria-selected="false">Pending approval<span class="dx-count">0</span></button><button type="button" class="dx-tab" role="tab" data-tab="active" aria-selected="false">Active<span class="dx-count">0</span></button><button type="button" class="dx-tab" role="tab" data-tab="suspended" aria-selected="false">Suspended<span class="dx-count">0</span></button><button type="button" class="dx-tab" role="tab" data-tab="all" aria-selected="false">All<span class="dx-count">0</span></button></div><input class="dx-search" id="buyer-search" type="search" placeholder="Search" aria-label="Search"><span class="dx-spacer"></span><button type="button" class="dx-btn dx-btn-primary" id="buyer-add">Add buyer</button></div><div id="buyers" class="dx-table-wrap">Loading…</div></main><script src="/static/js/dashboard-kit.js" defer></script><script src="/static/js/dashboard-buyers.js" defer></script></body></html>`,
  ),
);

admin.get('/buyers', requireRole('admin', 'super_admin'), async (c) => {
  return c.json({ data: await listBuyers(c.env.DB) });
});

admin.patch('/buyers/:id', requireRole('admin', 'super_admin'), async (c) => {
  const parsed = z
    .object({ status: z.enum(['active', 'invited', 'suspended']) })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'Choose a valid buyer status.' } },
      422,
    );
  const user = await findBuyer(c.env.DB, c.req.param('id'));
  if (!user) return c.json({ error: { code: 'NOT_FOUND', message: 'Buyer not found.' } }, 404);
  const timestamp = now();
  await setBuyerStatus(c.env.DB, {
    buyerId: user.id,
    from: user.status,
    to: parsed.data.status,
    auditId: id(),
    staffId: c.get('staff').id,
    requestId: c.get('requestId'),
    timestamp,
  });
  return c.json({ data: { id: user.id, status: parsed.data.status } });
});

admin.post('/buyers/:id/temporary-password', requireRole('admin', 'super_admin'), requireRecentMfa('/dashboard'), async (c) => {
  const body = z
    .object({ password: z.string().max(200).optional() })
    .safeParse(await c.req.json().catch(() => ({})));
  if (!body.success)
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid password.' } }, 422);
  const user = await findBuyerContact(c.env.DB, c.req.param('id'));
  if (!user) return c.json({ error: { code: 'NOT_FOUND', message: 'Buyer not found.' } }, 404);
  const result = await issueTemporaryPassword(c, user, 'buyer', body.data.password || undefined);
  if ('problem' in result)
    return c.json({ error: { code: 'WEAK_PASSWORD', message: result.problem } }, 422);
  c.header('Cache-Control', 'no-store');
  return c.json({
    data: { email: user.email, temporaryPassword: result.password, status: user.status },
  });
});

admin.post('/buyers/:id/reset-password', requireRole('admin', 'super_admin'), requireRecentMfa('/dashboard'), async (c) => {
  const user = await findActiveBuyerContact(c.env.DB, c.req.param('id'));
  if (!user)
    return c.json(
      { error: { code: 'NOT_FOUND', message: 'Active buyer account not found.' } },
      404,
    );
  const emailQueued = Boolean(await issueResetToken(c.env, user, 'reset', 'buyer'));
  await audit(c, 'buyer.password_reset_issued', 'user', user.id, { emailQueued });
  return c.json({ data: { emailQueued } });
});

admin.post('/buyers/provision', requireRole('admin', 'super_admin'), requireRecentMfa('/dashboard'), async (c) => {
  const parsed = z
    .object({
      email: z.string().trim().email().max(254),
      displayName: z.string().trim().min(2).max(120),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Provide a valid business email and full name.',
        },
      },
      422,
    );
  const email = parsed.data.email.toLowerCase();
  const existing = await findAccountByEmail(c.env.DB, email);
  const timestamp = now();
  if (existing && existing.userType !== 'buyer')
    return c.json(
      { error: { code: 'ACCOUNT_CONFLICT', message: 'That email belongs to a staff account.' } },
      409,
    );
  if (existing && existing.status === 'active')
    return c.json(
      { error: { code: 'ALREADY_ACTIVE', message: 'An active buyer account already exists.' } },
      409,
    );
  if (existing && existing.status !== 'invited')
    return c.json(
      {
        error: {
          code: 'ACCOUNT_STATUS_BLOCKED',
          message: 'Suspended or deleted accounts require a separate administrative review.',
        },
      },
      409,
    );
  const buyerId = existing?.id ?? id();
  const auditDetails = JSON.stringify({ email, reactivated: Boolean(existing) });
  if (existing) {
    const auditArgs = {
      buyerId,
      auditId: id(),
      staffId: c.get('staff').id,
      requestId: c.get('requestId'),
      timestamp,
      auditDetails,
    };
    const activated = await activateInvitedBuyer(c.env.DB, { ...auditArgs, displayName: parsed.data.displayName });
    if (!activated)
      return c.json(
        {
          error: {
            code: 'ACCOUNT_STATUS_CONFLICT',
            message:
              'The buyer account changed during provisioning. Refresh and review its status.',
          },
        },
        409,
      );
  } else {
    await createActiveBuyer(c.env.DB, {
      buyerId,
      email,
      displayName: parsed.data.displayName,
      auditId: id(),
      staffId: c.get('staff').id,
      requestId: c.get('requestId'),
      timestamp,
      auditDetails,
    });
  }
  const inviteQueued = Boolean(
    await issueResetToken(c.env, { id: buyerId, email }, 'invite', 'buyer'),
  );
  return c.json(
    {
      data: {
        id: buyerId,
        email,
        displayName: parsed.data.displayName,
        status: 'active',
        signIn: 'password',
        inviteQueued,
      },
    },
    201,
  );
});

export default admin;
