import { describe, expect, it } from 'vitest';
import { fieldErrors, normaliseSellerEnquiry, sellerEnquirySchema } from '../../src/seller/schema';
import { valid } from '../support/seller-fixtures';
import { REFERENCE_PATTERN, generateReference, keyedHash } from '../../src/seller/reference';

const parse = (over: Record<string, unknown> = {}) => sellerEnquirySchema.safeParse({ ...valid(), ...over });

describe('sellerEnquirySchema', () => {
  it('accepts a valid submission and trims/normalises', () => {
    const r = parse();
    expect(r.success).toBe(true);
    if (r.success) {
      const n = normaliseSellerEnquiry(r.data, false);
      expect(n.email).toBe('jane@example.com');
      expect(n.contact_country).toBe('GB');
      expect(n.marketing_consent).toBe(false);
    }
  });
  it.each(['contact_name', 'contact_role', 'email', 'asset_description', 'sale_timing', 'idempotency_key', 'asset_name_confidential'])('requires %s', (field) => {
    const body: Record<string, unknown> = valid();
    delete body[field];
    expect(sellerEnquirySchema.safeParse(body).success).toBe(false);
  });
  it('rejects invalid email, overlong and short fields, bad enums and countries', () => {
    expect(parse({ email: 'not-an-email' }).success).toBe(false);
    expect(parse({ email: `${'a'.repeat(250)}@x.com` }).success).toBe(false);
    expect(parse({ contact_name: 'J' }).success).toBe(false);
    expect(parse({ contact_name: 'x'.repeat(121) }).success).toBe(false);
    expect(parse({ asset_description: 'too short' }).success).toBe(false);
    expect(parse({ asset_description: 'x'.repeat(2001) }).success).toBe(false);
    expect(parse({ contact_role: 'CEO' }).success).toBe(false);
    expect(parse({ asset_country: 'ZZ' }).success).toBe(false);
  });
  it('requires acknowledgements and does not require marketing consent', () => {
    expect(parse({ privacy_acknowledged: false }).success).toBe(false);
    expect(parse({ accuracy_declared: undefined }).success).toBe(false);
    expect(parse({ marketing_consent: undefined }).success).toBe(true);
  });
  it('enforces conditional OTHER fields', () => {
    expect(parse({ contact_role: 'OTHER' }).success).toBe(false);
    expect(parse({ contact_role: 'OTHER', contact_role_other: 'ab' }).success).toBe(false);
    expect(parse({ contact_role: 'OTHER', contact_role_other: 'Trustee' }).success).toBe(true);
    expect(parse({ asset_type: 'OTHER_RELATED_INVESTMENT' }).success).toBe(false);
    expect(parse({ asset_type: 'OTHER_RELATED_INVESTMENT', asset_type_other: 'Gaming licence' }).success).toBe(true);
  });
  it('enforces currency only when an asking price is given', () => {
    expect(parse({ asking_price_text: '€10m' }).success).toBe(false);
    expect(parse({ asking_price_text: '10m', currency: 'OTHER' }).success).toBe(false);
    expect(parse({ asking_price_text: '10m', currency: 'OTHER', currency_other: 'SEK' }).success).toBe(true);
    const r = parse({ currency: 'USD', currency_other: 'x' });
    expect(r.success).toBe(true);
    if (r.success) {
      const n = normaliseSellerEnquiry(r.data, false);
      expect(n.currency).toBeNull();
      expect(n.currency_other).toBeNull();
    }
  });
  it('rejects control characters / header injection in single-line fields but keeps newlines in text areas', () => {
    expect(parse({ contact_name: 'Jane\r\nBcc: x@evil.com' }).success).toBe(false);
    expect(parse({ organisation: 'Co\nLtd' }).success).toBe(false);
    expect(parse({ email: 'a@b.com\r\nBcc: x@y.com' }).success).toBe(false);
    expect(parse({ asset_description: `${'line one '.repeat(5)}\nline two` }).success).toBe(true);
    expect(parse({ asset_description: `${'x'.repeat(40)}\u0000` }).success).toBe(false);
  });
  it('treats HTML as plain text (stored verbatim, never interpreted)', () => {
    const r = parse({ contact_name: '<script>alert(1)</script>' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.contact_name).toBe('<script>alert(1)</script>');
  });
  it('accepts international telephone formats and rejects junk', () => {
    expect(parse({ telephone: '+44 (0)20 7946 0958' }).success).toBe(true);
    expect(parse({ telephone: '+971-4-123-4567 ext 12' }).success).toBe(false);
    expect(parse({ telephone: '+971-4-123-4567 x12' }).success).toBe(true);
    expect(parse({ telephone: 'call me' }).success).toBe(false);
    expect(parse({ telephone: '' }).success).toBe(true);
  });
  it('drops marketing consent unless the feature is enabled', () => {
    const r = parse({ marketing_consent: true });
    if (!r.success) throw new Error('expected success');
    expect(normaliseSellerEnquiry(r.data, false).marketing_consent).toBe(false);
    expect(normaliseSellerEnquiry(r.data, true).marketing_consent).toBe(true);
  });
  it('strips client-supplied internal fields', () => {
    const r = parse({ status: 'CONVERTED', assigned_to: 'u1', id: 'x', created_at: '2000-01-01' });
    expect(r.success).toBe(true);
    if (r.success) expect(Object.keys(r.data)).not.toEqual(expect.arrayContaining(['status', 'assigned_to', 'id', 'created_at']));
  });
  it('field errors never echo input', () => {
    const r = parse({ contact_name: 'S3CRET\nX' });
    if (r.success) throw new Error('expected failure');
    expect(JSON.stringify(fieldErrors(r.error))).not.toContain('S3CRET');
  });
});

describe('reference and hashing', () => {
  it('generates non-sequential references in the documented format', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const ref = generateReference();
      expect(ref).toMatch(REFERENCE_PATTERN);
      seen.add(ref);
    }
    expect(seen.size).toBeGreaterThan(495);
  });
  it('keyedHash is deterministic per secret and differs across secrets', async () => {
    expect(await keyedHash('a', 'v')).toBe(await keyedHash('a', 'v'));
    expect(await keyedHash('a', 'v')).not.toBe(await keyedHash('b', 'v'));
    expect(await keyedHash('a', 'v')).toMatch(/^[0-9a-f]{64}$/);
  });
});
