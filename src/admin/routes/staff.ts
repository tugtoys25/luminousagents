import { requireRole } from '../../auth/staff-session';
import { requireRecentMfa } from '../../auth/step-up';
import { z } from 'zod';
import { hashPassword, issueResetToken, passwordPolicyError } from '../../auth/password';
import { Hono } from 'hono';
import { emailInUse, findActiveStaffContact, findStaff, findStaffContact, insertStaff, listStaff, updateStaffAndRevoke } from '../repos/staff-repo';
import { type AdminApp, audit, id, issueTemporaryPassword, now } from '../shared';

const admin = new Hono<AdminApp>();

/* ---------------------------------------------------------------- staff accounts (super administrators only) */
const staffRoles = ['super_admin', 'admin', 'editor', 'broker', 'publisher', 'auditor', 'compliance'] as const;

admin.get('/staff/ui', requireRole('super_admin'), async (c) =>
  c.html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Staff accounts · Luminous Agents</title><link rel="stylesheet" href="/static/css/site.css"><link rel="stylesheet" href="/static/css/dashboard.css"></head><body><main class="admin"><p class="eyebrow">STAFF WORKSPACE</p><h1>Staff accounts</h1><nav class="admin-nav"><a href="/dashboard">Overview</a><a href="/dashboard/buyers/ui">Buyer access</a><a href="/dashboard/sessions/ui">Staff sessions</a><a href="/dashboard/audit/ui">Audit log</a></nav><p class="muted">Only super administrators can create staff, edit names and emails, change roles, set temporary passwords or suspend access. A temporary password forces the person to choose a new one at first sign-in.</p><div class="dx-toolbar"><div class="dx-tabs" id="staff-tabs" role="tablist"><button type="button" class="dx-tab" role="tab" data-tab="all" aria-selected="false">All<span class="dx-count">0</span></button><button type="button" class="dx-tab" role="tab" data-tab="active" aria-selected="false">Active<span class="dx-count">0</span></button><button type="button" class="dx-tab" role="tab" data-tab="suspended" aria-selected="false">Suspended<span class="dx-count">0</span></button></div><input class="dx-search" id="staff-search" type="search" placeholder="Search" aria-label="Search"><span class="dx-spacer"></span><button type="button" class="dx-btn dx-btn-primary" id="staff-add">Add staff</button></div><div id="staff-list" class="dx-table-wrap">Loading…</div></main><script src="/static/js/dashboard-kit.js" defer></script><script src="/static/js/dashboard-staff.js" defer></script></body></html>`,
  ),
);

admin.get('/staff', requireRole('super_admin'), async (c) => {
  const rows = await listStaff(c.env.DB);
  return c.json({
    data: rows.map((r) => ({
      ...r,
      hasPassword: r['hasPassword'] === 1,
      mustChange: r['mustChange'] === 1,
      isSelf: r['id'] === c.get('staff').id,
    })),
  });
});

admin.post('/staff', requireRole('super_admin'), requireRecentMfa('/staff/ui'), async (c) => {
  const parsed = z
    .object({
      email: z.string().trim().email().max(254),
      displayName: z.string().trim().min(2).max(120),
      role: z.enum(staffRoles),
      temporaryPassword: z.string().max(200).optional(),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'Provide a name, valid email and role.' } },
      422,
    );
  const email = parsed.data.email.toLowerCase();
  if (parsed.data.temporaryPassword) {
    const problem = passwordPolicyError(parsed.data.temporaryPassword, email);
    if (problem) return c.json({ error: { code: 'WEAK_PASSWORD', message: problem } }, 422);
  }
  const existing = await emailInUse(c.env.DB, email);
  if (existing)
    return c.json(
      {
        error: { code: 'ACCOUNT_CONFLICT', message: 'An account with that email already exists.' },
      },
      409,
    );
  const timestamp = now();
  const userId = id();
  const hash = parsed.data.temporaryPassword
    ? await hashPassword(parsed.data.temporaryPassword)
    : null;
  await insertStaff(c.env.DB, {
    id: userId,
    email,
    displayName: parsed.data.displayName,
    role: parsed.data.role,
    passwordHash: hash,
    timestamp,
  });
  await audit(c, 'staff.created', 'user', userId, {
    role: parsed.data.role,
    method: hash ? 'temporary_password' : 'invite',
  });
  const invited = hash
    ? false
    : Boolean(await issueResetToken(c.env, { id: userId, email }, 'invite', 'staff'));
  return c.json({ data: { id: userId, email, role: parsed.data.role, invited } }, 201);
});

admin.patch('/staff/:id', requireRole('super_admin'), requireRecentMfa('/staff/ui'), async (c) => {
  const parsed = z
    .object({
      role: z.enum(staffRoles).optional(),
      status: z.enum(['active', 'suspended']).optional(),
      displayName: z.string().trim().min(2).max(120).optional(),
      email: z.string().trim().email().max(254).optional(),
    })
    .refine((v) => v.role || v.status || v.displayName || v.email)
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'Check the name, email, role and status.' } },
      422,
    );
  const target = c.req.param('id');
  const isSelf = target === c.get('staff').id;
  if (isSelf && (parsed.data.role || parsed.data.status || parsed.data.email))
    return c.json(
      {
        error: {
          code: 'SELF_CHANGE_BLOCKED',
          message:
            'You can only change your own name here. Ask another super administrator for role, status or email changes.',
        },
      },
      409,
    );
  const user = await findStaff(c.env.DB, target);
  if (!user)
    return c.json({ error: { code: 'NOT_FOUND', message: 'Staff account not found.' } }, 404);
  const role = parsed.data.role ?? user.role;
  const status = parsed.data.status ?? user.status;
  const displayName = parsed.data.displayName ?? user.displayName;
  const email = (parsed.data.email ?? user.email).toLowerCase();
  if (email !== user.email.toLowerCase()) {
    const taken = await emailInUse(c.env.DB, email, user.id);
    if (taken)
      return c.json(
        {
          error: { code: 'ACCOUNT_CONFLICT', message: 'Another account already uses that email.' },
        },
        409,
      );
  }
  const timestamp = now();
  const securityChange =
    status !== user.status || role !== user.role || email !== user.email.toLowerCase();
  await updateStaffAndRevoke(c.env.DB, { id: user.id, role, status, displayName, email, securityChange, timestamp });
  await audit(c, 'staff.updated', 'user', user.id, {
    from: {
      role: user.role,
      status: user.status,
      email: user.email,
      displayName: user.displayName,
    },
    to: { role, status, email, displayName },
  });
  return c.json({ data: { id: user.id, role, status, displayName, email } });
});

admin.post('/staff/:id/temporary-password', requireRole('super_admin'), requireRecentMfa('/staff/ui'), async (c) => {
  const body = z
    .object({ password: z.string().max(200).optional() })
    .safeParse(await c.req.json().catch(() => ({})));
  if (!body.success)
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid password.' } }, 422);
  if (c.req.param('id') === c.get('staff').id)
    return c.json(
      {
        error: {
          code: 'SELF_CHANGE_BLOCKED',
          message: 'Use Change password to update your own password.',
        },
      },
      409,
    );
  const user = await findStaffContact(c.env.DB, c.req.param('id'));
  if (!user)
    return c.json({ error: { code: 'NOT_FOUND', message: 'Staff account not found.' } }, 404);
  const result = await issueTemporaryPassword(c, user, 'staff', body.data.password || undefined);
  if ('problem' in result)
    return c.json({ error: { code: 'WEAK_PASSWORD', message: result.problem } }, 422);
  c.header('Cache-Control', 'no-store');
  return c.json({ data: { email: user.email, temporaryPassword: result.password } });
});

admin.post('/staff/:id/reset-password', requireRole('super_admin'), requireRecentMfa('/staff/ui'), async (c) => {
  const user = await findActiveStaffContact(c.env.DB, c.req.param('id'));
  if (!user)
    return c.json(
      { error: { code: 'NOT_FOUND', message: 'Active staff account not found.' } },
      404,
    );
  const emailQueued = Boolean(await issueResetToken(c.env, user, 'reset', 'staff'));
  await audit(c, 'staff.password_reset_issued', 'user', user.id, { emailQueued });
  return c.json({ data: { emailQueued } });
});

export default admin;
