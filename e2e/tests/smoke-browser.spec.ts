import { expect, test } from '@playwright/test';

test.describe('browser smoke (desktop and mobile)', () => {
  for (const path of ['/', '/casinos-for-sale', '/contact', '/register', '/admin/login']) {
    test(`${path} renders without script errors or horizontal scroll`, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const response = await page.goto(path);
      expect(response?.status()).toBeLessThan(400);
      await expect(page.locator('h1').first()).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
      expect(overflow, 'page must not scroll sideways').toBe(false);
      expect(errors).toEqual([]);
    });
  }

  test('contact form blocks an empty submission with a visible message', async ({ page }) => {
    await page.goto('/contact');
    await page.locator('form button[type="submit"], form input[type="submit"]').first().click();
    await expect(page.locator(':invalid, [role="alert"], .error').first()).toBeVisible();
  });
});
