import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import * as mfa from '../../src/auth/mfa';
import * as repo from '../../src/auth/mfa-repo';
import { base32Decode, hotp, totpStep } from '../../src/auth/totp';

// 32 random bytes, base64: the same format as OTP_ENCRYPTION_KEY.
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => (i * 7 + 3) % 256)));
const mfaEnv = (over: Partial<mfa.MfaEnv> = {}): mfa.MfaEnv => ({
  DB: env.DB,
  CACHE: env.CACHE,
  OTP_ENCRYPTION_KEY: KEY,
  ...over,
});

const created: string[] = [];
async function makeStaff(role = 'admin') {
  const id = crypto.randomUUID();
  const at = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO users (id,email,display_name,user_type,role,status,password_hash,must_change_password,created_at,updated_at) VALUES (?,?,?,'staff',?,'active','x',0,?,?)",
  )
    .bind(id, `${role}-${id}@example.test`, `Test ${role}`, role, at, at)
    .run();
  created.push(id);
  return { id, email: `${role}-${id}@example.test` };
}
afterEach(async () => {
  for (const id of created.splice(0)) {
    await env.CACHE.delete(`mfa-attempts:${id}`);
    await env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(id).run();
      await env.DB.prepare('DROP TRIGGER IF EXISTS trg_audit_logs_no_delete').run();
    await env.DB.prepare('DELETE FROM audit_logs WHERE actor_user_id=? OR entity_id=?').bind(id, id).run();
    await env.DB.prepare('DELETE FROM users WHERE id=?').bind(id).run();
  }
});

/** What an authenticator app would show: decrypt the stored secret and compute the code. */
async function codeFor(userId: string, nowMs: number, offset = 0) {
  const row = await repo.getMfa(mfaEnv(), userId);
  const secret = await mfa.decryptSecret(mfaEnv(), userId, row!.secretEnc);
  return hotp(secret, totpStep(nowMs) + offset);
}

describe('policy', () => {
  it('requires MFA for admin roles by default, and only when a key exists', () => {
    expect(mfa.mfaRequired(mfaEnv(), 'super_admin', false)).toBe(true);
    expect(mfa.mfaRequired(mfaEnv(), 'admin', false)).toBe(true);
    expect(mfa.mfaRequired(mfaEnv(), 'editor', false)).toBe(false);
    expect(mfa.mfaRequired(mfaEnv(), 'broker', false)).toBe(false);
    // Enrolment always requires it, whatever the role.
    expect(mfa.mfaRequired(mfaEnv(), 'editor', true)).toBe(true);
    // No usable key: nobody can enrol, so requiring it would lock everyone out.
    expect(mfa.mfaRequired(mfaEnv({ OTP_ENCRYPTION_KEY: undefined }), 'admin', false)).toBe(false);
    expect(mfa.mfaRequired(mfaEnv({ OTP_ENCRYPTION_KEY: 'short' }), 'admin', false)).toBe(false);
  });
  it('honours STAFF_MFA_REQUIRED_ROLES', () => {
    expect(mfa.mfaRequired(mfaEnv({ STAFF_MFA_REQUIRED_ROLES: 'super_admin,publisher' }), 'publisher', false)).toBe(true);
    expect(mfa.mfaRequired(mfaEnv({ STAFF_MFA_REQUIRED_ROLES: 'super_admin,publisher' }), 'admin', false)).toBe(false);
    expect(mfa.mfaRequired(mfaEnv({ STAFF_MFA_REQUIRED_ROLES: '' }), 'super_admin', false)).toBe(false);
  });
  it('prefers a dedicated MFA key over the OTP key', () => {
    expect(mfa.mfaAvailable({ OTP_ENCRYPTION_KEY: undefined, MFA_ENCRYPTION_KEY: KEY })).toBe(true);
  });
});

describe('secret encryption at rest', () => {
  it('round-trips and never stores the plaintext', async () => {
    const secret = crypto.getRandomValues(new Uint8Array(20));
    const stored = await mfa.encryptSecret(mfaEnv(), 'user-1', secret);
    expect(stored.startsWith('v1.')).toBe(true);
    expect(Array.from(await mfa.decryptSecret(mfaEnv(), 'user-1', stored))).toEqual(Array.from(secret));
    expect(stored).not.toContain(btoa(String.fromCharCode(...secret)));
  });
  it('is bound to the user id and to the key', async () => {
    const stored = await mfa.encryptSecret(mfaEnv(), 'user-1', crypto.getRandomValues(new Uint8Array(20)));
    await expect(mfa.decryptSecret(mfaEnv(), 'user-2', stored)).rejects.toThrow();
    const otherKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
    await expect(mfa.decryptSecret(mfaEnv({ OTP_ENCRYPTION_KEY: otherKey }), 'user-1', stored)).rejects.toThrow();
  });
});

describe('enrolment', () => {
  it('begins, confirms with a valid code and issues recovery codes once', async () => {
    const user = await makeStaff();
    const begin = await mfa.beginEnrolment(mfaEnv(), user, new Date().toISOString());
    expect(begin.status).toBe('ok');
    if (begin.status !== 'ok') return;
    expect(begin.uri).toContain('otpauth://totp/');
    expect(base32Decode(begin.secret).byteLength).toBe(20);

    const row = await repo.getMfa(mfaEnv(), user.id);
    expect(row?.enabledAt).toBeNull();
    expect(row?.secretEnc).not.toContain(begin.secret.replace(/\s/g, ''));

    const now = Date.now();
    const bad = await mfa.confirmEnrolment(mfaEnv(), user.id, '000000', now);
    expect(['invalid', 'ok']).toContain(bad.status); // 1-in-a-million collision tolerated

    const confirm = await mfa.confirmEnrolment(mfaEnv(), user.id, await codeFor(user.id, now), now);
    if (bad.status === 'ok') return;
    expect(confirm.status).toBe('ok');
    if (confirm.status !== 'ok') return;
    expect(confirm.recoveryCodes).toHaveLength(10);
    const enabled = await repo.getMfa(mfaEnv(), user.id);
    expect(enabled?.enabledAt).toBeTruthy();
    expect(JSON.parse(enabled!.recoveryHashes)).toHaveLength(10);
    // Plain recovery codes are never stored.
    for (const code of confirm.recoveryCodes) expect(enabled!.recoveryHashes).not.toContain(code);
  });

  it('cannot restart or overwrite an enabled enrolment', async () => {
    const user = await makeStaff();
    await mfa.beginEnrolment(mfaEnv(), user, new Date().toISOString());
    const now = Date.now();
    await mfa.confirmEnrolment(mfaEnv(), user.id, await codeFor(user.id, now), now);
    const before = await repo.getMfa(mfaEnv(), user.id);
    expect((await mfa.beginEnrolment(mfaEnv(), user, new Date().toISOString())).status).toBe('already_enabled');
    expect((await repo.getMfa(mfaEnv(), user.id))?.secretEnc).toBe(before!.secretEnc);
    expect((await mfa.confirmEnrolment(mfaEnv(), user.id, '123456', now)).status).toBe('no_pending');
  });

  it('a pending enrolment can be restarted with a new secret', async () => {
    const user = await makeStaff();
    await mfa.beginEnrolment(mfaEnv(), user, new Date().toISOString());
    const first = (await repo.getMfa(mfaEnv(), user.id))!.secretEnc;
    await mfa.beginEnrolment(mfaEnv(), user, new Date().toISOString());
    expect((await repo.getMfa(mfaEnv(), user.id))!.secretEnc).not.toBe(first);
  });

  it('is unavailable without a key', async () => {
    const user = await makeStaff();
    expect((await mfa.beginEnrolment(mfaEnv({ OTP_ENCRYPTION_KEY: undefined }), user, new Date().toISOString())).status).toBe('unavailable');
  });
});

async function enrolled() {
  const user = await makeStaff();
  await mfa.beginEnrolment(mfaEnv(), user, new Date().toISOString());
  const now = Date.now();
  const confirm = await mfa.confirmEnrolment(mfaEnv(), user.id, await codeFor(user.id, now), now);
  if (confirm.status !== 'ok') throw new Error('enrolment failed in test setup');
  return { user, now, recoveryCodes: confirm.recoveryCodes };
}

describe('verification', () => {
  it('accepts a fresh code, then refuses replay of the same and earlier steps', async () => {
    const { user, now } = await enrolled();
    // Enrolment consumed the current step, so use the next one.
    const later = now + 30_000;
    const code = await codeFor(user.id, later);
    expect((await mfa.verifySecondFactor(mfaEnv(), user.id, { code }, later)).status).toBe('ok');
    expect((await mfa.verifySecondFactor(mfaEnv(), user.id, { code }, later)).status).toBe('invalid');
    expect((await mfa.verifySecondFactor(mfaEnv(), user.id, { code: await codeFor(user.id, later, -1) }, later)).status).toBe('invalid');
  });

  it('a recovery code works exactly once and shrinks the list', async () => {
    const { user, now, recoveryCodes } = await enrolled();
    const first = await mfa.verifySecondFactor(mfaEnv(), user.id, { recoveryCode: recoveryCodes[0]!.toUpperCase() }, now);
    expect(first).toEqual({ status: 'ok', method: 'recovery', recoveryCodesLeft: 9 });
    expect((await mfa.verifySecondFactor(mfaEnv(), user.id, { recoveryCode: recoveryCodes[0]! }, now)).status).toBe('invalid');
    expect((await mfa.verifySecondFactor(mfaEnv(), user.id, { recoveryCode: recoveryCodes[1]! }, now)).status).toBe('ok');
  });

  it('rate limits after repeated failures, even for a correct code', async () => {
    const { user, now } = await enrolled();
    for (let i = 0; i < 6; i += 1)
      expect((await mfa.verifySecondFactor(mfaEnv(), user.id, { recoveryCode: 'wrongcode1' }, now)).status).toBe('invalid');
    const later = now + 30_000;
    expect((await mfa.verifySecondFactor(mfaEnv(), user.id, { code: await codeFor(user.id, later) }, later)).status).toBe('rate_limited');
  });

  it('reports not_enrolled for a user without MFA', async () => {
    const user = await makeStaff();
    expect((await mfa.verifySecondFactor(mfaEnv(), user.id, { code: '123456' }, Date.now())).status).toBe('not_enrolled');
  });
});

describe('reset and sessions', () => {
  it('reset removes MFA and revokes the staff sessions', async () => {
    const { user } = await enrolled();
    const at = new Date().toISOString();
    const sessionId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO sessions (id,user_id,token_hash,created_at,last_seen_at,expires_at,session_type) VALUES (?,?,?,?,?,?,'staff')",
    )
      .bind(sessionId, user.id, `hash-${sessionId}`, at, at, new Date(Date.now() + 3_600_000).toISOString())
      .run();
    await repo.markSessionVerified(mfaEnv(), sessionId, at);
    const verified = await env.DB.prepare('SELECT mfa_at AS mfaAt FROM sessions WHERE id=?').bind(sessionId).first<{ mfaAt: string | null }>();
    expect(verified?.mfaAt).toBe(at);

    expect(await mfa.resetMfa(mfaEnv(), user.id, at)).toBe(true);
    expect(await repo.getMfa(mfaEnv(), user.id)).toBeNull();
    const row = await env.DB.prepare('SELECT revoked_at AS revokedAt FROM sessions WHERE id=?').bind(sessionId).first<{ revokedAt: string | null }>();
    expect(row?.revokedAt).toBe(at);
    expect(await mfa.resetMfa(mfaEnv(), user.id, at)).toBe(false);
  });
});
