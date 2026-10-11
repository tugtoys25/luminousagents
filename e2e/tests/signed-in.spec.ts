import { expect, test } from '@playwright/test';

const buyerEmail = process.env.E2E_BUYER_EMAIL;
const buyerPassword = process.env.E2E_BUYER_PASSWORD;
const staffEmail = process.env.E2E_STAFF_EMAIL;
const staffPassword = process.env.E2E_STAFF_PASSWORD;
const brokerEmail = process.env.E2E_BROKER_EMAIL;
const brokerPassword = process.env.E2E_BROKER_PASSWORD;

test.describe('buyer signed in (needs E2E_BUYER_EMAIL / E2E_BUYER_PASSWORD, an ACTIVE buyer on staging)', () => {
  test.skip(!buyerEmail || !buyerPassword, 'buyer credentials not provided');

  test('can sign in, read the profile and is refused staff routes', async ({ request }) => {
    const login = await request.post('/api/buyer/auth/login', { data: { email: buyerEmail, password: buyerPassword } });
    expect(login.status()).toBe(200);
    expect((await request.get('/api/buyer/me')).status()).toBe(200);
    expect((await request.get('/api/buyer/profile')).status()).toBe(200);
    const staff = await request.get('/dashboard/opportunities', { maxRedirects: 0 });
    expect([301, 302, 303, 307, 308, 401, 403]).toContain(staff.status());
  });

  test('responses to the buyer are private and uncached', async ({ request }) => {
    await request.post('/api/buyer/auth/login', { data: { email: buyerEmail, password: buyerPassword } });
    const response = await request.get('/api/buyer/profile');
    expect(response.headers()['cache-control'] ?? '').toMatch(/no-store|private/);
  });

  test('cannot download a document that was never granted', async ({ request }) => {
    await request.post('/api/buyer/auth/login', { data: { email: buyerEmail, password: buyerPassword } });
    const response = await request.get('/api/buyer/documents/not-a-real-document/download');
    expect([403, 404]).toContain(response.status());
  });
});

test.describe('staff signed in (needs E2E_STAFF_EMAIL / E2E_STAFF_PASSWORD, an admin or super_admin)', () => {
  test.skip(!staffEmail || !staffPassword, 'staff credentials not provided');

  test('reads the lifecycle rules and the reconciliation report', async ({ request }) => {
    const login = await request.post('/api/admin/auth/login', { data: { email: staffEmail, password: staffPassword } });
    expect(login.status()).toBe(200);
    const rules = await request.get('/dashboard/opportunities/lifecycle-transitions');
    expect(rules.status()).toBe(200);
    const { data } = (await rules.json()) as { data: { transitions: Record<string, string[]> } };
    expect(data.transitions.draft).not.toContain('published');
    const report = await request.get('/dashboard/opportunities/reconciliation');
    expect(report.status()).toBe(200);
    const body = (await report.json()) as { data: { total: number; publishable: boolean; blockers: string[] } };
    expect(body.data.total).toBeGreaterThan(0);
    expect(body.data.blockers, 'publication invariants must hold').toEqual([]);
  });

  test('an unknown opportunity cannot be published', async ({ request }) => {
    await request.post('/api/admin/auth/login', { data: { email: staffEmail, password: staffPassword } });
    const response = await request.post('/dashboard/opportunities/does-not-exist/publication', {
      data: { lifecycle: 'published', publicVisibility: false, changeReason: 'e2e check' },
    });
    expect(response.status()).toBe(404);
  });
});

test.describe('broker scope (needs E2E_BROKER_EMAIL / E2E_BROKER_PASSWORD and E2E_OTHER_OPPORTUNITY_ID not assigned to that broker)', () => {
  test.skip(!brokerEmail || !brokerPassword || !process.env.E2E_OTHER_OPPORTUNITY_ID, 'broker credentials or foreign record id not provided');

  test('a broker cannot read a record assigned to someone else', async ({ request }) => {
    await request.post('/api/admin/auth/login', { data: { email: brokerEmail, password: brokerPassword } });
    const response = await request.get(`/dashboard/opportunities/${process.env.E2E_OTHER_OPPORTUNITY_ID}`);
    expect(response.status()).toBe(404);
  });
});
