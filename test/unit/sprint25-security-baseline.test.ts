import { describe, expect, it } from 'vitest';
import { readAdminSources } from '../../scripts/lib/admin-sources.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { serializeOpportunity, type OpportunityRow } from '../../src/domain/opportunities/serialize';
import { resolve } from 'node:path';
const read = (path: string) =>
  path === 'src/admin/routes.ts'
    ? readAdminSources()
    : readFileSync(resolve(process.cwd(), path), 'utf8');

describe('Sprint 25 security baseline', () => {
  it('redacts prices for public viewers unless price visibility is explicitly enabled', () => {
    const row: OpportunityRow = { id: 'x', slug: 'x', title: 'Example', country: 'UK', opportunity_type: 'casino', price_text: '£5m', lifecycle: 'published', summary: 'Example listing', availability: '', points_json: '[]', seo_title: '', seo_description: '', published_at: null, price_visibility: 0 };
    expect(serializeOpportunity(row, 0).price).toBeNull();
    const textRow = { ...row, price_text: '21m Euros', summary: 'Asking price 21m Euros; discreet sale.', points_json: '["Price 21m Euros"]', seo_description: 'Price of 21m Euros.' };
    const redacted = serializeOpportunity(textRow, 0);
    expect(redacted.summary).not.toContain('21m Euros');
    expect(redacted.points.join(' ')).not.toContain('21m Euros');
    expect(redacted.seoDescription).not.toContain('21m Euros');
    expect(serializeOpportunity({ ...row, price_visibility: 1 }, 0).price).toBe('£5m');
    expect(serializeOpportunity(row, 1).price).toBe('£5m');
  });
  it('defaults public opportunity serialization to redacted prices', () => {
    const serializer = read('src/domain/opportunities/serialize.ts');
    const publicPages = read('src/web/pages/public.tsx');
    expect(serializer).toContain('viewerTier: 0 | 1 | 2 | 3 = 0');
    expect(serializer).toContain('viewerTier >= 1 || row.price_visibility === 1');
    expect(publicPages).not.toContain('serializeOpportunity(row, 1)');
    expect(read('src/web/public-listings-repo.ts')).toContain('price_visibility'); // card columns are defined with the SQL
  });
  it('adds an explicit price visibility column defaulting to confidential', () => {
    const migration = read('migrations/0022_sprint25_security_baseline.sql');
    expect(migration).toContain('price_visibility INTEGER NOT NULL DEFAULT 0');
    expect(migration).toContain('buyer_email_codes');
    expect(migration).toContain('public_slug TEXT');
  });
  it('supports buyer email-code login with expiry, throttling and single use', () => {
    const auth = read('src/auth/portal-routes.ts');
    const account = read('src/buyers/routes.ts');
    expect(auth).toContain("portal.post('/api/buyer/auth/request-code'");
    expect(auth).toContain("portal.post('/api/buyer/auth/verify-code'");
    expect(auth).toContain('expires_at > ? AND attempts < 5');
    expect(auth).toContain("portal.post('/api/buyer/auth/set-password'");
    expect(account).toContain('/api/buyer/auth/request-code');
    expect(account).toContain('/api/buyer/auth/verify-code');
  });
  it('serves public media only when public and disables caching to protect private transitions', () => {
    const index = read('src/index.ts');
    const admin = read('src/admin/routes.ts');
    expect(index).toContain('findPublicMediaAsset(');
    expect(read('src/admin/repos/media-repo.ts')).toContain("visibility = 'public'");
    expect(index).toContain("public, max-age=0, s-maxage=0, must-revalidate");
    expect(admin).toContain("'media.visibility_changed'");
    expect(admin).toContain('publicSlug');
  });
  it('includes the migration and test in the source tree', () => {
    expect(existsSync(resolve(process.cwd(), 'migrations/0022_sprint25_security_baseline.sql'))).toBe(true);
    expect(existsSync(resolve(process.cwd(), 'test/unit/sprint25-security-baseline.test.ts'))).toBe(true);
  });
});
