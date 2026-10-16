import { requireRole } from '../../auth/staff-session';
import { z } from 'zod';
import { issueResetToken } from '../../auth/password';
import { Hono } from 'hono';
import { type AdminApp, audit, id, issueTemporaryPassword, now } from '../shared';

const admin = new Hono<AdminApp>();

admin.get('/buyers/ui', requireRole('admin', 'super_admin'), async (c) =>
  c.html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Buyer access · Casinos of Mayfair</title><link rel="stylesheet" href="/static/css/site.css"><link rel="stylesheet" href="/static/css/dashboard.css"></head><body><main class="admin"><p class="eyebrow">STAFF WORKSPACE</p><h1>Buyer access</h1><nav class="admin-nav"><a href="/dashboard">Overview</a><a href="/dashboard/opportunities/ui">Opportunity CMS</a><a href="/dashboard/nda-requests/ui">NDA requests</a><a href="/dashboard/access-grants/ui">Access grants</a><a href="/admin/logout">Sign out</a></nav><p class="muted">Approve new registrations, suspend access and reset passwords. Approving a buyer allows sign-in only; confidential data-room access still needs an approved NDA.</p><div class="dx-toolbar"><div class="dx-tabs" id="buyer-tabs" role="tablist"><button type="button" class="dx-tab" role="tab" data-tab="invited" aria-selected="false">Pending approval<span class="dx-count">0</span></button><button type="button" class="dx-tab" role="tab" data-tab="active" aria-selected="false">Active<span class="dx-count">0</span></button><button type="button" class="dx-tab" role="tab" data-tab="suspended" aria-selected="false">Suspended<span class="dx-count">0</span></button><button type="button" class="dx-tab" role="tab" data-tab="all" aria-selected="false">All<span class="dx-count">0</span></button></div><input class="dx-search" id="buyer-search" type="search" placeholder="Search" aria-label="Search"><span class="dx-spacer"></span><button type="button" class="dx-btn dx-btn-primary" id="buyer-add">Add buyer</button></div><div id="buyers" class="dx-table-wrap">Loading…</div></main><script src="/static/js/dashboard-kit.js" defer></script><script src="/static/js/dashboard-buyers.js" defer></script></body></html>`,
  ),
);

admin.get('/buyers', requireRole('admin', 'super_admin'), async (c) => {
  const result = await c.env.DB.prepare(
    "SELECT u.id, u.email, u.display_name AS displayName, u.status, u.created_at AS createdAt, p.company_name AS companyName, p.role_title AS roleTitle, u.must_change_password AS mustChange, CASE WHEN u.password_hash IS NULL THEN 0 ELSE 1 END AS hasPassword FROM users u LEFT JOIN buyer_profiles p ON p.user_id = u.id WHERE u.user_type = 'buyer' ORDER BY CASE u.status WHEN 'invited' THEN 0 WHEN 'active' THEN 1 ELSE 2 END, u.created_at DESC LIMIT 300",
  ).all();
  return c.json({ data: result.results ?? [] });
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
  const user = await c.env.DB.prepare(
    "SELECT id, status FROM users WHERE id = ? AND user_type = 'buyer'",
  )
    .bind(c.req.param('id'))
    .first<{ id: string; status: string }>();
  if (!user) return c.json({ error: { code: 'NOT_FOUND', message: 'Buyer not found.' } }, 404);
  const timestamp = now();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE users SET status = ?, updated_at = ? WHERE id = ? AND user_type = 'buyer'",
    ).bind(parsed.data.status, timestamp, user.id),
    c.env.DB.prepare(
      "UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND ? != 'active'",
    ).bind(timestamp, user.id, parsed.data.status),
    c.env.DB.prepare(
      "INSERT INTO audit_logs (id, actor_user_id, actor_type, action, entity_type, entity_id, request_id, details_json, created_at) VALUES (?, ?, 'staff', 'buyer.status_changed', 'user', ?, ?, ?, ?)",
    ).bind(
      id(),
      c.get('staff').id,
      user.id,
      c.get('requestId'),
      JSON.stringify({ from: user.status, to: parsed.data.status }),
      timestamp,
    ),
  ]);
  return c.json({ data: { id: user.id, status: parsed.data.status } });
});

admin.post('/buyers/:id/temporary-password', requireRole('admin', 'super_admin'), async (c) => {
  const body = z
    .object({ password: z.string().max(200).optional() })
    .safeParse(await c.req.json().catch(() => ({})));
  if (!body.success)
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid password.' } }, 422);
  const user = await c.env.DB.prepare(
    "SELECT id, email, status FROM users WHERE id = ? AND user_type = 'buyer'",
  )
    .bind(c.req.param('id'))
    .first<{ id: string; email: string; status: string }>();
  if (!user) return c.json({ error: { code: 'NOT_FOUND', message: 'Buyer not found.' } }, 404);
  const result = await issueTemporaryPassword(c, user, 'buyer', body.data.password || undefined);
  if ('problem' in result)
    return c.json({ error: { code: 'WEAK_PASSWORD', message: result.problem } }, 422);
  c.header('Cache-Control', 'no-store');
  return c.json({
    data: { email: user.email, temporaryPassword: result.password, status: user.status },
  });
});

admin.post('/buyers/:id/reset-password', requireRole('admin', 'super_admin'), async (c) => {
  const user = await c.env.DB.prepare(
    "SELECT id, email FROM users WHERE id = ? AND user_type = 'buyer' AND status = 'active'",
  )
    .bind(c.req.param('id'))
    .first<{ id: string; email: string }>();
  if (!user)
    return c.json(
      { error: { code: 'NOT_FOUND', message: 'Active buyer account not found.' } },
      404,
    );
  const emailQueued = Boolean(await issueResetToken(c.env, user, 'reset', 'buyer'));
  await audit(c, 'buyer.password_reset_issued', 'user', user.id, { emailQueued });
  return c.json({ data: { emailQueued } });
});

admin.post('/buyers/provision', requireRole('admin', 'super_admin'), async (c) => {
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
  const existing = await c.env.DB.prepare(
    'SELECT id, user_type AS userType, status FROM users WHERE email = ? COLLATE NOCASE',
  )
    .bind(email)
    .first<{ id: string; userType: string; status: string }>();
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
    await c.env.DB.batch([
      c.env.DB.prepare(
        "UPDATE users SET display_name = ?, status = 'active', updated_at = ? WHERE id = ? AND user_type = 'buyer' AND status = 'invited'",
      ).bind(parsed.data.displayName, timestamp, buyerId),
      c.env.DB.prepare(
        "INSERT INTO audit_logs (id, actor_user_id, actor_type, action, entity_type, entity_id, request_id, details_json, created_at) SELECT ?, ?, 'staff', 'buyer.provisioned', 'user', ?, ?, ?, ? WHERE changes() > 0",
      ).bind(id(), c.get('staff').id, buyerId, c.get('requestId'), auditDetails, timestamp),
    ]);
    const activated = await c.env.DB.prepare(
      "SELECT id FROM users WHERE id = ? AND status = 'active' AND user_type = 'buyer'",
    )
      .bind(buyerId)
      .first();
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
    await c.env.DB.batch([
      c.env.DB.prepare(
        "INSERT INTO users (id, email, display_name, user_type, role, status, created_at, updated_at) VALUES (?, ?, ?, 'buyer', 'buyer', 'active', ?, ?)",
      ).bind(buyerId, email, parsed.data.displayName, timestamp, timestamp),
      c.env.DB.prepare(
        "INSERT INTO audit_logs (id, actor_user_id, actor_type, action, entity_type, entity_id, request_id, details_json, created_at) VALUES (?, ?, 'staff', 'buyer.provisioned', 'user', ?, ?, ?, ?)",
      ).bind(id(), c.get('staff').id, buyerId, c.get('requestId'), auditDetails, timestamp),
    ]);
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
