import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  hashRecoveryCode,
  hotp,
  normaliseRecoveryCode,
  otpauthUri,
  totpStep,
  verifyTotp,
} from '../../src/auth/totp';

const ascii = (text: string) => new TextEncoder().encode(text);
// RFC 4226 / RFC 6238 test secret: the ASCII string "12345678901234567890".
const RFC_SECRET = ascii('12345678901234567890');

describe('base32', () => {
  it('round-trips and matches RFC 4648 vectors', () => {
    expect(base32Encode(ascii('foobar'))).toBe('MZXW6YTBOI');
    expect(new TextDecoder().decode(base32Decode('MZXW6YTBOI======'))).toBe('foobar');
    expect(new TextDecoder().decode(base32Decode('mzxw 6ytb-oi'))).toBe('foobar');
    const bytes = crypto.getRandomValues(new Uint8Array(20));
    expect(Array.from(base32Decode(base32Encode(bytes)))).toEqual(Array.from(bytes));
  });
  it('rejects invalid characters', () => {
    expect(() => base32Decode('MZXW1!')).toThrow();
  });
});

describe('hotp (RFC 4226 appendix D)', () => {
  it('produces the published values', async () => {
    const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    for (let counter = 0; counter < expected.length; counter += 1)
      expect(await hotp(RFC_SECRET, counter)).toBe(expected[counter]);
  });
});

describe('totp (RFC 6238 appendix B, SHA-1)', () => {
  it('matches the 8-digit vectors', async () => {
    expect(await hotp(RFC_SECRET, totpStep(59_000), 8)).toBe('94287082');
    expect(await hotp(RFC_SECRET, totpStep(1_111_111_109_000), 8)).toBe('07081804');
    expect(await hotp(RFC_SECRET, totpStep(2_000_000_000_000), 8)).toBe('69279037');
  });
});

describe('verifyTotp', () => {
  const now = 1_700_000_000_000;
  it('accepts the current code and one step of drift either way', async () => {
    const step = totpStep(now);
    for (const offset of [-1, 0, 1]) {
      const code = await hotp(RFC_SECRET, step + offset);
      expect(await verifyTotp(RFC_SECRET, code, now)).toEqual({ ok: true, step: step + offset });
    }
  });
  it('rejects codes outside the window, malformed codes and wrong codes', async () => {
    const step = totpStep(now);
    expect((await verifyTotp(RFC_SECRET, await hotp(RFC_SECRET, step + 2), now)).ok).toBe(false);
    expect((await verifyTotp(RFC_SECRET, await hotp(RFC_SECRET, step - 2), now)).ok).toBe(false);
    expect((await verifyTotp(RFC_SECRET, '12345', now)).ok).toBe(false);
    expect((await verifyTotp(RFC_SECRET, 'abcdef', now)).ok).toBe(false);
  });
  it('tolerates spaces typed into the code', async () => {
    const code = await hotp(RFC_SECRET, totpStep(now));
    expect((await verifyTotp(RFC_SECRET, `${code.slice(0, 3)} ${code.slice(3)}`, now)).ok).toBe(true);
  });
  it('rejects replay of a step that was already used', async () => {
    const step = totpStep(now);
    const code = await hotp(RFC_SECRET, step);
    expect((await verifyTotp(RFC_SECRET, code, now, step)).ok).toBe(false);
    expect((await verifyTotp(RFC_SECRET, code, now, step - 1)).ok).toBe(true);
    // An earlier-step code is also refused once a later step has been used.
    const older = await hotp(RFC_SECRET, step - 1);
    expect((await verifyTotp(RFC_SECRET, older, now, step)).ok).toBe(false);
  });
});

describe('otpauth URI', () => {
  it('encodes issuer, account and parameters', () => {
    const uri = otpauthUri('Casinos of Mayfair', 'a.b@example.com', 'ABCDEFGH');
    expect(uri).toContain('otpauth://totp/Casinos%20of%20Mayfair:a.b%40example.com?');
    expect(uri).toContain('secret=ABCDEFGH');
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
  });
});

describe('recovery codes', () => {
  it('generates unique, well-formed codes', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[a-hjkmnp-z2-9]{5}-[a-hjkmnp-z2-9]{5}$/);
  });
  it('normalises input and hashes per user', async () => {
    expect(normaliseRecoveryCode(' ABCDE-fghjk ')).toBe('abcdefghjk');
    const a = await hashRecoveryCode('user-1', 'abcde-fghjk');
    expect(a).toBe(await hashRecoveryCode('user-1', 'ABCDE FGHJK'));
    expect(a).not.toBe(await hashRecoveryCode('user-2', 'abcde-fghjk'));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
