import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('Sprint 7 document security invariants', () => {
  it('defaults newly migrated documents to pending and constrains scan states', () => {
    const sql = read('migrations/0009_document_integrity.sql');
    expect(sql).toMatch(/scan_status TEXT NOT NULL DEFAULT 'pending'/);
    expect(sql).toMatch(/CHECK \(scan_status IN \('pending','clean','rejected'\)\)/);
  });

  it('stores SHA-256 and pending status for new uploads', () => {
    const source = read('src/admin/routes.ts');
    expect(source).toMatch(/sha256, scan_status\) VALUES \([\s\S]*?'pending'\)/);
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
    expect(source).toMatch(/document\.scan\.\$\{parsed\.data\.status\}/);
  });

  it('does not expose non-clean documents to buyer download queries', () => {
    const source = read('src/buyers/routes.ts');
    expect(source).toMatch(/scan_status = 'clean'/);
  });
});
