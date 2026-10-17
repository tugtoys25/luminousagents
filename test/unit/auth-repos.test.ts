import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { setTemporaryPassword, storeResetToken } from '../../src/auth/password-repo';
import { findStaffSession, touchSession } from '../../src/auth/staff-session-repo';
import { insertStaffAudit } from '../../src/admin/repos/audit-repo';

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

const t0 = '2026-09-10T10:00:00.000Z';
const t1 = '2026-09-10T11:00:00.000Z';
const future = '2099-01-01T00:00:00.000Z';
const n = async (sql: string, ...a: string[]) => (await env.DB.prepare(sql).bind(...a).first<{ n: number }>())!.n;
const user = (id: string, type = 'staff', status = 'active', role = 'admin') =>
  env.DB.prepare('INSERT INTO users (id, email, display_name, role, user_type, status, must_change_password, failed_login_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, 3, ?, ?)')
    .bind(id, `${id}@example.com`, id, role, type, status, t0, t0).run();
const session = (id: string, userId: string, hash: string, over: { exp?: string; revoked?: string | null; type?: string } = {}) =>
  env.DB.prepare('INSERT INTO sessions (id, user_id, token_hash, session_type, expires_at, revoked_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, userId, hash, over.type ?? 'staff', over.exp ?? future, over.revoked ?? null, t0, t0).run();

describe('staff session repo', () => {
  it('runs its steps in order', async () => {
    await step('staff session repo > resolves only valid sessions of active staff, by token hash', async () => {
      await user('as1'); await user('as2', 'staff', 'suspended'); await user('as3', 'buyer');
      await session('ss1', 'as1', 'h-ok');
      await session('ss2', 'as1', 'h-expired', { exp: '2020-01-01T00:00:00.000Z' });
      await session('ss3', 'as1', 'h-revoked', { revoked: t0 });
      await session('ss4', 'as2', 'h-suspended');
      await session('ss5', 'as3', 'h-buyer');
      await session('ss6', 'as1', 'h-buyer-type', { type: 'buyer' });
      const ok = await findStaffSession(env.DB, 'h-ok', t1);
      expect(ok).toMatchObject({ id: 'as1', sessionId: 'ss1', role: 'admin', mustChange: 0, mfaAt: null, mfaEnabledAt: null });
      for (const bad of ['h-expired', 'h-revoked', 'h-suspended', 'h-buyer', 'h-buyer-type', 'unknown', '']) {
        expect(await findStaffSession(env.DB, bad, t1)).toBeNull();
      }
    });

    await step('staff session repo > reports MFA enrolment and verification state', async () => {
      await env.DB.prepare('INSERT INTO staff_mfa (user_id, secret_enc, enabled_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').bind('as1', 'x', t0, t0, t0).run();
      await env.DB.prepare('UPDATE sessions SET mfa_at = ? WHERE id = ?').bind(t0, 'ss1').run();
      expect(await findStaffSession(env.DB, 'h-ok', t1)).toMatchObject({ mfaAt: t0, mfaEnabledAt: t0 });
    });

    await step('staff session repo > touchSession updates last_seen_at only for that session', async () => {
      await touchSession(env.DB, 'ss1', t1);
      const seen = (id: string) => env.DB.prepare('SELECT last_seen_at AS s FROM sessions WHERE id = ?').bind(id).first<{ s: string | null }>();
      expect((await seen('ss1'))?.s).toBe(t1);
      expect((await seen('ss2'))?.s).not.toBe(t1);
    });

    await step('password repo > stores a hashed token, invalidates the previous one and queues an encrypted job — atomically', async () => {
      await user('pw1', 'buyer', 'active', 'buyer');
      const base = { userId: 'pw1', purpose: 'reset' as const, expiresAt: future, timestamp: t0, encryptedPayload: '{"encrypted":true}' };
      await storeResetToken(env.DB, { ...base, tokenId: 'tok-1', tokenHash: 'hash-1', jobId: 'job-1' });
      await storeResetToken(env.DB, { ...base, tokenId: 'tok-2', tokenHash: 'hash-2', jobId: 'job-2', timestamp: t1 });
      const toks = (await env.DB.prepare('SELECT id, used_at AS u, token_hash AS h FROM password_reset_tokens WHERE user_id = ? ORDER BY id').bind('pw1').all<{ id: string; u: string | null; h: string }>()).results!;
      expect(toks.map((t) => [t.id, t.u, t.h])).toEqual([['tok-1', t1, 'hash-1'], ['tok-2', null, 'hash-2']]);
      expect(await n("SELECT COUNT(*) AS n FROM notification_jobs WHERE id IN ('job-1','job-2') AND job_type = 'auth.password_reset' AND status = 'queued'")).toBe(2);
    });

    await step('password repo > rolls everything back if the job cannot be queued (duplicate job id)', async () => {
      const base = { userId: 'pw1', purpose: 'reset' as const, expiresAt: future, timestamp: t1, encryptedPayload: '{}' };
      await expect(storeResetToken(env.DB, { ...base, tokenId: 'tok-3', tokenHash: 'hash-3', jobId: 'job-1' })).rejects.toThrow();
      expect(await n("SELECT COUNT(*) AS n FROM password_reset_tokens WHERE id = 'tok-3'")).toBe(0);
      expect(await n("SELECT COUNT(*) AS n FROM password_reset_tokens WHERE id = 'tok-2' AND used_at IS NULL")).toBe(1); // still the live token
    });

    await step('password repo > temporary password forces a change, clears lockout, signs out everywhere and cancels reset links', async () => {
      await user('tp1');
      await env.DB.prepare('UPDATE users SET locked_until = ? WHERE id = ?').bind(future, 'tp1').run();
      await session('tps1', 'tp1', 'h-tp');
      await storeResetToken(env.DB, { userId: 'tp1', tokenId: 'tok-tp', tokenHash: 'hash-tp', purpose: 'reset', expiresAt: future, timestamp: t0, jobId: 'job-tp', encryptedPayload: '{}' });
      await setTemporaryPassword(env.DB, { userId: 'tp1', kind: 'staff', passwordHash: 'NEWHASH', timestamp: t1 });
      expect(await env.DB.prepare('SELECT password_hash AS h, must_change_password AS m, failed_login_count AS f, locked_until AS l FROM users WHERE id = ?').bind('tp1').first())
        .toMatchObject({ h: 'NEWHASH', m: 1, f: 0, l: null });
      expect(await findStaffSession(env.DB, 'h-tp', t1)).toBeNull(); // session revoked
      expect(await n("SELECT COUNT(*) AS n FROM password_reset_tokens WHERE id = 'tok-tp' AND used_at IS NOT NULL")).toBe(1);
    });

    await step('password repo > temporary password only applies to the matching account kind', async () => {
      await user('tp2', 'buyer', 'active', 'buyer');
      await setTemporaryPassword(env.DB, { userId: 'tp2', kind: 'staff', passwordHash: 'WRONG', timestamp: t1 });
      const row = await env.DB.prepare('SELECT password_hash AS h FROM users WHERE id = ?').bind('tp2').first<{ h: string | null }>();
      expect(row?.h).not.toBe('WRONG');
    });

    await step('staff audit insert > writes one row with the actor, request id and details', async () => {
      await insertStaffAudit(env.DB, { id: 'au-1', staffId: 'as1', action: 'x.did', entityType: 'thing', entityId: 'e1', requestId: 'rq-9', detailsJson: '{"a":1}', timestamp: t1 });
      expect(await env.DB.prepare("SELECT actor_user_id AS a, actor_type AS t, action, entity_type AS et, entity_id AS ei, request_id AS r, details_json AS d, created_at AS c FROM audit_logs WHERE id = 'au-1'").first())
        .toMatchObject({ a: 'as1', t: 'staff', action: 'x.did', et: 'thing', ei: 'e1', r: 'rq-9', d: '{"a":1}', c: t1 });
    });
  });
});




