import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('GET /healthz', () => {
  it('returns a minimal healthy response without leaking configuration', async () => {
    const response = await SELF.fetch('https://mayfair.test/healthz');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: 'ok',
      service: 'mayfair-platform',
    });
  });

  it('sets baseline security and request-correlation headers', async () => {
    const response = await SELF.fetch('https://mayfair.test/healthz');
    expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/i);
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('does not trust a malformed client-supplied request ID', async () => {
    const response = await SELF.fetch('https://mayfair.test/healthz', {
      headers: { 'x-request-id': 'x\r\nset-cookie: injected=1' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).not.toContain('set-cookie');
  });
});
