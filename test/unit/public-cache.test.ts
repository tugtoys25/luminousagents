import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('public cache policy', () => {
  it('allows a short shared-cache TTL for the anonymous public homepage', async () => {
    const response = await SELF.fetch('https://mayfair.test/');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('s-maxage=60');
  });

  it('keeps buyer portal responses private and non-cacheable', async () => {
    const response = await SELF.fetch('https://mayfair.test/account');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('keeps APIs non-cacheable', async () => {
    const response = await SELF.fetch('https://mayfair.test/api/nonexistent');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
