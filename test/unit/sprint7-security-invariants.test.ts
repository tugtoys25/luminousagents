import { describe, expect, it } from 'vitest';
import { readAdminSources } from '../../scripts/lib/admin-sources.mjs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path: string) =>
  path === 'src/admin/routes.ts'
    ? readAdminSources()
    : readFileSync(resolve(process.cwd(), path), 'utf8');

/** The buyer API is split across src/buyers/*-routes.ts and shared.ts; invariants read them as one. */
const readBuyers = () =>
  ['routes', 'shared', 'profile-routes', 'documents-routes', 'nda-routes']
    .map((n) => read(`src/buyers/${n}.ts`))
    .join('\n');

describe('Sprint 7 document security invariants', () => {
  it('defaults newly migrated documents to pending and constrains scan states', () => {
    const sql = read('migrations/0009_document_integrity.sql');
    expect(sql).toMatch(/scan_status TEXT NOT NULL DEFAULT 'pending'/);
    expect(sql).toMatch(/CHECK \(scan_status IN \('pending','clean','rejected'\)\)/);
  });

  it('stores SHA-256 and pending status for new uploads', () => {
    const source = read('src/admin/routes.ts');
    expect(source).toMatch(/sha256, scan_status, scan_provider[\s\S]*?scanSkipped \? 'clean' : 'pending'/);
  });

  it('only switches the scanner off through the audited admin endpoint', () => {
    const source = read('src/admin/routes.ts');
    expect(source).toContain("admin.put('/scanner-settings', requireRole('admin', 'super_admin')");
    expect(source).toContain('platform.scanner_mode_changed');
    expect(source).toMatch(/VERIFIED_SCAN_REQUIRED/);
    expect(read('src/security/malware-scanner.ts')).toMatch(/=== 'disabled' \? 'disabled' : 'enforced'/);
  });

  it('only permits a clean release through the verified scanner adapter', () => {
    const source = read('src/admin/routes.ts');
    expect(source).toMatch(/scanR2Document\(c\.env/);
    expect(source).toMatch(/VERIFIED_SCAN_REQUIRED/);
    expect(source).toMatch(/crypto\.subtle/);
  });

  it('records the scanned file digest in release audit details', () => {
    const source = read('src/admin/routes.ts');
    expect(source).toMatch(/sha256: document\.sha256/);
    expect(source).toMatch(/document\.scan\.\$\{p\.status\}/); // manual status audit (documents-repo)
  });

  it('does not expose non-clean documents to buyer download queries', () => {
    const source = readBuyers() + read('src/buyers/buyers-repo.ts');
    expect(source).toMatch(/scan_status = 'clean'/);
  });
});
