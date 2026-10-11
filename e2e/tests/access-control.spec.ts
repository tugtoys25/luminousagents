import { expect, test } from '@playwright/test';

test.describe('anonymous access is refused', () => {
  for (const path of ['/dashboard', '/dashboard/opportunities', '/dashboard/opportunities/reconciliation', '/dashboard/audit', '/dashboard/sessions']) {
    test(`staff area ${path} is not readable without a session`, async ({ request }) => {
      const response = await request.get(path, { maxRedirects: 0 });
      expect([301, 302, 303, 307, 308, 401, 403]).toContain(response.status());
      expect(await response.text()).not.toMatch(/"data"\s*:/);
    });
  }

  for (const path of ['/api/buyer/me', '/api/buyer/profile', '/api/buyer/opportunities', '/api/buyer/nda-requests']) {
    test(`buyer API ${path} requires sign-in`, async ({ request }) => {
      expect((await request.get(path)).status()).toBe(401);
    });
  }

  test('a random private media id is not served', async ({ request }) => {
    expect((await request.get('/media/00000000-0000-0000-0000-000000000000')).status()).toBe(404);
  });

  test('cross-site writes are rejected', async ({ request, baseURL }) => {
    const response = await request.post('/api/buyer/auth/request-code', {
      headers: { origin: 'https://evil.example' },
      data: { email: 'nobody@example.test' },
    });
    expect([400, 403]).toContain(response.status());
    expect(baseURL).toBeTruthy();
  });
});

test.describe('sign-in does not reveal which accounts exist', () => {
  test('staff login with a wrong password is a generic 401', async ({ request }) => {
    const response = await request.post('/api/admin/auth/login', { data: { email: 'nobody@example.test', password: 'Wrong-password-12345' } });
    expect(response.status()).toBe(401);
  });

  test('buyer code request gives the same answer for unknown and malformed-but-valid emails', async ({ request }) => {
    const a = await request.post('/api/buyer/auth/request-code', { data: { email: `nobody-${Date.now()}@example.test` } });
    const b = await request.post('/api/buyer/auth/request-code', { data: { email: `other-${Date.now()}@example.test` } });
    // 202 when email-code sign-in is configured; 503 when it is not. Either way both answers must match.
    expect(a.status()).toBe(b.status());
    expect([202, 503]).toContain(a.status());
    if (a.status() === 202) expect(await a.json()).toEqual(await b.json());
  });

  test('verifying a wrong code is refused', async ({ request }) => {
    const response = await request.post('/api/buyer/auth/verify-code', { data: { email: 'nobody@example.test', code: '000000' } });
    expect([401, 503]).toContain(response.status());
  });
});
