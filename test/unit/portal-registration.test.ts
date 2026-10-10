import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('portal registration and bootstrap', () => {
  it('serves the staff login and one-time setup pages', async () => {
    const login = await SELF.fetch('https://mayfair.test/admin/login');
    expect(login.status).toBe(200);
    expect(await login.text()).toContain('Cloudflare Access');

    const setup = await SELF.fetch('https://mayfair.test/admin/setup');
    expect([200, 410, 503]).toContain(setup.status);
  });

  it('keeps first-admin bootstrap disabled without the server-side token', async () => {
    const response = await SELF.fetch('https://mayfair.test/api/admin/bootstrap', {
      method: 'POST',
      headers: { origin: 'https://mayfair.test', 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'First Admin', email: 'first-admin@example.test', token: 'x'.repeat(40) }),
    });
    expect(response.status).toBe(503);
    expect((await response.json() as { error: { code: string } }).error.code).toBe('BOOTSTRAP_DISABLED');
  });

  it('registers new buyers as invited, never automatically active', async () => {
    const email = `buyer-${crypto.randomUUID()}@example.test`;
    const response = await SELF.fetch('https://mayfair.test/api/buyer/register', {
      method: 'POST',
      headers: { origin: 'https://mayfair.test', 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Test Buyer', email, companyName: 'Example Capital', roleTitle: 'Principal', investmentFocus: 'casino-hotel', consent: true }),
    });
    expect(response.status).toBe(202);
    const user = await env.DB.prepare("SELECT id,status,user_type FROM users WHERE email=? COLLATE NOCASE").bind(email).first<{ id: string; status: string; user_type: string }>();
    expect(user).toMatchObject({ status: 'invited', user_type: 'buyer' });
    const profile = user ? await env.DB.prepare('SELECT privacy_consent_at AS consentAt, privacy_notice_version AS consentVersion FROM buyer_profiles WHERE user_id=?').bind(user.id).first<{ consentAt: string | null; consentVersion: string }>() : null;
    expect(profile?.consentAt).toBeTruthy();
    expect(profile?.consentVersion).toBe('2026-10-10-v1');
    if (user) {
      await env.DB.prepare('DELETE FROM notification_jobs WHERE payload_json LIKE ?').bind(`%${user.id}%`).run();
      await env.DB.prepare('DELETE FROM users WHERE id=?').bind(user.id).run();
    }
  });
});
