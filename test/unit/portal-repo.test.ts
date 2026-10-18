import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import * as base from '../../src/auth/portal-repo';
import * as codes from '../../src/auth/portal-code-repo';
import * as onboarding from '../../src/auth/portal-onboarding-repo';

// These steps share database state and must run in order. The Workers test pool undoes storage after
// every test, so they run as steps inside one test instead of as separate `it` blocks.
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof Error) error.message = `[${name}] ${error.message}`;
    throw error;
  }
}

const r = { ...base, ...codes, ...onboarding };

const t0 = '2026-09-10T10:00:00.000Z';
const t1 = '2026-09-10T11:00:00.000Z';
const future = '2099-01-01T00:00:00.000Z';
const past = '2020-01-01T00:00:00.000Z';
const n = async (sql: string, ...a: string[]) => (await env.DB.prepare(sql).bind(...a).first<{ n: number }>())!.n;
const user = (id: string, type = 'buyer', status = 'active', hash: string | null = 'h') =>
  env.DB.prepare('INSERT INTO users (id, email, display_name, role, user_type, status, password_hash, must_change_password, failed_login_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)')
    .bind(id, `${id}@Example.com`, id, type === 'staff' ? 'admin' : 'buyer', type, status, hash, t0, t0).run();
const session = (id: string, userId: string, hash: string, type = 'buyer') =>
  env.DB.prepare('INSERT INTO sessions (id, user_id, token_hash, session_type, expires_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, userId, hash, type, future, t0, t0).run();
const rejected = async (p: Promise<unknown>) => { let failed = false; try { await p; } catch { failed = true; } expect(failed).toBe(true); };
const revoked = (id: string) => env.DB.prepare('SELECT revoked_at AS v FROM sessions WHERE id = ?').bind(id).first<{ v: string | null }>().then((x) => x!.v);

const code = (id: string, hash: string, exp = future) => r.insertEmailCode(env.DB, { id, userId: 'lg1', codeHash: hash, expiresAt: exp, timestamp: t1 });
const reg = (userId: string, email: string, hash: string | null, jobId: string) => ({
    userId, email, displayName: 'New Buyer', passwordHash: hash, companyName: 'Acme', roleTitle: 'CEO', experienceNotes: 'Investment focus: casino', privacyVersion: 'v-test',
    timestamp: t1, auditId: `au-${userId}`, requestId: 'rq', auditDetailsJson: '{"investmentFocus":"casino"}', jobId, jobPayloadJson: `{"userId":"${userId}"}`,
  });

describe('portal repo: login', () => {
  it('runs its steps in order', async () => {
    await step('portal repo: login > finds users case-insensitively and by kind only; session lookup is hash+kind+active only', async () => {
      await user('lg1'); await user('lg2', 'staff');
      expect(await r.findUserForLogin(env.DB, 'LG1@example.com', 'buyer')).toMatchObject({ id: 'lg1', status: 'active', failed: 0 });
      expect(await r.findUserForLogin(env.DB, 'lg1@example.com', 'staff')).toBeNull();
      await session('ls1', 'lg1', 'tok-1');
      expect(await r.findSignedInUser(env.DB, { tokenHash: 'tok-1', kind: 'buyer', timestamp: t1 })).toMatchObject({ id: 'lg1', sessionId: 'ls1' });
      expect(await r.findSignedInUser(env.DB, { tokenHash: 'tok-1', kind: 'staff', timestamp: t1 })).toBeNull();
      expect(await r.findSignedInUser(env.DB, { tokenHash: 'tok-1', kind: 'buyer', timestamp: '2100-01-01T00:00:00.000Z' })).toBeNull();
    });

    await step('portal repo: login > records failures and lockout, then completeLogin clears them and creates session + audit atomically', async () => {
      await r.recordFailedLogin(env.DB, { userId: 'lg1', failedCount: 4, lockedUntil: future, timestamp: t1 });
      expect(await r.findUserForLogin(env.DB, 'lg1@example.com', 'buyer')).toMatchObject({ failed: 4, lockedUntil: future });
      const base = { userId: 'lg1', kind: 'buyer' as const, sessionId: 'ls2', tokenHash: 'tok-2', timestamp: t1, expiresAt: future, auditId: 'au-l1', action: 'buyer.session.created', requestId: 'rq' };
      await r.completeLogin(env.DB, { ...base, rehashedPassword: 'new-hash' });
      expect(await r.findUserForLogin(env.DB, 'lg1@example.com', 'buyer')).toMatchObject({ failed: 0, lockedUntil: null, passwordHash: 'new-hash' });
      expect(await n("SELECT COUNT(*) AS n FROM sessions WHERE id = 'ls2'")).toBe(1);
      expect(await n("SELECT COUNT(*) AS n FROM audit_logs WHERE id = 'au-l1' AND action = 'buyer.session.created'")).toBe(1);
      await r.completeLogin(env.DB, { ...base, sessionId: 'ls3', tokenHash: 'tok-3', auditId: 'au-l2', rehashedPassword: null });
      expect((await r.findUserForLogin(env.DB, 'lg1@example.com', 'buyer'))!.passwordHash).toBe('new-hash');
    });

    await step('portal repo: login > rolls back the whole login if the session insert fails (duplicate token hash)', async () => {
      await r.recordFailedLogin(env.DB, { userId: 'lg1', failedCount: 2, lockedUntil: null, timestamp: t1 });
      await rejected(r.completeLogin(env.DB, { userId: 'lg1', kind: 'buyer', rehashedPassword: null, sessionId: 'ls9', tokenHash: 'tok-1', timestamp: t1, expiresAt: future, auditId: 'au-l9', action: 'x', requestId: 'rq' }));
      expect((await r.findUserForLogin(env.DB, 'lg1@example.com', 'buyer'))!.failed).toBe(2);
      expect(await n("SELECT COUNT(*) AS n FROM audit_logs WHERE id = 'au-l9'")).toBe(0);
    });

    await step('portal repo: login > revokes only the matching live session on logout', async () => {
      await r.revokeSessionByTokenHash(env.DB, 'tok-2', t1);
      expect(await revoked('ls2')).toBe(t1);
      expect(await revoked('ls1')).toBeNull();
    });

    await step('portal repo: password reset and change > only valid, unused, unexpired tokens of an active user of that kind resolve', async () => {
      await user('rs1'); await user('rs2', 'buyer', 'suspended');
      const tok = (id: string, uid: string, h: string, exp: string, used: string | null = null) =>
        env.DB.prepare("INSERT INTO password_reset_tokens (id, user_id, token_hash, purpose, expires_at, used_at, created_at) VALUES (?, ?, ?, 'reset', ?, ?, ?)").bind(id, uid, h, exp, used, t0).run();
      await tok('pt1', 'rs1', 'ok', future); await tok('pt2', 'rs1', 'exp', past); await tok('pt3', 'rs1', 'used', future, t0); await tok('pt4', 'rs2', 'susp', future);
      expect(await r.findValidResetToken(env.DB, { tokenHash: 'ok', kind: 'buyer', timestamp: t1 })).toMatchObject({ id: 'pt1', userId: 'rs1' });
      for (const h of ['exp', 'used', 'susp', 'nope']) expect(await r.findValidResetToken(env.DB, { tokenHash: h, kind: 'buyer', timestamp: t1 })).toBeNull();
      expect(await r.findValidResetToken(env.DB, { tokenHash: 'ok', kind: 'staff', timestamp: t1 })).toBeNull();
    });

    await step('portal repo: password reset and change > consumes a reset token exactly once', async () => {
      expect(await r.consumeResetToken(env.DB, 'pt1', t1)).toBe(true);
      expect(await r.consumeResetToken(env.DB, 'pt1', t1)).toBe(false);
    });

    await step('portal repo: password reset and change > reset sets the password, signs out everywhere and audits; change keeps only the current session', async () => {
      await session('rs-s1', 'rs1', 'rs-a'); await session('rs-s2', 'rs1', 'rs-b');
      await r.applyPasswordChange(env.DB, { userId: 'rs1', kind: 'buyer', currentSessionId: 'rs-s1', passwordHash: 'chg', timestamp: t1, auditId: 'au-c', action: 'buyer.password_changed', requestId: 'rq' });
      expect(await revoked('rs-s1')).toBeNull();
      expect(await revoked('rs-s2')).toBe(t1);
      await r.recordFailedLogin(env.DB, { userId: 'rs1', failedCount: 5, lockedUntil: future, timestamp: t1 });
      await r.applyPasswordReset(env.DB, { userId: 'rs1', kind: 'buyer', passwordHash: 'rst', timestamp: t1, auditId: 'au-r', action: 'buyer.password_reset_completed', requestId: 'rq' });
      expect(await revoked('rs-s1')).toBe(t1);
      expect(await r.findUserForLogin(env.DB, 'rs1@example.com', 'buyer')).toMatchObject({ passwordHash: 'rst', failed: 0, lockedUntil: null, mustChange: 0 });
      expect(await n("SELECT COUNT(*) AS n FROM audit_logs WHERE id IN ('au-c','au-r')")).toBe(2);
    });

    await step('portal repo: password reset and change > buyer set-password only touches buyers and revokes other sessions', async () => {
      await user('sp1', 'buyer', 'active', null); await user('sp2', 'staff', 'active', null);
      await session('sp-s1', 'sp1', 'sp-a'); await session('sp-s2', 'sp1', 'sp-b');
      await r.applyBuyerSetPassword(env.DB, { userId: 'sp1', currentSessionId: 'sp-s1', passwordHash: 'pw', timestamp: t1, auditId: 'au-sp', requestId: 'rq' });
      expect(await revoked('sp-s2')).toBe(t1);
      expect(await revoked('sp-s1')).toBeNull();
      await r.applyBuyerSetPassword(env.DB, { userId: 'sp2', currentSessionId: 'x', passwordHash: 'pw', timestamp: t1, auditId: 'au-sp2', requestId: 'rq' });
      expect((await r.findUserForLogin(env.DB, 'sp2@example.com', 'staff'))!.passwordHash).toBeNull();
    });

    await step('portal repo: buyer email codes > new code invalidates previous open codes; latest open code is returned', async () => {
      await code('c1', 'a'); await r.invalidateOpenEmailCodes(env.DB, 'lg1', t1);
      await code('c2', 'b');
      expect(await r.findLatestEmailCode(env.DB, 'LG1@example.com')).toMatchObject({ challengeId: 'c2', codeHash: 'b', attempts: 0, id: 'lg1' });
      expect(await r.findActiveBuyerByEmail(env.DB, 'lg1@example.com')).toMatchObject({ id: 'lg1' });
      await r.markEmailCodeUsed(env.DB, 'c2', t1);
      expect(await r.findLatestEmailCode(env.DB, 'lg1@example.com')).toBeNull();
    });

    await step('portal repo: buyer email codes > counts misses and burns the challenge on the fifth', async () => {
      await code('c3', 'x');
      for (let i = 0; i < 4; i++) await r.recordEmailCodeMiss(env.DB, 'c3', t1);
      expect(await r.findLatestEmailCode(env.DB, 'lg1@example.com')).toMatchObject({ attempts: 4 });
      await r.recordEmailCodeMiss(env.DB, 'c3', t1);
      expect(await r.findLatestEmailCode(env.DB, 'lg1@example.com')).toBeNull();
    });

    await step('portal repo: buyer email codes > consume is compare-and-set and refuses expired or over-attempted codes', async () => {
      await code('c4', 'y');
      expect(await r.consumeEmailCode(env.DB, 'c4', t1)).toBe(true);
      expect(await r.consumeEmailCode(env.DB, 'c4', t1)).toBe(false);
      await code('c5', 'z', past);
      expect(await r.consumeEmailCode(env.DB, 'c5', t1)).toBe(false);
      await code('c6', 'w');
      await env.DB.prepare("UPDATE buyer_email_codes SET attempts = 5 WHERE id = 'c6'").run();
      expect(await r.consumeEmailCode(env.DB, 'c6', t1)).toBe(false);
      await r.closeOpenEmailCode(env.DB, 'c6', t1);
    });

    await step('portal repo: buyer email codes > creates the email-code session with its audit row', async () => {
      await r.createEmailCodeSession(env.DB, { userId: 'lg1', sessionId: 'ecs', tokenHash: 'ec-tok', timestamp: t1, expiresAt: future, auditId: 'au-ec', requestId: 'rq' });
      expect(await n("SELECT COUNT(*) AS n FROM sessions WHERE id = 'ecs' AND session_type = 'buyer'")).toBe(1);
      expect(await n("SELECT COUNT(*) AS n FROM audit_logs WHERE id = 'au-ec' AND action = 'buyer.email_code_login'")).toBe(1);
    });

    await step('portal repo: first administrator bootstrap > migration only provisions an active staff account that still has no password', async () => {
      const before = await r.countUnconfiguredStaff(env.DB);
      await user('bs-s1', 'staff', 'active', null);
      expect(await r.countUnconfiguredStaff(env.DB)).toBe(before + 1);
      expect(await r.findUnconfiguredStaffByEmail(env.DB, 'BS-S1@example.com')).toMatchObject({ id: 'bs-s1' });
      expect(await r.provisionStaffPassword(env.DB, { userId: 'bs-s1', passwordHash: 'p1', timestamp: t1 })).toBe(true);
      expect(await r.provisionStaffPassword(env.DB, { userId: 'bs-s1', passwordHash: 'p2', timestamp: t1 })).toBe(false);
      expect(await r.findUnconfiguredStaffByEmail(env.DB, 'bs-s1@example.com')).toBeNull();
      expect((await r.findUserForLogin(env.DB, 'bs-s1@example.com', 'staff'))!.passwordHash).toBe('p1');
    });

    await step('portal repo: first administrator bootstrap > never provisions a buyer or a suspended staff account', async () => {
      await user('bs-b', 'buyer', 'active', null); await user('bs-x', 'staff', 'suspended', null);
      expect(await r.provisionStaffPassword(env.DB, { userId: 'bs-b', passwordHash: 'p', timestamp: t1 })).toBe(false);
      expect(await r.provisionStaffPassword(env.DB, { userId: 'bs-x', passwordHash: 'p', timestamp: t1 })).toBe(false);
    });

    await step('portal repo: first administrator bootstrap > first admin is created only when no staff exists; a second attempt creates nothing and no audit row', async () => {
      expect(await r.countStaff(env.DB)).toBeGreaterThan(0);
      const p = { email: 'boss@example.com', displayName: 'Boss', passwordHash: 'h', timestamp: t1, requestId: 'rq' };
      await r.insertFirstAdmin(env.DB, { ...p, userId: 'fa-blocked', auditId: 'au-fa-blocked' });
      expect(await r.staffUserExists(env.DB, 'fa-blocked')).toBe(false);
      expect(await n("SELECT COUNT(*) AS n FROM audit_logs WHERE id = 'au-fa-blocked'")).toBe(0);
      await env.DB.prepare('DROP TRIGGER IF EXISTS trg_audit_logs_no_delete').run();
      await env.DB.prepare("DELETE FROM audit_logs WHERE actor_user_id IN (SELECT id FROM users WHERE user_type = 'staff')").run();
      await env.DB.prepare("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE user_type = 'staff')").run();
      await env.DB.prepare("DELETE FROM users WHERE user_type = 'staff'").run();
      expect(await r.countStaff(env.DB)).toBe(0);
      await r.insertFirstAdmin(env.DB, { ...p, userId: 'fa-1', auditId: 'au-fa-1' });
      expect(await r.staffUserExists(env.DB, 'fa-1')).toBe(true);
      expect(await env.DB.prepare("SELECT role, status FROM users WHERE id = 'fa-1'").first()).toMatchObject({ role: 'super_admin', status: 'active' });
      expect(await n("SELECT COUNT(*) AS n FROM audit_logs WHERE id = 'au-fa-1' AND action = 'staff.first_admin_bootstrapped'")).toBe(1);
      await r.insertFirstAdmin(env.DB, { ...p, email: 'two@example.com', userId: 'fa-2', auditId: 'au-fa-2' });
      expect(await r.staffUserExists(env.DB, 'fa-2')).toBe(false);
      expect(await n("SELECT COUNT(*) AS n FROM users WHERE user_type = 'staff'")).toBe(1);
    });

    await step('portal repo: buyer registration > creates invited buyer, profile with consent, public audit row and review job together', async () => {
      expect(await r.emailTaken(env.DB, 'NEW1@example.com')).toBe(false);
      await r.insertBuyerRegistration(env.DB, reg('rg1', 'new1@example.com', null, 'rj1'));
      expect(await r.emailTaken(env.DB, 'NEW1@example.com')).toBe(true);
      expect(await env.DB.prepare("SELECT status, user_type, password_hash, password_updated_at FROM users WHERE id = 'rg1'").first()).toMatchObject({ status: 'invited', user_type: 'buyer', password_hash: null, password_updated_at: null });
      expect(await env.DB.prepare("SELECT company_name, privacy_notice_version, privacy_consent_at FROM buyer_profiles WHERE user_id = 'rg1'").first()).toMatchObject({ company_name: 'Acme', privacy_notice_version: 'v-test', privacy_consent_at: t1 });
      expect(await n("SELECT COUNT(*) AS n FROM audit_logs WHERE id = 'au-rg1' AND actor_type = 'public' AND actor_user_id IS NULL")).toBe(1);
      expect(await n("SELECT COUNT(*) AS n FROM notification_jobs WHERE id = 'rj1' AND job_type = 'buyer.registration_review' AND status = 'queued'")).toBe(1);
    });

    await step('portal repo: buyer registration > stamps password_updated_at when a password is supplied, and rolls back everything on a duplicate email', async () => {
      await r.insertBuyerRegistration(env.DB, reg('rg2', 'new2@example.com', 'hash', 'rj2'));
      expect(await env.DB.prepare("SELECT password_updated_at AS p FROM users WHERE id = 'rg2'").first()).toMatchObject({ p: t1 });
      await rejected(r.insertBuyerRegistration(env.DB, reg('rg3', 'new2@example.com', null, 'rj3')));
      expect(await n("SELECT COUNT(*) AS n FROM notification_jobs WHERE id = 'rj3'")).toBe(0);
      expect(await n("SELECT COUNT(*) AS n FROM audit_logs WHERE id = 'au-rg3'")).toBe(0);
    });
  });
});








