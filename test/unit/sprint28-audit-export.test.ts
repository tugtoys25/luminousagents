import { describe, expect, it } from 'vitest';
import { readAdminSources } from '../../scripts/lib/admin-sources.mjs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path: string) =>
  path === 'src/admin/routes.ts'
    ? readAdminSources()
    : readFileSync(resolve(process.cwd(), path), 'utf8');

describe('Sprint 28 audit export safeguards', () => {
  it('restricts CSV export to audit-authorized staff and bounds the result size', () => {
    const routes = read('src/admin/routes.ts');
    expect(routes).toContain("admin.get('/audit/export.csv', requireRole('admin', 'auditor', 'super_admin')");
    expect(routes).toContain('LIMIT 5001');
    expect(routes).toContain('AUDIT_EXPORT_TOO_LARGE');
    expect(routes).toContain("'audit.exported'");
  });

  it('applies validated filters and spreadsheet formula-injection protection to exported cells', () => {
    const routes = read('src/admin/routes.ts');
    expect(routes).toContain('INVALID_AUDIT_FILTER');
    expect(routes).toContain('/^[\\s]*[=+@-]/.test(text)');
    expect(routes).toContain("'Content-Disposition'");
    expect(routes).toContain("'Cache-Control', 'private, no-store'");
  });

  it('exports the same filters selected in the audit interface', () => {
    const page = read('src/admin/routes.ts');
    const client = read('public/static/js/dashboard-audit.js');
    expect(page).toContain('id="audit-export"');
    expect(client).toContain('const params = new URLSearchParams(currentFilters())');
    expect(client).toContain('/dashboard/audit/export.csv?${params}');
    expect(client).not.toContain('innerHTML');
  });
});
