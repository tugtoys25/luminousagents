import { describe, expect, it } from 'vitest';
import { readAdminSources } from '../../scripts/lib/admin-sources.mjs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path: string) =>
  path === 'src/admin/routes.ts'
    ? readAdminSources()
    : readFileSync(resolve(process.cwd(), path), 'utf8');

describe('Sprint 29 staff session controls', () => {
  it('restricts session inventory and revocation to super administrators', () => {
    const routes = read('src/admin/routes.ts');
    expect(routes).toContain("admin.get('/sessions', requireRole('super_admin')");
    expect(routes).toContain("admin.post('/sessions/:id/revoke', requireRole('super_admin')");
    expect(routes).toContain("s.session_type = 'staff'");
    expect(routes).toContain("u.user_type = 'staff'");
  });

  it('does not expose session tokens and protects the current session', () => {
    const routes = read('src/admin/routes.ts');
    expect(routes).toContain("s.token_hash = ? THEN 1 ELSE 0 END AS isCurrent");
    expect(routes).toContain('CURRENT_SESSION_PROTECTED');
    expect(routes).toContain("'Cache-Control', 'private, no-store'");
    expect(routes).not.toContain('tokenHash: row');
  });

  it('records successful revocations and renders session data without HTML injection', () => {
    const routes = read('src/admin/routes.ts');
    const client = read('public/static/js/dashboard-sessions.js');
    expect(routes).toContain("'staff.session_revoked'");
    expect(client).toContain('node.textContent');
    expect(client).not.toContain('innerHTML');
    expect(client).toContain('window.confirm');
  });
});
