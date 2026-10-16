import { describe, expect, it } from 'vitest';
import { readAdminSources } from '../../scripts/lib/admin-sources.mjs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path: string) =>
  path === 'src/admin/routes.ts'
    ? readAdminSources()
    : readFileSync(resolve(process.cwd(), path), 'utf8');

describe('Sprint 30 buyer session controls', () => {
  it('restricts buyer session inventory and revocation to super administrators', () => {
    const routes = read('src/admin/routes.ts');
    expect(routes).toContain("admin.get('/buyer-sessions', requireRole('super_admin')");
    expect(routes).toContain("admin.post('/buyer-sessions/:id/revoke', requireRole('super_admin')");
    expect(routes).toContain("s.session_type = 'buyer'");
    expect(routes).toContain("u.user_type = 'buyer'");
  });

  it('never returns token values and audits successful revocation', () => {
    const routes = read('src/admin/routes.ts');
    expect(routes).toContain("'buyer.session_revoked'");
    expect(routes).toContain("'Cache-Control', 'private, no-store'");
    expect(routes).toContain('SESSION_ALREADY_REVOKED');
    expect(routes).not.toContain('tokenHash: row');
  });

  it('uses safe DOM rendering and asks for confirmation before revocation', () => {
    const client = read('public/static/js/dashboard-buyer-sessions.js');
    expect(client).toContain('node.textContent');
    expect(client).not.toContain('innerHTML');
    expect(client).toContain('window.confirm');
    expect(client).toContain("'/dashboard/buyer-sessions'");
  });
});
