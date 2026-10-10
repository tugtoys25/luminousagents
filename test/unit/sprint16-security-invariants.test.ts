import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

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
      expect(source).not.toMatch(/request-code|verify-code|buyer_login_codes/);
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
    const portal = read('src/auth/portal-routes.ts');
    expect(portal).toMatch(/sha256Hex\(token\)/);
    const password = read('src/auth/password.ts');
    expect(password).toMatch(/token_hash/);
    expect(password).toMatch(/HttpOnly; Secure; SameSite=Lax/);
  });

  it('keeps first-administrator setup gated by the one-time token and requires a password', () => {
    const portal = read('src/auth/portal-routes.ts');
    expect(portal).toMatch(/ADMIN_BOOTSTRAP_TOKEN/);
    expect(portal).toMatch(/NOT EXISTS \(SELECT 1 FROM users WHERE user_type = 'staff'\)/);
    expect(portal).toMatch(/'super_admin'/);
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
    const portal = read('src/auth/portal-routes.ts');
    expect(portal).toMatch(/AND password_hash IS NULL LIMIT 1/);
    expect(portal).toMatch(/AND password_hash IS NULL[^)]*\)\s*\.bind\(hash/);
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
