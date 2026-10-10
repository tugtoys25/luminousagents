import type { Env } from '../env';

/**
 * Password hashing uses PBKDF2-HMAC-SHA256 through WebCrypto. Cloudflare Workers cap PBKDF2 at
 * 100,000 iterations, so that is the value used. Stored format: pbkdf2-sha256$<iterations>$<salt>$<hash>.
 */
const ITERATIONS = 100_000;
const enc = new TextEncoder();

const toB64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromB64 = (value: string) => Uint8Array.from(atob(value), (ch) => ch.charCodeAt(0));
export const toHex = (bytes: ArrayBuffer | Uint8Array) =>
  Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(password.normalize('NFKC')),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt, ITERATIONS);
  return `pbkdf2-sha256$${ITERATIONS}$${toB64(salt)}$${toB64(hash)}`;
}

export async function verifyPassword(
  password: string,
  stored: string | null | undefined,
): Promise<boolean> {
  const parts = (stored ?? '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2-sha256') return false;
  const iterations = Number.parseInt(parts[1]!, 10);
  if (!Number.isInteger(iterations) || iterations < 10_000 || iterations > 1_000_000) return false;
  let expected: Uint8Array;
  let actual: Uint8Array;
  try {
    expected = fromB64(parts[3]!);
    actual = await derive(password, fromB64(parts[2]!), iterations);
  } catch {
    return false;
  }
  if (expected.length !== actual.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected[i]! ^ actual[i]!;
  return diff === 0;
}

/** Burn comparable CPU time when the account does not exist, so response time does not reveal valid emails. */
export async function dummyVerify(password: string): Promise<void> {
  await derive(password, new Uint8Array(16), ITERATIONS);
}

const COMMON = new Set([
  'password1234',
  'password12345',
  'qwerty123456',
  '123456789012',
  'letmein12345',
  'welcome12345',
  'mayfair12345',
]);

/** Returns an error message, or null when the password is acceptable. */
export function passwordPolicyError(password: string, email = ''): string | null {
  if (password.length < 12) return 'Use at least 12 characters.';
  if (password.length > 200) return 'Use no more than 200 characters.';
  if (COMMON.has(password.toLowerCase())) return 'That password is too common.';
  if (/^(.)\1+$/.test(password)) return 'Choose a less repetitive password.';
  const local = email.split('@')[0]?.toLowerCase() ?? '';
  if (local.length >= 4 && password.toLowerCase().includes(local))
    return 'Do not include your email name in your password.';
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password))
    return 'Include both letters and numbers.';
  return null;
}

export async function sha256Hex(value: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(value)));
}

export const randomToken = (bytes = 32) => toHex(crypto.getRandomValues(new Uint8Array(bytes)));

/** True when a stored hash uses a different cost than the current one and should be upgraded after a successful login. */
export function needsRehash(stored: string | null | undefined): boolean {
  const parts = (stored ?? '').split('$');
  return parts.length === 4 && Number.parseInt(parts[1]!, 10) !== ITERATIONS;
}

export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MINUTES = 15;
export const RESET_TOKEN_MINUTES = 60;

export function readCookie(header: string | undefined, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=') || null;
  }
  return null;
}

export function sessionCookie(
  name: string,
  token: string,
  maxAgeSeconds: number,
  path = '/',
): string {
  return `${name}=${token}; Path=${path}; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

/** Encrypts a notification payload with OTP_ENCRYPTION_KEY (AES-GCM) so reset links are not stored in clear text. */
export async function encryptPayload(value: string, secret: string): Promise<string> {
  let raw: Uint8Array;
  try {
    raw = fromB64(secret);
  } catch {
    throw new Error('Invalid OTP encryption key configuration');
  }
  if (raw.byteLength !== 32) throw new Error('Invalid OTP encryption key configuration');
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(value));
  return JSON.stringify({
    encrypted: true,
    algorithm: 'AES-GCM',
    iv: toB64(iv),
    ciphertext: toB64(new Uint8Array(ciphertext)),
  });
}

export type AuthEnv = Pick<Env, 'DB' | 'CACHE' | 'NOTIFICATIONS_QUEUE' | 'OTP_ENCRYPTION_KEY'>;

/**
 * Creates a single-use reset/invite token and queues the email. Returns the raw token only so callers
 * and tests can verify behaviour; it is never returned over HTTP.
 */
export async function issueResetToken(
  env: AuthEnv,
  user: { id: string; email: string },
  purpose: 'reset' | 'invite',
  kind: 'staff' | 'buyer',
): Promise<string | null> {
  if (!env.OTP_ENCRYPTION_KEY) return null;
  const timestamp = new Date().toISOString();
  const token = randomToken(32);
  const jobId = crypto.randomUUID();
  const minutes = purpose === 'invite' ? 60 * 24 * 3 : RESET_TOKEN_MINUTES;
  await env.DB.batch([
    env.DB.prepare(
      'UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL',
    ).bind(timestamp, user.id),
    env.DB.prepare(
      'INSERT INTO password_reset_tokens (id, user_id, token_hash, purpose, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(
      crypto.randomUUID(),
      user.id,
      await sha256Hex(token),
      purpose,
      new Date(Date.now() + minutes * 60_000).toISOString(),
      timestamp,
    ),
    env.DB.prepare(
      "INSERT INTO notification_jobs (id, job_type, payload_json, status, attempts, available_at, created_at, updated_at) VALUES (?, 'auth.password_reset', ?, 'queued', 0, ?, ?, ?)",
    ).bind(
      jobId,
      await encryptPayload(
        JSON.stringify({ email: user.email, token, purpose, kind, expiresInMinutes: minutes }),
        env.OTP_ENCRYPTION_KEY,
      ),
      timestamp,
      timestamp,
      timestamp,
    ),
  ]);
  try {
    await env.NOTIFICATIONS_QUEUE.send({ type: 'auth.password_reset', jobId });
  } catch {
    /* durable job remains queued for scheduled recovery */
  }
  return token;
}
