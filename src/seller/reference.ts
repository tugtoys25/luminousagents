/** Public enquiry reference: CM-S- plus 6 characters from an unambiguous 32-symbol alphabet (CSPRNG, no modulo bias). */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const REFERENCE_PATTERN = /^CM-S-[A-HJ-NP-Z2-9]{6}$/;

export function generateReference(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let out = '';
  for (const b of bytes) out += ALPHABET[b & 31];
  return `CM-S-${out}`;
}

export async function keyedHash(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
