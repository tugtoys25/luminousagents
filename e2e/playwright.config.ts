import { defineConfig, devices } from '@playwright/test';

/**
 * Staging end-to-end suite. Set E2E_BASE_URL to a STAGING deployment, never production.
 * Optional credentials unlock the signed-in checks; without them those tests are skipped
 * (and reported as skipped, not passed).
 */
const baseURL = process.env.E2E_BASE_URL;
if (!baseURL) {
  throw new Error('Set E2E_BASE_URL to the staging origin, e.g. https://staging.example.com');
}
if (/^https?:\/\/(www\.)?casinosofmayfair\.com/i.test(baseURL) && process.env.E2E_ALLOW_PRODUCTION !== 'yes-i-understand') {
  throw new Error('Refusing to run against what looks like production. Use staging.');
}

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL, extraHTTPHeaders: { origin: baseURL }, trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
});
