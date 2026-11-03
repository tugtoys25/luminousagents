/**
 * Staff MFA service: policy, secret encryption at rest, enrolment and verification.
 * Routes call this; this calls ./mfa-repo.ts. No HTTP and no SQL here.
 */
import {
  RECOVERY_CODE_COUNT,
  base32Encode,
  formatSecretForDisplay,
  generateRecoveryCodes,
  generateSecret,
  hashRecoveryCode,
  otpauthUri,
  verifyTotp,
} from './totp';
import * as repo from './mfa-repo';
import type { MfaDb } from './mfa-repo';

export const MFA_ISSUER = 'Luminous Agents';
const DEFAULT_REQUIRED_ROLES = ['super_admin', 'admin', 'compliance'];
const ATTEMPT_LIMIT = 6;
const ATTEMPT_WINDOW_SECONDS = 600;

export interface MfaEnv extends MfaDb {
  CACHE: KVNamespace;
  OTP_ENCRYPTION_KEY?: string | undefined;
  MFA_ENCRYPTION_KEY?: string | undefined;
  STAFF_MFA_REQUIRED_ROLES?: string | undefined;
}

const enc = new TextEncoder();
const toB64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromB64 = (value: string) => Uint8Array.from(atob(value), (ch) => ch.charCodeAt(0));

/* ------------------------------------------------------------------- policy */

/** Roles that must use MFA. `STAFF_MFA_REQUIRED_ROLES` overrides (comma list; empty string = none). */
export function requiredRoles(env: Pick<MfaEnv, 'STAFF_MFA_REQUIRED_ROLES'>): Set<string> {
  const raw = env.STAFF_MFA_REQUIRED_ROLES;
  if (raw === undefined) return new Set(DEFAULT_REQUIRED_ROLES);
  return new Set(
    raw
      .split(',')
      .map((role) => role.trim())
      .filter(Boolean),
  );
}

function keyBytes(env: Pick<MfaEnv, 'OTP_ENCRYPTION_KEY' | 'MFA_ENCRYPTION_KEY'>): Uint8Array | null {
  const value = env.MFA_ENCRYPTION_KEY || env.OTP_ENCRYPTION_KEY;
  if (!value) return null;
  try {
    const bytes = fromB64(value);
    return bytes.byteLength === 32 ? bytes : null;
  } catch {
    return null;
  }
}

/** True when a valid 32-byte base64 key exists, so secrets can be encrypted and decrypted. */
export const mfaAvailable = (env: Pick<MfaEnv, 'OTP_ENCRYPTION_KEY' | 'MFA_ENCRYPTION_KEY'>) =>
  keyBytes(env) !== null;

/**
 * MFA is required once a user has enrolled, and for the configured roles when the service can
 * actually store secrets. Without a key we cannot enrol anyone, so requiring MFA would lock every
 * administrator out; that state is reported by the readiness check instead of by a lockout.
 */
export function mfaRequired(
  env: Pick<MfaEnv, 'OTP_ENCRYPTION_KEY' | 'MFA_ENCRYPTION_KEY' | 'STAFF_MFA_REQUIRED_ROLES'>,
  role: string,
  enrolled: boolean,
): boolean {
  if (enrolled) return true;
  return mfaAvailable(env) && requiredRoles(env).has(role);
}

/* -------------------------------------------------------- secret encryption */

async function aesKey(env: MfaEnv, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  const raw = keyBytes(env);
  if (!raw) throw new Error('MFA encryption key is not configured');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, [usage]);
}

/** Output format `v1.<iv>.<ciphertext>`; the user id is bound in as additional authenticated data. */
export async function encryptSecret(env: MfaEnv, userId: string, secret: Uint8Array): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(`staff-mfa:${userId}`) },
    await aesKey(env, 'encrypt'),
    secret,
  );
  return `v1.${toB64(iv)}.${toB64(new Uint8Array(ciphertext))}`;
}

export async function decryptSecret(env: MfaEnv, userId: string, stored: string): Promise<Uint8Array> {
  const [version, iv, ciphertext] = stored.split('.');
  if (version !== 'v1' || !iv || !ciphertext) throw new Error('Unsupported MFA secret format');
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64(iv), additionalData: enc.encode(`staff-mfa:${userId}`) },
    await aesKey(env, 'decrypt'),
    fromB64(ciphertext),
  );
  return new Uint8Array(plain);
}

/* ------------------------------------------------------------ attempt limit */

const attemptKey = (userId: string) => `mfa-attempts:${userId}`;
async function attempts(env: MfaEnv, userId: string): Promise<number> {
  return Number.parseInt((await env.CACHE.get(attemptKey(userId))) ?? '0', 10) || 0;
}
async function recordFailure(env: MfaEnv, userId: string): Promise<void> {
  await env.CACHE.put(attemptKey(userId), String((await attempts(env, userId)) + 1), {
    expirationTtl: ATTEMPT_WINDOW_SECONDS,
  });
}
const clearFailures = (env: MfaEnv, userId: string) => env.CACHE.delete(attemptKey(userId));

/* ---------------------------------------------------------------- enrolment */

export type BeginResult =
  | { status: 'ok'; secret: string; uri: string }
  | { status: 'already_enabled' }
  | { status: 'unavailable' };

export async function beginEnrolment(
  env: MfaEnv,
  user: { id: string; email: string },
  nowIso: string,
): Promise<BeginResult> {
  if (!mfaAvailable(env)) return { status: 'unavailable' };
  const existing = await repo.getMfa(env, user.id);
  if (existing?.enabledAt) return { status: 'already_enabled' };
  const secret = generateSecret();
  const saved = await repo.savePendingSecret(env, user.id, await encryptSecret(env, user.id, secret), nowIso);
  if (!saved) return { status: 'already_enabled' };
  const encoded = base32Encode(secret);
  return {
    status: 'ok',
    secret: formatSecretForDisplay(encoded),
    uri: otpauthUri(MFA_ISSUER, user.email, encoded),
  };
}

export type ConfirmResult =
  | { status: 'ok'; recoveryCodes: string[] }
  | { status: 'no_pending' }
  | { status: 'invalid' }
  | { status: 'rate_limited' }
  | { status: 'unavailable' };

export async function confirmEnrolment(
  env: MfaEnv,
  userId: string,
  code: string,
  nowMs: number,
): Promise<ConfirmResult> {
  if (!mfaAvailable(env)) return { status: 'unavailable' };
  if ((await attempts(env, userId)) >= ATTEMPT_LIMIT) return { status: 'rate_limited' };
  const row = await repo.getMfa(env, userId);
  if (!row || row.enabledAt) return { status: 'no_pending' };
  const result = await verifyTotp(await decryptSecret(env, userId, row.secretEnc), code, nowMs, null);
  if (!result.ok) {
    await recordFailure(env, userId);
    return { status: 'invalid' };
  }
  const recoveryCodes = generateRecoveryCodes(RECOVERY_CODE_COUNT);
  const hashes = await Promise.all(recoveryCodes.map((value) => hashRecoveryCode(userId, value)));
  const ok = await repo.activate(env, userId, result.step, hashes, new Date(nowMs).toISOString());
  if (!ok) return { status: 'no_pending' };
  await clearFailures(env, userId);
  return { status: 'ok', recoveryCodes };
}

/* ------------------------------------------------------------- verification */

export type VerifyResult =
  | { status: 'ok'; method: 'totp'; recoveryCodesLeft?: undefined }
  | { status: 'ok'; method: 'recovery'; recoveryCodesLeft: number }
  | { status: 'invalid' }
  | { status: 'rate_limited' }
  | { status: 'not_enrolled' };

export async function verifySecondFactor(
  env: MfaEnv,
  userId: string,
  input: { code?: string | undefined; recoveryCode?: string | undefined },
  nowMs: number,
): Promise<VerifyResult> {
  const row = await repo.getMfa(env, userId);
  if (!row?.enabledAt) return { status: 'not_enrolled' };
  if ((await attempts(env, userId)) >= ATTEMPT_LIMIT) return { status: 'rate_limited' };
  const at = new Date(nowMs).toISOString();

  if (input.code) {
    const result = await verifyTotp(
      await decryptSecret(env, userId, row.secretEnc),
      input.code,
      nowMs,
      row.lastUsedStep,
    );
    if (result.ok && (await repo.advanceStep(env, userId, result.step, at))) {
      await clearFailures(env, userId);
      return { status: 'ok', method: 'totp' };
    }
  } else if (input.recoveryCode) {
    const hash = await hashRecoveryCode(userId, input.recoveryCode);
    const hashes = JSON.parse(row.recoveryHashes) as string[];
    if (hashes.includes(hash)) {
      const remaining = hashes.filter((value) => value !== hash);
      if (await repo.replaceRecoveryHashes(env, userId, row.recoveryHashes, remaining, at)) {
        await clearFailures(env, userId);
        return { status: 'ok', method: 'recovery', recoveryCodesLeft: remaining.length };
      }
    }
  }
  await recordFailure(env, userId);
  return { status: 'invalid' };
}

/** Admin recovery: remove a user's MFA and sign them out everywhere. They must enrol again. */
export async function resetMfa(env: MfaEnv, userId: string, nowIso: string): Promise<boolean> {
  const removed = await repo.deleteMfa(env, userId);
  await repo.revokeStaffSessions(env, userId, nowIso);
  await clearFailures(env, userId);
  return removed;
}

