/**
 * RFC 6238 TOTP (HMAC-SHA1, 30 s, 6 digits) and recovery-code helpers. Pure functions on WebCrypto,
 * no framework or database access, so they are cheap to test against the RFC vectors.
 */

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
const enc = new TextEncoder();

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** Accepts upper or lower case and ignores spaces, dashes and `=` padding. Throws on other characters. */
export function base32Decode(text: string): Uint8Array {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const index = BASE32.indexOf(ch);
    if (index < 0) throw new Error('Invalid base32 character');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(bytes);
}

export function generateSecret(bytes = 20): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(bytes));
}

/** RFC 4226 HOTP. `digits` is 6 in production; the RFC 6238 vectors use 8. */
export async function hotp(secret: Uint8Array, counter: number, digits = TOTP_DIGITS): Promise<string> {
  const message = new Uint8Array(8);
  const view = new DataView(message.buffer);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);
  const key = await crypto.subtle.importKey(
    'raw',
    secret,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, message));
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary =
    ((mac[offset]! & 0x7f) << 24) |
    (mac[offset + 1]! << 16) |
    (mac[offset + 2]! << 8) |
    mac[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export const totpStep = (nowMs: number) => Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export type TotpResult = { ok: true; step: number } | { ok: false };

/**
 * Accepts the current step and `window` steps either side (clock drift). A step at or below
 * `lastUsedStep` is rejected so a captured code cannot be replayed.
 */
export async function verifyTotp(
  secret: Uint8Array,
  input: string,
  nowMs: number,
  lastUsedStep: number | null = null,
  window = 1,
): Promise<TotpResult> {
  const code = input.replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) return { ok: false };
  const current = totpStep(nowMs);
  let matched: number | null = null;
  for (let step = current - window; step <= current + window; step += 1) {
    const expected = await hotp(secret, step);
    // Evaluate every candidate so timing does not reveal which step matched.
    if (constantTimeEqual(expected, code) && matched === null) matched = step;
  }
  if (matched === null) return { ok: false };
  if (lastUsedStep !== null && matched <= lastUsedStep) return { ok: false };
  return { ok: true, step: matched };
}

export function otpauthUri(issuer: string, account: string, secretBase32: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** Groups a base32 secret in fours for manual entry, e.g. `ABCD EFGH IJKL`. */
export const formatSecretForDisplay = (secretBase32: string) =>
  secretBase32.replace(/(.{4})/g, '$1 ').trim();

/* ------------------------------------------------------------ recovery codes */

// No 0/o/1/l/i, which are easy to misread when copied from paper.
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const RECOVERY_CODE_COUNT = 10;

function randomFromAlphabet(length: number): string {
  const limit = 256 - (256 % RECOVERY_ALPHABET.length); // rejection sampling avoids modulo bias
  let out = '';
  while (out.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (byte < limit && out.length < length) out += RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length];
    }
  }
  return out;
}

export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => {
    const raw = randomFromAlphabet(10);
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

export const normaliseRecoveryCode = (input: string) => input.toLowerCase().replace(/[\s-]/g, '');

/** Salted per user so identical codes for two users never share a hash. */
export async function hashRecoveryCode(userId: string, input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    enc.encode(`mayfair-mfa-recovery:${userId}:${normaliseRecoveryCode(input)}`),
  );
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
