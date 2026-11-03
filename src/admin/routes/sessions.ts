import { requireRole, STAFF_COOKIE } from '../../auth/staff-session';
import { readCookie, sha256Hex } from '../../auth/password';
import { Hono } from 'hono';
import { findActiveBuyerSession, findActiveStaffSession, listActiveBuyerSessions, listActiveStaffSessions, revokeBuyerSession, revokeStaffSession } from '../repos/sessions-repo';
import { type AdminApp, audit, now } from '../shared';

const admin = new Hono<AdminApp>();

/* ---------------------------------------------------------------- staff session security (super administrators only) */
admin.get('/sessions/ui', requireRole('super_admin'), async (c) =>
  c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Staff sessions · Luminous Agents</title><link rel="stylesheet" href="/static/css/site.css"><link rel="stylesheet" href="/static/css/dashboard.css"></head><body><main class="admin"><p class="eyebrow">SECURITY OPERATIONS</p><h1>Staff sessions</h1><nav class="admin-nav"><a href="/dashboard">Overview</a><a href="/dashboard/staff/ui">Staff accounts</a><a href="/dashboard/sessions/ui">Staff sessions</a><a href="/dashboard/buyer-sessions/ui">Buyer sessions</a><a href="/dashboard/audit/ui">Audit log</a><a href="/admin/change-password">Change password</a><a href="/admin/logout">Sign out</a></nav><p class="muted">Review active staff sign-ins and revoke sessions that should no longer have access. Session tokens and cookie values are never displayed. Your current session cannot be revoked here.</p><p id="session-status" role="status" aria-live="polite">Loading sessions…</p><div class="overflow-x-auto"><table><thead><tr><th>Staff member</th><th>Role</th><th>Created (UTC)</th><th>Last activity (UTC)</th><th>Expires (UTC)</th><th>Status</th><th>Action</th></tr></thead><tbody id="session-rows"><tr><td colspan="7">Loading…</td></tr></tbody></table></div></main><script src="/static/js/dashboard-sessions.js" defer></script></body></html>`),
);

admin.get('/sessions', requireRole('super_admin'), async (c) => {
  const token = readCookie(c.req.header('cookie'), STAFF_COOKIE);
  const currentHash = token ? await sha256Hex(token) : '';
  const rows = await listActiveStaffSessions(c.env.DB, currentHash, now());
  c.header('Cache-Control', 'private, no-store');
  return c.json({ data: rows.map((row) => ({
    id: row['id'], userId: row['userId'], email: row['email'], displayName: row['displayName'], role: row['role'],
    createdAt: row['createdAt'], lastSeenAt: row['lastSeenAt'], expiresAt: row['expiresAt'], isCurrent: row['isCurrent'] === 1,
  })) });
});

admin.post('/sessions/:id/revoke', requireRole('super_admin'), async (c) => {
  const sessionId = c.req.param('id');
  if (!/^[0-9a-f-]{36}$/i.test(sessionId))
    return c.json({ error: { code: 'INVALID_SESSION_ID', message: 'Invalid session ID.' } }, 422);
  const token = readCookie(c.req.header('cookie'), STAFF_COOKIE);
  const currentHash = token ? await sha256Hex(token) : '';
  const session = await findActiveStaffSession(c.env.DB, sessionId);
  if (!session)
    return c.json({ error: { code: 'SESSION_NOT_FOUND', message: 'Active staff session not found.' } }, 404);
  if (session.tokenHash === currentHash)
    return c.json({ error: { code: 'CURRENT_SESSION_PROTECTED', message: 'Your current session cannot be revoked from this page. Sign out normally instead.' } }, 409);
  const timestamp = now();
  if (!(await revokeStaffSession(c.env.DB, session.id, timestamp)))
    return c.json({ error: { code: 'SESSION_ALREADY_REVOKED', message: 'This session is no longer active.' } }, 409);
  await audit(c, 'staff.session_revoked', 'session', session.id, { targetUserId: session.userId, targetEmail: session.email });
  c.header('Cache-Control', 'private, no-store');
  return c.json({ data: { id: session.id, revoked: true } });
});

/* ---------------------------------------------------------------- buyer session security (super administrators only) */
admin.get('/buyer-sessions/ui', requireRole('super_admin'), async (c) =>
  c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Buyer sessions · Luminous Agents</title><link rel="stylesheet" href="/static/css/site.css"><link rel="stylesheet" href="/static/css/dashboard.css"></head><body><main class="admin"><p class="eyebrow">SECURITY OPERATIONS</p><h1>Buyer sessions</h1><nav class="admin-nav"><a href="/dashboard">Overview</a><a href="/dashboard/buyers/ui">Buyer access</a><a href="/dashboard/sessions/ui">Staff sessions</a><a href="/dashboard/audit/ui">Audit log</a><a href="/admin/logout">Sign out</a></nav><p class="muted">Review active buyer sign-ins and revoke sessions when a buyer reports a lost device or suspicious activity. This page never displays session tokens. Revocation ends the selected session; it does not suspend the buyer account or change data-room grants.</p><p id="buyer-session-status" role="status" aria-live="polite">Loading sessions…</p><div class="overflow-x-auto"><table><thead><tr><th>Buyer</th><th>Account status</th><th>Created (UTC)</th><th>Last activity (UTC)</th><th>Expires (UTC)</th><th>Action</th></tr></thead><tbody id="buyer-session-rows"><tr><td colspan="6">Loading…</td></tr></tbody></table></div></main><script src="/static/js/dashboard-buyer-sessions.js" defer></script></body></html>`),
);

admin.get('/buyer-sessions', requireRole('super_admin'), async (c) => {
  const rows = await listActiveBuyerSessions(c.env.DB, now());
  c.header('Cache-Control', 'private, no-store');
  return c.json({ data: rows.map((row) => ({
    id: row['id'], userId: row['userId'], email: row['email'], displayName: row['displayName'],
    accountStatus: row['accountStatus'], createdAt: row['createdAt'], lastSeenAt: row['lastSeenAt'], expiresAt: row['expiresAt'],
  })) });
});

admin.post('/buyer-sessions/:id/revoke', requireRole('super_admin'), async (c) => {
  const sessionId = c.req.param('id');
  if (!/^[0-9a-f-]{36}$/i.test(sessionId))
    return c.json({ error: { code: 'INVALID_SESSION_ID', message: 'Invalid session ID.' } }, 422);
  const session = await findActiveBuyerSession(c.env.DB, sessionId);
  if (!session)
    return c.json({ error: { code: 'SESSION_NOT_FOUND', message: 'Active buyer session not found.' } }, 404);
  const timestamp = now();
  if (!(await revokeBuyerSession(c.env.DB, session.id, timestamp)))
    return c.json({ error: { code: 'SESSION_ALREADY_REVOKED', message: 'This session is no longer active.' } }, 409);
  await audit(c, 'buyer.session_revoked', 'session', session.id, { targetUserId: session.userId, targetEmail: session.email });
  c.header('Cache-Control', 'private, no-store');
  return c.json({ data: { id: session.id, revoked: true } });
});

export default admin;
