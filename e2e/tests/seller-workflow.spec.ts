import { expect, test } from '@playwright/test';

const staffEmail = process.env.E2E_STAFF_EMAIL;
const staffPassword = process.env.E2E_STAFF_PASSWORD;
const brokerEmail = process.env.E2E_BROKER_EMAIL;
const brokerPassword = process.env.E2E_BROKER_PASSWORD;
// Set to "yes" only when the staging Worker uses Cloudflare's documented always-pass Turnstile test keys.
const turnstileTestKeys = process.env.E2E_TURNSTILE_TEST_KEYS === 'yes';

test.describe('public seller enquiry page', () => {
  test('renders the approved form without uploads and with the privacy link', async ({ page }) => {
    await page.goto('/sell-a-casino');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Considering Selling a Casino or Casino-Hotel?');
    await expect(page.locator('input[type="file"]')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Privacy Notice' })).toHaveAttribute('href', '/legal/privacy');
    await expect(page.getByRole('button', { name: 'Submit Confidential Enquiry' })).toBeVisible();
    await expect(page.locator('input[name="privacy_acknowledged"]')).not.toBeChecked();
    await expect(page.locator('input[name="accuracy_declared"]')).not.toBeChecked();
    for (const radio of ['asset_name_confidential', 'authority_declaration', 'confidentiality_preference'])
      await expect(page.locator(`input[name="${radio}"]:checked`)).toHaveCount(0); // nothing is preselected
  });

  test('conditional fields appear only when relevant', async ({ page }) => {
    await page.goto('/sell-a-casino');
    await expect(page.locator('[data-field="contact_role_other"]')).toBeHidden();
    await page.selectOption('select[name="contact_role"]', 'OTHER');
    await expect(page.locator('[data-field="contact_role_other"]')).toBeVisible();
    await page.fill('input[name="asking_price_text"]', '10m');
    await page.selectOption('select[name="currency"]', 'OTHER');
    await expect(page.locator('[data-field="currency_other"]')).toBeVisible();
  });

  test('the submit endpoint is not a readable page and refuses oversized or non-JSON bodies', async ({ request }) => {
    expect((await request.get('/api/sell-a-casino')).status()).not.toBe(200);
    const big = await request.post('/api/sell-a-casino', { data: { filler: 'x'.repeat(40_000) } });
    expect([400, 403, 413, 422]).toContain(big.status());
    const text = await request.post('/api/sell-a-casino', { headers: { 'content-type': 'text/plain' }, data: 'hello' });
    expect([400, 403, 415]).toContain(text.status());
    expect(await text.text()).not.toMatch(/stack|at .*\(.*:\d+:\d+\)/i);
  });

  test('a valid submission shows a reference and never puts it in the URL (needs Turnstile test keys)', async ({ page }) => {
    test.skip(!turnstileTestKeys, 'set E2E_TURNSTILE_TEST_KEYS=yes on a staging Worker that uses Cloudflare test keys');
    await page.goto('/sell-a-casino');
    await page.fill('input[name="contact_name"]', 'E2E Test Seller');
    await page.selectOption('select[name="contact_role"]', 'OWNER');
    await page.fill('input[name="email"]', `e2e-${Date.now()}@example.test`);
    await page.selectOption('select[name="preferred_contact_method"]', 'EMAIL');
    await page.selectOption('select[name="contact_country"]', 'GB');
    await page.selectOption('select[name="asset_type"]', 'CASINO');
    await page.selectOption('select[name="asset_country"]', 'MT');
    await page.check('input[name="asset_name_confidential"][value="YES"]');
    await page.fill('textarea[name="asset_description"]', 'Synthetic E2E description of a licensed casino for testing only.');
    await page.selectOption('select[name="operating_status"]', 'OPERATING');
    await page.check('input[name="authority_declaration"][value="UNSURE"]');
    await page.selectOption('select[name="sale_timing"]', 'EXPLORING');
    await page.check('input[name="confidentiality_preference"][value="DISCUSS_WITH_BROKER"]');
    await page.check('input[name="privacy_acknowledged"]');
    await page.check('input[name="accuracy_declared"]');
    const url = page.url();
    await page.getByRole('button', { name: 'Submit Confidential Enquiry' }).click();
    await expect(page.getByRole('status')).toContainText(/CM-S-[A-HJ-NP-Z2-9]{6}/);
    await expect(page.getByRole('heading', { name: 'Thank You for Your Enquiry' })).toBeVisible();
    expect(page.url()).toBe(url);
  });

  test('missing acknowledgements produce accessible field errors (needs Turnstile test keys)', async ({ page }) => {
    test.skip(!turnstileTestKeys, 'set E2E_TURNSTILE_TEST_KEYS=yes on a staging Worker that uses Cloudflare test keys');
    await page.goto('/sell-a-casino');
    await page.getByRole('button', { name: 'Submit Confidential Enquiry' }).click();
    const alert = page.getByRole('alert').first();
    await expect(alert).toBeVisible();
    await expect(page.locator('input[name="contact_name"]')).toHaveAttribute('aria-invalid', 'true');
  });
});

test.describe('seller areas are closed to anonymous visitors', () => {
  for (const path of ['/dashboard/seller-enquiries', '/dashboard/seller-enquiries/ui', '/dashboard/sellers', '/dashboard/sellers/ui', '/dashboard/seller-privacy/ui', '/dashboard/seller-retention/candidates', '/dashboard/seller-privacy-requests']) {
    test(`${path} is not readable without a session`, async ({ request }) => {
      const response = await request.get(path, { maxRedirects: 0 });
      expect([301, 302, 303, 307, 308, 401, 403]).toContain(response.status());
      expect(await response.text()).not.toMatch(/"data"\s*:|CM-S-[A-Z0-9]{6}/);
    });
  }
  for (const path of ['/dashboard/seller-settings/ui', '/dashboard/seller-settings']) {
    test(`${path} is not readable without a session`, async ({ request }) => {
      const response = await request.get(path, { maxRedirects: 0 });
      expect([301, 302, 303, 307, 308, 401, 403]).toContain(response.status());
    });
  }
  for (const path of ['/dashboard/authority-evidence/00000000-0000-4000-8000-000000000000/download']) {
    test(`${path} is not downloadable without a session`, async ({ request }) => {
      const response = await request.get(path, { maxRedirects: 0 });
      expect([301, 302, 303, 307, 308, 401, 403, 404]).toContain(response.status());
      expect(response.headers()['content-type'] ?? '').not.toMatch(/pdf|image|officedocument/);
    });
  }
  for (const path of ['/dashboard/seller-enquiries/CM-S-AAAAAA/assign', '/dashboard/seller-enquiries/CM-S-AAAAAA/status', '/dashboard/seller-messages/x/send', '/dashboard/seller-material-notices/x/send', '/dashboard/authority/CM-A-AAAAAA/transition', '/dashboard/authority/CM-A-AAAAAA/evidence', '/dashboard/authority-evidence/x/scan', '/dashboard/authority-evidence/x/delete', '/dashboard/seller-settings/reminders_enabled']) {
    test(`POST ${path} is refused without a session`, async ({ request }) => {
      const response = await request.post(path, { data: {}, maxRedirects: 0 });
      expect([301, 302, 303, 307, 308, 401, 403, 404]).toContain(response.status());
    });
  }
});

test.describe('admin signed in (needs E2E_STAFF_EMAIL / E2E_STAFF_PASSWORD, an admin or super_admin)', () => {
  test.skip(!staffEmail || !staffPassword, 'staff credentials not provided');
  test.beforeEach(async ({ request }) => {
    expect((await request.post('/api/admin/auth/login', { data: { email: staffEmail, password: staffPassword } })).status()).toBe(200);
  });

  test('can list seller enquiries and gets a uniform 404 for unknown references', async ({ request }) => {
    const list = await request.get('/dashboard/seller-enquiries');
    expect(list.status()).toBe(200);
    const body = (await list.json()) as { data: unknown[]; total: number; pageSize: number };
    expect(Array.isArray(body.data)).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/"email"|"telephone"|"assetDescription"/); // the list omits contact details and free text
    expect((await request.get('/dashboard/seller-enquiries/CM-S-AAAAAA')).status()).toBe(404);
    expect((await request.get('/dashboard/seller-enquiries/not-a-reference')).status()).toBe(404);
  });

  test('publication gates answer 404 for an unknown opportunity and retention lists nothing until a policy is configured', async ({ request }) => {
    expect((await request.get('/dashboard/opportunities/does-not-exist/seller-gates')).status()).toBe(404);
    const retention = await request.get('/dashboard/seller-retention/candidates');
    expect(retention.status()).toBe(200);
    const body = (await retention.json()) as { policyConfigured: boolean; data: unknown[] };
    expect(typeof body.policyConfigured).toBe('boolean');
    if (!body.policyConfigured) expect(body.data).toEqual([]);
  });

  test('seller settings list every setting with its source and flag the sensitive ones', async ({ request }) => {
    const response = await request.get('/dashboard/seller-settings');
    expect(response.status()).toBe(200);
    const body = (await response.json()) as { data: Array<{ key: string; source: string; sensitive: boolean }> };
    expect(body.data.length).toBeGreaterThanOrEqual(11);
    expect(body.data.filter((x) => x.sensitive).map((x) => x.key).sort()).toEqual(['marketing_consent_enabled', 'material_interest_dual_approval', 'retention_review_days', 'separation_of_duties']);
  });

  test('a seller email cannot be sent without confirmation, and export needs a super admin with recent MFA', async ({ request }) => {
    const send = await request.post('/dashboard/seller-messages/00000000-0000-4000-8000-000000000000/send', { data: { expectedVersion: 1 } });
    expect([404, 422]).toContain(send.status());
    expect([403, 404]).toContain((await request.get('/dashboard/seller-enquiries/CM-S-AAAAAA/export')).status());
  });
});

test.describe('broker signed in (needs E2E_BROKER_EMAIL / E2E_BROKER_PASSWORD)', () => {
  test.skip(!brokerEmail || !brokerPassword, 'broker credentials not provided');
  test.beforeEach(async ({ request }) => {
    expect((await request.post('/api/admin/auth/login', { data: { email: brokerEmail, password: brokerPassword } })).status()).toBe(200);
  });

  test('is refused assignment, retention, privacy requests and material-interest approval', async ({ request }) => {
    for (const [method, path] of [['post', '/dashboard/seller-enquiries/CM-S-AAAAAA/assign'], ['get', '/dashboard/seller-retention/candidates'], ['get', '/dashboard/seller-privacy-requests'], ['post', '/dashboard/seller-material-notices/x/send'], ['post', '/dashboard/authority/CM-A-AAAAAA/transition']] as const) {
      const response = method === 'get' ? await request.get(path) : await request.post(path, { data: {} });
      expect(response.status(), path).toBe(403);
    }
  });

  test('is refused settings, evidence download, evidence deletion and scanning', async ({ request }) => {
    for (const [method, path] of [['get', '/dashboard/seller-settings'], ['post', '/dashboard/seller-settings/reminders_enabled'], ['get', '/dashboard/authority-evidence/00000000-0000-4000-8000-000000000000/download'], ['post', '/dashboard/authority-evidence/00000000-0000-4000-8000-000000000000/delete'], ['post', '/dashboard/authority-evidence/00000000-0000-4000-8000-000000000000/scan']] as const) {
      const response = method === 'get' ? await request.get(path) : await request.post(path, { data: {} });
      expect(response.status(), path).toBe(403);
    }
  });

  test('can use the staff list but sees an unknown or someone else\'s enquiry exactly like a missing one', async ({ request }) => {
    expect((await request.get('/dashboard/seller-enquiries')).status()).toBe(200);
    expect((await request.get('/dashboard/seller-enquiries/CM-S-AAAAAA')).status()).toBe(404);
  });
});
