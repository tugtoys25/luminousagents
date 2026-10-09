import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('same-origin mutation guard', () => {
  it('rejects state-changing buyer requests without an Origin header', async () => {
    const response = await SELF.fetch('https://mayfair.test/api/buyer/auth/request-code', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'buyer@example.com' }),
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'ORIGIN_REQUIRED' } });
  });

  it('rejects cross-origin staff mutations before staff authorization is evaluated', async () => {
    const response = await SELF.fetch('https://mayfair.test/dashboard/tasks', {
      method: 'POST',
      headers: { origin: 'https://attacker.example', 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Injected task' }),
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'ORIGIN_FORBIDDEN' } });
  });
});
