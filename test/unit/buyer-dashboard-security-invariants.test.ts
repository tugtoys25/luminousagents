import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Static source guards (plain Node): buyer dashboard additions must keep every access check.
const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

/** The buyer API is split across src/buyers/*-routes.ts and shared.ts; invariants read them as one. */
const readBuyers = () =>
  ['routes', 'shared', 'profile-routes', 'documents-routes', 'nda-routes']
    .map((n) => read(`src/buyers/${n}.ts`))
    .join('\n');

describe('buyer dashboard guards', () => {
  const routes = readBuyers();

  it('preview re-checks session, clean scan, published listing, active grant and tier', () => {
    const start = routes.indexOf("buyers.get('/api/buyer/documents/:documentId/preview'");
    const end = routes.indexOf("buyers.get('/api/buyer/nda-template/download'");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const handler = routes.slice(start, end);
    expect(handler).toContain('requireBuyer');
    // The handler must call the repository lookups AND compare tiers itself; the SQL rules live in buyers-repo.
    expect(handler).toContain('findAccessibleDocument(');
    expect(handler).toContain('findActiveGrant(');
    expect(handler).toContain('doc.tier > grant.tier');
    expect(handler.indexOf('findAccessibleDocument(')).toBeLessThan(handler.indexOf('findActiveGrant('));
    expect(handler.indexOf('doc.tier > grant.tier')).toBeLessThan(handler.indexOf('PRIVATE_FILES.get'));
    const repo = read('src/buyers/buyers-repo.ts');
    expect(repo).toContain("d.scan_status = 'clean'");
    expect(repo).toContain('revoked_at IS NULL AND expires_at > ?');
    expect(handler).toContain('PREVIEW_NOT_AVAILABLE');
    expect(handler).toContain('document.previewed');
  });

  it('only previews inert content types (never HTML or SVG)', () => {
    const start = routes.indexOf('const PREVIEW_TYPES');
    const block = routes.slice(start, routes.indexOf(']);', start));
    expect(block).not.toMatch(/html|svg|javascript/i);
  });

  it('NDA download verifies the template hash and is audited', () => {
    const start = routes.indexOf("buyers.get('/api/buyer/nda-template/download'");
    const handler = routes.slice(start, start + 3000);
    expect(handler).toContain('NDA_TEMPLATE_HASH_MISMATCH');
    expect(handler).toContain('nda.template_downloaded');
    expect(handler).toContain('attachment;');
    expect(routes).toContain("buyers.get('/api/buyer/activity'");
  });

  it('keeps the existing download endpoint and shows a visible register button', () => {
    expect(routes).toContain("buyers.get('/api/buyer/documents/:documentId/download'");
    expect(routes).toContain('href="/register"');
    expect(routes).toContain('buyer-btn-register');
  });

  it('relaxes framing only for the account page and preview responses', () => {
    const headers = read('src/middleware/security-headers.ts');
    expect(headers).toContain('PREVIEW_PATH');
    expect(headers).toContain("frame-ancestors 'self'");
    expect(headers).toContain("'DENY'");
  });
});
