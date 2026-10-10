import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { hashPassword, needsRehash, passwordPolicyError, sha256Hex, verifyPassword } from '../../src/auth/password';

const headers = { origin: 'https://mayfair.test', 'content-type': 'application/json' };
const GOOD = 'Correct-horse-battery-7';
const post = (path: string, body: unknown, cookie?: string) =>
  SELF.fetch(`https://mayfair.test${path}`, { method: 'POST', headers: { ...headers, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
const cookieOf = (response: Response) => (response.headers.get('set-cookie') ?? '').split(';')[0]!;
const created: string[] = [];

async function makeUser(role: string, opts: { type?: 'staff' | 'buyer'; status?: string; password?: string; mustChange?: boolean } = {}) {
  const id = crypto.randomUUID();
  const email = `${role}-${id}@example.test`;
  const timestamp = new Date().toISOString();
  await env.DB.prepare('INSERT INTO users (id,email,display_name,user_type,role,status,password_hash,must_change_password,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .bind(id, email, `Test ${role}`, opts.type ?? 'staff', role, opts.status ?? 'active', await hashPassword(opts.password ?? GOOD), opts.mustChange ? 1 : 0, timestamp, timestamp)
    .run();
  created.push(id);
  return { id, email };
}
async function cleanup() {
  for (const id of created.splice(0)) {
    await env.DB.prepare('DELETE FROM audit_logs WHERE actor_user_id=? OR entity_id=?').bind(id, id).run();
    await env.DB.prepare('DELETE FROM users WHERE id=?').bind(id).run();
  }
}
async function login(path: string, email: string, password = GOOD) {
  return post(path, { email, password });
}

describe('password primitives', () => {
  it('hashes with a unique salt and verifies in constant-format', async () => {
    const a = await hashPassword(GOOD);
    const b = await hashPassword(GOOD);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^pbkdf2-sha256\$100000\$/);
    expect(await verifyPassword(GOOD, a)).toBe(true);
    expect(await verifyPassword('wrong-password-123', a)).toBe(false);
    expect(await verifyPassword(GOOD, null)).toBe(false);
    expect(await verifyPassword(GOOD, 'plaintext')).toBe(false);
  });
  it('flags hashes with a different cost for upgrade at next login', async () => {
    expect(needsRehash(await hashPassword(GOOD))).toBe(false);
    expect(needsRehash('pbkdf2-sha256$600000$c2FsdA==$aGFzaA==')).toBe(true);
    expect(needsRehash(null)).toBe(false);
  });
  it('enforces the password policy', () => {
    expect(passwordPolicyError('short1')).toMatch(/12/);
    expect(passwordPolicyError('onlyletterslongenough')).toMatch(/numbers/);
    expect(passwordPolicyError('alice-secret-99', 'alice@example.com')).toMatch(/email/);
    expect(passwordPolicyError(GOOD, 'x@example.com')).toBeNull();
  });
});

describe('staff email/password sign-in', () => {
  it('signs in, reaches the dashboard with the session cookie and signs out', async () => {
    const staff = await makeUser('admin');
    try {
      expect((await SELF.fetch('https://mayfair.test/dashboard/buyers')).status).toBe(401);
      const html = await SELF.fetch('https://mayfair.test/dashboard', { headers: { accept: 'text/html' }, redirect: 'manual' });
      expect(html.status).toBe(302);
      expect(html.headers.get('location')).toBe('/admin/login');

      const response = await login('/api/admin/auth/login', staff.email);
      expect(response.status).toBe(200);
      const setCookie = response.headers.get('set-cookie') ?? '';
      expect(setCookie).toMatch(/mayfair_staff_session=/);
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('Secure');
      const cookie = cookieOf(response);
      const dashboard = await SELF.fetch('https://mayfair.test/dashboard', { headers: { cookie, accept: 'text/html' } });
      expect(dashboard.status).toBe(200);
      expect(await dashboard.text()).toContain('Signed in as');

      expect((await post('/api/admin/auth/logout', {}, cookie)).status).toBe(200);
      expect((await SELF.fetch('https://mayfair.test/dashboard/buyers', { headers: { cookie } })).status).toBe(401);
    } finally {
      await cleanup();
    }
  });

  it('gives identical errors for unknown emails and wrong passwords, and locks after repeated failures', async () => {
    const staff = await makeUser('admin');
    try {
      const unknown = await login('/api/admin/auth/login', `nobody-${crypto.randomUUID()}@example.test`);
      const wrong = await login('/api/admin/auth/login', staff.email, 'Wrong-password-123');
      expect(unknown.status).toBe(401);
      expect(wrong.status).toBe(401);
      expect(await unknown.json()).toMatchObject({ error: { code: 'INVALID_CREDENTIALS' } });
      for (let i = 0; i < 4; i++) await login('/api/admin/auth/login', staff.email, 'Wrong-password-123');
      const locked = await login('/api/admin/auth/login', staff.email); // correct password, but locked
      expect(locked.status).toBe(401);
      expect(locked.headers.get('set-cookie')).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it('refuses suspended staff and users without a password hash', async () => {
    const suspended = await makeUser('editor', { status: 'suspended' });
    const noPassword = await makeUser('editor');
    await env.DB.prepare('UPDATE users SET password_hash = NULL WHERE id = ?').bind(noPassword.id).run();
    try {
      expect((await login('/api/admin/auth/login', suspended.email)).status).toBe(403);
      expect((await login('/api/admin/auth/login', noPassword.email)).status).toBe(401);
    } finally {
      await cleanup();
    }
  });

  it('does not let a buyer sign in through the staff form', async () => {
    const buyer = await makeUser('buyer', { type: 'buyer' });
    try {
      expect((await login('/api/admin/auth/login', buyer.email)).status).toBe(401);
    } finally {
      await cleanup();
    }
  });

  it('forces a password change when a temporary password is in use', async () => {
    const staff = await makeUser('admin', { mustChange: true });
    try {
      const response = await login('/api/admin/auth/login', staff.email);
      expect(await response.clone().json()).toMatchObject({ data: { mustChangePassword: true, redirectTo: '/admin/change-password' } });
      const cookie = cookieOf(response);
      const blocked = await SELF.fetch('https://mayfair.test/dashboard/buyers', { headers: { cookie } });
      expect(blocked.status).toBe(403);
      expect(await blocked.json()).toMatchObject({ error: { code: 'PASSWORD_CHANGE_REQUIRED' } });
      const change = await post('/api/admin/auth/change-password', { currentPassword: GOOD, newPassword: 'Brand-new-passphrase-9' }, cookie);
      expect(change.status).toBe(200);
      expect((await SELF.fetch('https://mayfair.test/dashboard/buyers', { headers: { cookie } })).status).toBe(200);
    } finally {
      await cleanup();
    }
  });
});

describe('change and reset password', () => {
  it('changes a password only with the correct current password and revokes other sessions', async () => {
    const staff = await makeUser('admin');
    try {
      const first = cookieOf(await login('/api/admin/auth/login', staff.email));
      const second = cookieOf(await login('/api/admin/auth/login', staff.email));
      expect((await post('/api/admin/auth/change-password', { currentPassword: 'Wrong-password-123', newPassword: 'Brand-new-passphrase-9' }, first)).status).toBe(403);
      expect((await post('/api/admin/auth/change-password', { currentPassword: GOOD, newPassword: 'weak' }, first)).status).toBe(422);
      expect((await post('/api/admin/auth/change-password', { currentPassword: GOOD, newPassword: 'Brand-new-passphrase-9' }, first)).status).toBe(200);
      expect((await SELF.fetch('https://mayfair.test/dashboard/buyers', { headers: { cookie: first } })).status).toBe(200);
      expect((await SELF.fetch('https://mayfair.test/dashboard/buyers', { headers: { cookie: second } })).status).toBe(401);
      expect((await login('/api/admin/auth/login', staff.email)).status).toBe(401);
      expect((await login('/api/admin/auth/login', staff.email, 'Brand-new-passphrase-9')).status).toBe(200);
    } finally {
      await cleanup();
    }
  });

  it('forgot-password never reveals whether an account exists', async () => {
    const buyer = await makeUser('buyer', { type: 'buyer' });
    try {
      const known = await post('/api/buyer/auth/forgot-password', { email: buyer.email });
      const unknown = await post('/api/buyer/auth/forgot-password', { email: `ghost-${crypto.randomUUID()}@example.test` });
      expect(known.status).toBe(202);
      expect(unknown.status).toBe(202);
      expect(await known.json()).toEqual(await unknown.json());
    } finally {
      await cleanup();
    }
  });

  it('resets a password with a single-use token, signs out sessions and rejects reuse', async () => {
    const buyer = await makeUser('buyer', { type: 'buyer' });
    try {
      const oldCookie = cookieOf(await login('/api/buyer/auth/login', buyer.email));
      expect((await SELF.fetch('https://mayfair.test/api/buyer/me', { headers: { cookie: oldCookie } })).status).toBe(200);
      const token = 'a'.repeat(64);
      await env.DB.prepare('INSERT INTO password_reset_tokens (id,user_id,token_hash,purpose,expires_at,created_at) VALUES (?,?,?,?,?,?)')
        .bind(crypto.randomUUID(), buyer.id, await sha256Hex(token), 'reset', new Date(Date.now() + 60_000).toISOString(), new Date().toISOString())
        .run();
      expect((await post('/api/buyer/auth/reset-password', { token, password: 'weak' })).status).toBe(422);
      expect((await post('/api/buyer/auth/reset-password', { token, password: 'Fresh-passphrase-2026' })).status).toBe(200);
      expect((await post('/api/buyer/auth/reset-password', { token, password: 'Another-passphrase-2026' })).status).toBe(400);
      expect((await SELF.fetch('https://mayfair.test/api/buyer/me', { headers: { cookie: oldCookie } })).status).toBe(401);
      expect((await login('/api/buyer/auth/login', buyer.email, 'Fresh-passphrase-2026')).status).toBe(200);
    } finally {
      await cleanup();
    }
  });

  it('rejects expired reset tokens and tokens used on the wrong portal', async () => {
    const buyer = await makeUser('buyer', { type: 'buyer' });
    try {
      const expired = 'b'.repeat(64);
      const live = 'c'.repeat(64);
      for (const [token, expiresAt] of [[expired, new Date(Date.now() - 1000).toISOString()], [live, new Date(Date.now() + 60_000).toISOString()]] as const)
        await env.DB.prepare('INSERT INTO password_reset_tokens (id,user_id,token_hash,purpose,expires_at,created_at) VALUES (?,?,?,?,?,?)').bind(crypto.randomUUID(), buyer.id, await sha256Hex(token), 'reset', expiresAt, new Date().toISOString()).run();
      expect((await post('/api/buyer/auth/reset-password', { token: expired, password: 'Fresh-passphrase-2026' })).status).toBe(400);
      expect((await post('/api/admin/auth/reset-password', { token: live, password: 'Fresh-passphrase-2026' })).status).toBe(400);
    } finally {
      await cleanup();
    }
  });
});

describe('super administrator staff management', () => {
  it('lets only super admins create staff, who must then change their temporary password', async () => {
    const superAdmin = await makeUser('super_admin');
    const admin = await makeUser('admin');
    const newEmail = `new-staff-${crypto.randomUUID()}@example.test`;
    try {
      const superCookie = cookieOf(await login('/api/admin/auth/login', superAdmin.email));
      const adminCookie = cookieOf(await login('/api/admin/auth/login', admin.email));
      const body = { email: newEmail, displayName: 'New Broker', role: 'broker', temporaryPassword: 'Temporary-passphrase-1' };
      expect((await post('/dashboard/staff', body, adminCookie)).status).toBe(403);
      const createdResponse = await post('/dashboard/staff', body, superCookie);
      expect(createdResponse.status).toBe(201);
      const { data } = (await createdResponse.json()) as { data: { id: string } };
      created.push(data.id);
      expect((await post('/dashboard/staff', body, superCookie)).status).toBe(409);
      const first = await login('/api/admin/auth/login', newEmail, 'Temporary-passphrase-1');
      expect(await first.json()).toMatchObject({ data: { mustChangePassword: true } });

      // Super admins cannot demote or suspend themselves.
      const self = await SELF.fetch(`https://mayfair.test/dashboard/staff/${superAdmin.id}`, { method: 'PATCH', headers: { ...headers, cookie: superCookie }, body: JSON.stringify({ status: 'suspended' }) });
      expect(self.status).toBe(409);
      // Suspending another account revokes its sessions immediately.
      const adminList = await SELF.fetch('https://mayfair.test/dashboard/buyers', { headers: { cookie: adminCookie } });
      expect(adminList.status).toBe(200);
      const suspend = await SELF.fetch(`https://mayfair.test/dashboard/staff/${admin.id}`, { method: 'PATCH', headers: { ...headers, cookie: superCookie }, body: JSON.stringify({ status: 'suspended' }) });
      expect(suspend.status).toBe(200);
      expect((await SELF.fetch('https://mayfair.test/dashboard/buyers', { headers: { cookie: adminCookie } })).status).toBe(401);
    } finally {
      await cleanup();
    }
  });
});
