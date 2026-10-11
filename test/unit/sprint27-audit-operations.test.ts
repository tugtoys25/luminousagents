import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('Sprint 27 audit operations', () => {
  it('adds indexes for common audit filters', () => {
    const migration = read('migrations/0024_sprint27_audit_operations.sql');
    expect(migration).toContain('idx_audit_action_created');
    expect(migration).toContain('idx_audit_entity_created');
    expect(migration).toContain('idx_audit_actor_created');
  });

  it('provides a restricted audit UI and keeps the API read-only', () => {
    const routes = read('src/admin/routes.ts');
    expect(routes).toContain("admin.get('/audit/ui', requireRole('admin', 'auditor', 'super_admin')");
    expect(routes).toContain("admin.get('/audit', requireRole('admin', 'auditor', 'super_admin')");
    expect(routes).toContain('ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?');
    expect(routes).toContain("'Cache-Control': 'private, no-store'");
    expect(routes).toContain('INVALID_AUDIT_FILTER');
  });

  it('renders audit metadata with text nodes rather than HTML injection', () => {
    const client = read('public/static/js/dashboard-audit.js');
    expect(client).toContain('node.textContent =');
    expect(client).toContain('pre.textContent =');
    expect(client).not.toContain('innerHTML');
    expect(client).toContain('URLSearchParams');
  });
});
