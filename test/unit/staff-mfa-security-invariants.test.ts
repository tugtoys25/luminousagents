import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Static guards (plain Node) for the staff MFA wiring.
const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('staff MFA wiring', () => {
  const session = read('src/auth/staff-session.ts');
  const routes = read('src/auth/mfa-routes.ts');
  const repo = read('src/auth/mfa-repo.ts');
  const migration = read('migrations/0031_staff_mfa.sql');

  it('staffAuth blocks sessions that have not passed MFA', () => {
    const gate = session.indexOf('identity.mfa.required && !identity.mfa.verified');
    const set = session.indexOf("c.set('staff', staff)");
    expect(gate).toBeGreaterThan(-1);
    expect(set).toBeGreaterThan(gate);
    expect(session).toContain("'MFA_REQUIRED'");
  });

  it('mounts the MFA router before the portal router', () => {
    const index = read('src/index.ts');
    expect(index.indexOf("app.route('/', mfaRoutes)")).toBeGreaterThan(-1);
    expect(index.indexOf("app.route('/', mfaRoutes)")).toBeLessThan(index.indexOf("app.route('/', portalRoutes)"));
  });

  it('stores only encrypted secrets and hashed recovery codes', () => {
    expect(migration).toContain('secret_enc TEXT NOT NULL');
    expect(migration).toContain('recovery_hashes');
    expect(migration).not.toMatch(/\bsecret TEXT\b/);
    expect(read('src/auth/mfa.ts')).toContain("name: 'AES-GCM'");
  });

  it('every state change is audited and reset is super-admin only', () => {
    for (const action of ['staff.mfa.enabled', 'staff.mfa.verified', 'staff.mfa.failed', 'staff.mfa.recovery_used', 'staff.mfa.reset'])
      expect(routes).toContain(action);
    expect(routes).toContain("identity.role !== 'super_admin'");
  });

  it('keeps SQL in the repository, not the routes or the service', () => {
    expect(routes).not.toContain('.prepare(');
    expect(read('src/auth/mfa.ts')).not.toContain('.prepare(');
    expect(repo).toContain('.prepare(');
  });

  it('replay and recovery-code spending use compare-and-set updates', () => {
    expect(repo).toContain('last_used_step IS NULL OR last_used_step < ?');
    expect(repo).toContain('AND recovery_hashes = ?');
  });
});
