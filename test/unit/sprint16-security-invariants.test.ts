import { describe, expect, it } from 'vitest';
import { readAdminSources } from '../../scripts/lib/admin-sources.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const read = (path: string) =>
  path === 'src/admin/routes.ts'
    ? readAdminSources()
    : readFileSync(resolve(process.cwd(), path), 'utf8');

/** The sign-in portal is split across src/auth/portal-*.ts (pages, auth API, email codes, onboarding); invariants read them as one. */
const readPortal = () =>
  ['portal-routes', 'portal-shared', 'portal-pages', 'portal-auth-api', 'portal-buyer-code', 'portal-onboarding']
    .map((n) => read(`src/auth/${n}.ts`))
    .join('\n');

describe('Sprint 16 unified password-authentication invariants', () => {
  it('no longer depends on Cloudflare Access or emailed one-time login codes', () => {
    expect(existsSync(resolve(process.cwd(), 'src/auth/cloudflare-access.ts'))).toBe(false);
    for (const file of [
      'src/admin/routes.ts',
      'src/auth/portal-routes.ts',
      'src/auth/staff-session.ts',
      'src/index.ts',
      'src/buyers/routes.ts',
      'src/env.ts',
    ]) {
      const source = read(file);
      expect(source).not.toMatch(/Cf-Access-Jwt-Assertion|ACCESS_TEAM_DOMAIN|ACCESS_AUD/);
      // Sprint 25 owner decision (DECISIONS.md): buyers may use email one-time codes again, in buyer_email_codes.
      expect(source).not.toMatch(/buyer_login_codes/);
    }
  });

  it('stores only salted PBKDF2 hashes within the Workers iteration cap', () => {
    const source = read('src/auth/password.ts');
    expect(source).toMatch(/PBKDF2/);
    expect(source).toMatch(/ITERATIONS = 100_000/);
    expect(source).toMatch(/getRandomValues\(new Uint8Array\(16\)\)/);
    expect(read('migrations/0016_auth_hardening.sql')).toMatch(
      /failed_login_count[\s\S]*session_type/,
    );
  });

  it('hashes session and reset tokens before storage and sets hardened cookies', () => {
    const portal = readPortal();
    expect(portal).toMatch(/sha256Hex\(token\)/);
    const password = read('src/auth/password.ts');
    // The raw token is hashed in password.ts before it reaches the repository, which only has a token_hash column.
    expect(password).toMatch(/tokenHash: await sha256Hex\(token\)/);
    expect(read('src/auth/password-repo.ts')).toMatch(/token_hash/);
    expect(password).toMatch(/HttpOnly; Secure; SameSite=Lax/);
  });

  it('keeps first-administrator setup gated by the one-time token and requires a password', () => {
    const portal = readPortal();
    expect(portal).toMatch(/ADMIN_BOOTSTRAP_TOKEN/);
    // The single-statement NOT EXISTS guard lives in the repository; the route must go through it.
    const repo = read('src/auth/portal-onboarding-repo.ts');
    expect(repo).toMatch(/NOT EXISTS \(SELECT 1 FROM users WHERE user_type = 'staff'\)/);
    expect(repo).toMatch(/'super_admin'/);
    expect(portal).toMatch(/insertFirstAdmin\(/);
    expect(portal).toMatch(/passwordPolicyError\(input\.data\.password/);
  });

  it('keeps the Sprint 14/15 migrations untouched and builds on them', () => {
    expect(read('migrations/0014_custom_staff_auth.sql')).toMatch(/ADD COLUMN password_hash/);
    expect(read('migrations/0015_platform_management.sql')).toMatch(
      /CREATE TABLE IF NOT EXISTS password_reset_tokens/,
    );
    expect(read('migrations/0016_auth_hardening.sql')).not.toMatch(
      /ADD COLUMN password_hash|CREATE TABLE/,
    );
    expect(existsSync(resolve(process.cwd(), 'src/auth/password-routes.ts'))).toBe(false);
  });

  it('only provisions first passwords for active staff that have none, using the one-time token', () => {
    const portal = readPortal();
    const repo = read('src/auth/portal-onboarding-repo.ts');
    expect(repo).toMatch(/AND password_hash IS NULL LIMIT 1/);
    expect(repo).toMatch(/AND password_hash IS NULL"/);
    expect(portal).toMatch(/findUnconfiguredStaffByEmail\(/);
    expect(portal).toMatch(/provisionStaffPassword\(c\.env\.DB, \{[^}]*passwordHash: hash/);
  });

  it('restricts staff account management to super administrators', () => {
    const admin = read('src/admin/routes.ts');
    for (const route of ["'/staff/ui'", "'/staff'", "'/staff/:id'", "'/staff/:id/reset-password'"])
      expect(admin).toMatch(
        new RegExp(
          `admin\\.(get|post|patch)\\(${route.replace(/[/:]/g, (m) => '\\' + m)}, requireRole\\('super_admin'\\)`,
        ),
      );
  });
});
