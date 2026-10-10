import type { Context, MiddlewareHandler } from 'hono';
import type { Env } from '../env';
import { readCookie, sha256Hex } from './password';

export interface StaffIdentity {
  id: string;
  email: string;
  displayName: string;
  role: string;
}
type StaffApp = { Bindings: Env; Variables: { requestId: string; staff: StaffIdentity } };

export const STAFF_COOKIE = 'mayfair_staff_session';
export const STAFF_SESSION_SECONDS = 8 * 60 * 60;

const wantsHtml = (c: Context) =>
  c.req.method === 'GET' && (c.req.header('accept') ?? '').includes('text/html');
const fail = (c: Context<StaffApp>, status: 401 | 403, code: string, message: string) =>
  c.json({ error: { code, message }, requestId: c.get('requestId') }, status);

/** Resolves the signed-in staff user from the session cookie. Returns a Response when access must be refused. */
export async function authenticateStaff(c: Context<StaffApp>): Promise<(StaffIdentity & { mustChangePassword: boolean }) | Response> {
  const token = readCookie(c.req.header('cookie'), STAFF_COOKIE);
  if (!token) return wantsHtml(c) ? c.redirect('/admin/login', 302) : fail(c, 401, 'UNAUTHENTICATED', 'Staff sign-in required.');
  const row = await c.env.DB.prepare(
    "SELECT u.id, u.email, u.display_name AS displayName, u.role, u.must_change_password AS mustChange, s.id AS sessionId FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.session_type = 'staff' AND s.revoked_at IS NULL AND s.expires_at > ? AND u.user_type = 'staff' AND u.status = 'active' LIMIT 1",
  )
    .bind(await sha256Hex(token), new Date().toISOString())
    .first<StaffIdentity & { mustChange: number; sessionId: string }>();
  if (!row) return wantsHtml(c) ? c.redirect('/admin/login', 302) : fail(c, 401, 'UNAUTHENTICATED', 'Your session is invalid or has expired. Sign in again.');
  await c.env.DB.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').bind(new Date().toISOString(), row.sessionId).run();
  return { id: row.id, email: row.email, displayName: row.displayName, role: row.role, mustChangePassword: row.mustChange === 1 };
}

export function staffAuth(): MiddlewareHandler<StaffApp> {
  return async (c, next) => {
    const identity = await authenticateStaff(c);
    if (identity instanceof Response) return identity;
    if (identity.mustChangePassword)
      return wantsHtml(c) ? c.redirect('/admin/change-password', 302) : fail(c, 403, 'PASSWORD_CHANGE_REQUIRED', 'Change your temporary password before continuing.');
    const { mustChangePassword: _m, ...staff } = identity;
    c.set('staff', staff);
    await next();
  };
}

export function requireRole(...roles: string[]): MiddlewareHandler<StaffApp> {
  return async (c, next) => {
    if (!roles.includes(c.get('staff').role))
      return c.json({ error: { code: 'FORBIDDEN', message: 'Your role cannot perform this action.' }, requestId: c.get('requestId') }, 403);
    await next();
  };
}
