import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const headers = { origin: 'https://mayfair.test', 'content-type': 'application/json' };

describe('portal registration and bootstrap', () => {
  it('serves email/password staff login and one-time setup pages', async () => {
    const login = await SELF.fetch('https://mayfair.test/admin/login');
    expect(login.status).toBe(200);
    const html = await login.text();
    expect(html).toContain('type="password"');
    expect(html).toContain('/api/admin/auth/login');
    expect(html).not.toContain('Cloudflare Access');

    const setup = await SELF.fetch('https://mayfair.test/admin/setup');
    expect([200, 410, 503]).toContain(setup.status);
  });

  it('keeps first-admin bootstrap disabled without the server-side token', async () => {
    const response = await SELF.fetch('https://mayfair.test/api/admin/bootstrap', {
      method: 'POST',
      headers,
      body: JSON.stringify({ displayName: 'First Admin', email: 'first-admin@example.test', password: 'Sturdy-passphrase-42', token: 'x'.repeat(40) }),
    });
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('BOOTSTRAP_DISABLED');
  });

  it('registers new buyers as invited with a hashed password, never automatically active', async () => {
    const email = `buyer-${crypto.randomUUID()}@example.test`;
    const response = await SELF.fetch('https://mayfair.test/api/buyer/register', {
      method: 'POST',
      headers,
      body: JSON.stringify({ displayName: 'Test Buyer', email, password: 'Sturdy-passphrase-42', companyName: 'Example Capital', roleTitle: 'Principal', investmentFocus: 'casino-hotel', consent: true }),
    });
    expect(response.status).toBe(202);
    const user = await env.DB.prepare('SELECT id,status,user_type,password_hash AS hash FROM users WHERE email=? COLLATE NOCASE').bind(email).first<{ id: string; status: string; user_type: string; hash: string }>();
    expect(user).toMatchObject({ status: 'invited', user_type: 'buyer' });
    expect(user?.hash).toMatch(/^pbkdf2-sha256\$100000\$/);
    expect(user?.hash).not.toContain('Sturdy');

    // Correct credentials still cannot sign in until the team approves the account.
    const login = await SELF.fetch('https://mayfair.test/api/buyer/auth/login', { method: 'POST', headers, body: JSON.stringify({ email, password: 'Sturdy-passphrase-42' }) });
    expect(login.status).toBe(403);
    expect(login.headers.get('set-cookie')).toBeNull();
    if (user) {
      await env.DB.prepare('DELETE FROM notification_jobs WHERE payload_json LIKE ?').bind(`%${user.id}%`).run();
      await env.DB.prepare('DELETE FROM users WHERE id=?').bind(user.id).run();
    }
  });

  it('rejects weak registration passwords', async () => {
    const response = await SELF.fetch('https://mayfair.test/api/buyer/register', {
      method: 'POST',
      headers,
      body: JSON.stringify({ displayName: 'Weak Pw', email: `weak-${crypto.randomUUID()}@example.test`, password: 'short1', consent: true }),
    });
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('WEAK_PASSWORD');
  });
});
