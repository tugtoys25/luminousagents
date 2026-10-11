import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('Sprint 26 opportunity integrity safeguards', () => {
  it('adds review-queue and version-history indexes', () => {
    const migration = read('migrations/0023_sprint26_opportunity_integrity.sql');
    expect(migration).toContain('idx_opportunities_review_queue');
    expect(migration).toContain('idx_opportunity_versions_recent');
  });

  it('exports opportunities only to administrators and protects CSV from formula injection', () => {
    const routes = read('src/admin/routes.ts');
    expect(routes).toContain("'/opportunities/export.csv', requireRole('admin', 'super_admin')");
    expect(routes).toContain("const safe = /^[\\s]*[=+@]/.test(text) || /^[\\s]*-/.test(text) ? `'${text}` : text;");
    expect(routes).toContain("'opportunity.exported'");
  });

  it('supports bounded, reasoned bulk review without making records public', () => {
    const routes = read('src/admin/routes.ts');
    expect(routes).toContain("'/opportunities/bulk-review', requireRole(...publisherRoles)");
    expect(routes).toContain('z.array(z.string().trim().min(1).max(100)).min(1).max(50)');
    expect(routes).toContain("public_visibility = 0, updated_at = ? WHERE id = ?");
    expect(routes).toContain('bulk: true');
  });

  it('imports existing records only, prevalidates CSV, versions changes and resets public state', () => {
    const routes = read('src/admin/routes.ts');
    expect(routes).toContain("'/opportunities/import.csv', requireRole('admin', 'super_admin')");
    expect(routes).toContain('Imports update existing records only.');
    expect(routes).toContain('await c.env.DB.batch(statements)');
    expect(routes).toContain("content_review_status = 'pending', public_visibility = 0");
  });

  it('restores version content as a private draft and records the restoration', () => {
    const routes = read('src/admin/routes.ts');
    expect(routes).toContain("'/opportunities/:id/versions/:versionNumber/restore'");
    expect(routes).toContain("lifecycle = 'draft', content_review_status = 'pending', public_visibility = 0");
    expect(routes).toContain("'opportunity.version_restored'");
  });
});
