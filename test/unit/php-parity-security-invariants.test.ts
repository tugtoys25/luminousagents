import { describe, expect, it } from 'vitest';
import { readAdminSources } from '../../scripts/lib/admin-sources.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const read = (path: string) =>
  path === 'src/admin/routes.ts'
    ? readAdminSources()
    : readFileSync(resolve(process.cwd(), path), 'utf8');

describe('PHP-edition parity: wiring and security invariants', () => {
  const index = read('src/index.ts');
  const routes = read('src/admin/routes.ts');
  const headers = read('src/middleware/security-headers.ts');

  it('screens SVG and ICO uploads before storing them', () => {
    expect(routes).toContain("['image/svg+xml', '.svg']");
    expect(routes).toContain("type === 'image/svg+xml' && !isSafeSvg(bytes)");
    expect(routes).toContain('hasIcoSignature(b)');
  });

  it('sandboxes SVG responses, including in the global security headers', () => {
    expect(index).toContain('SVG_SANDBOX_CSP');
    expect(headers).toContain('SVG_SANDBOX_CSP');
  });

  it('answers repeat public media views with 304 only after the visibility check', () => {
    const lookup = index.indexOf("visibility = \\'public\\'");
    const notModified = index.indexOf('status: 304');
    expect(lookup).toBeGreaterThan(-1);
    expect(notModified).toBeGreaterThan(lookup);
  });

  it('registers every new setting key and validates links and images on save', () => {
    for (const key of ['og_image_url', 'chairman_bio', 'instagram_url', 'linkedin_url', 'email_widget_enabled', 'footer_explore_navigation'])
      expect(routes).toContain(`'${key}'`);
    expect(routes).toContain('INVALID_INSTAGRAM_URL');
    expect(routes).toContain('INVALID_LINKEDIN_URL');
    expect(routes).toContain('brandImageKeys.includes(key)');
  });

  it('keeps shell pages brand-only (no widgets, nav rewrite or cookie banner)', () => {
    expect(index).toContain('isShellPage');
    expect(index.indexOf('if (isShellPage)')).toBeLessThan(index.indexOf('if (siteName)'));
  });

  it('ships the optional seed outside the numbered migrations', () => {
    expect(existsSync(resolve(process.cwd(), 'scripts/seed-php-parity-content.sql'))).toBe(true);
    expect(existsSync(resolve(process.cwd(), 'migrations/0031_php_parity.sql'))).toBe(false);
  });
});
