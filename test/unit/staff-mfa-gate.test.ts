import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { markSessionVerified } from '../../src/auth/mfa-repo';
import { sha256Hex } from '../../src/auth/password';
import { staffAuth, STAFF_COOKIE } from '../../src/auth/staff-session';
import type { StaffIdentity } from '../../src/auth/staff-session';
import type { Env } from '../../src/env';

// Exercises the real staffAuth() middleware against the real database with MFA configured.
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => (i * 5 + 1) % 256)));
const withKey = { ...env, OTP_ENCRYPTION_KEY: KEY };
const withoutKey = { ...env, OTP_ENCRYPTION_KEY: undefined };

const app = new Hono<{
  Bindings: Env;
  Variables: { requestId: string; staff: StaffIdentity };
}>();
app.use('*', staffAuth());
app.get('/dashboard/ping', (c) => c.json({ ok: true }));

const created: string[] = [];
async function staffSession(role: string, opts: { enrolled?: boolean; verified?: boolean } = {}) {
  const id = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const token = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll('-', '');
  const at = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO users (id,email,display_name,user_type,role,status,password_hash,must_change_password,created_at,updated_at) VALUES (?,?,?,'staff',?,'active','x',0,?,?)",
  )
    .bind(id, `${role}-${id}@example.test`, `Test ${role}`, role, at, at)
    .run();
  await env.DB.prepare(
    "INSERT INTO sessions (id,user_id,token_hash,created_at,last_seen_at,expires_at,session_type) VALUES (?,?,?,?,?,?,'staff')",
  )
    .bind(sessionId, id, await sha256Hex(token), at, at, new Date(Date.now() + 3_600_000).toISOString())
    .run();
  if (opts.enrolled)
    await env.DB.prepare(
      "INSERT INTO staff_mfa (user_id,secret_enc,enabled_at,recovery_hashes,created_at,updated_at) VALUES (?, 'v1.x.y', ?, '[]', ?, ?)",
    )
      .bind(id, at, at, at)
      .run();
  if (opts.verified) await markSessionVerified({ DB: env.DB }, sessionId, at);
  created.push(id);
  return { cookie: `${STAFF_COOKIE}=${token}`, sessionId };
}
afterEach(async () => {
  for (const id of created.splice(0)) {
    await env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(id).run();
    await env.DB.prepare('DELETE FROM staff_mfa WHERE user_id=?').bind(id).run();
    await env.DB.prepare('DELETE FROM users WHERE id=?').bind(id).run();
  }
});

const call = (cookie: string, bindings: object, accept = 'application/json') =>
  app.request('/dashboard/ping', { headers: { cookie, accept } }, bindings);

describe('staffAuth MFA gate', () => {
  it('blocks an admin session that has not passed MFA (API: 403, browser: redirect)', async () => {
    const { cookie } = await staffSession('admin');
    const api = await call(cookie, withKey);
    expect(api.status).toBe(403);
    expect(((await api.json()) as { error: { code: string } }).error.code).toBe('MFA_REQUIRED');
    const page = await call(cookie, withKey, 'text/html');
    expect(page.status).toBe(302);
    expect(page.headers.get('location')).toBe('/admin/mfa');
  });

  it('lets the same session through once MFA is verified', async () => {
    const { cookie } = await staffSession('super_admin', { enrolled: true, verified: true });
    expect((await call(cookie, withKey)).status).toBe(200);
  });

  it('does not require MFA for other roles until they enrol', async () => {
    const { cookie } = await staffSession('editor');
    expect((await call(cookie, withKey)).status).toBe(200);
  });

  it('requires MFA for any enrolled user, whatever the role', async () => {
    const { cookie } = await staffSession('editor', { enrolled: true });
    expect((await call(cookie, withKey)).status).toBe(403);
  });

  it('does not lock administrators out when no encryption key is configured', async () => {
    const { cookie } = await staffSession('admin');
    expect((await call(cookie, withoutKey)).status).toBe(200);
  });
});
