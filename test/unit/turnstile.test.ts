import { describe, expect, it } from 'vitest';
import {
  TURNSTILE_VERIFY_URL,
  turnstilePolicy,
  verifyTurnstileToken,
} from '../../src/security/turnstile-core';

type Env = Parameters<typeof verifyTurnstileToken>[0];
const env = (over: Partial<Env>): Env => ({ APP_ENV: 'production', ...over }) as Env;

function fakeFetch(body: unknown, ok = true) {
  const calls: Array<{ url: string; form: FormData }> = [];
  const fetcher = async (url: string, init: RequestInit) => {
    calls.push({ url, form: init.body as FormData });
    return { ok, json: async () => body } as Response;
  };
  return { fetcher, calls };
}

describe('turnstile policy', () => {
  it('verifies whenever a secret exists', () => {
    expect(turnstilePolicy(env({ TURNSTILE_SECRET_KEY: 's' }))).toBe('verify');
    expect(turnstilePolicy(env({ APP_ENV: 'dev', TURNSTILE_SECRET_KEY: 's' }))).toBe('verify');
  });
  it('fails closed without a secret in staging and production', () => {
    expect(turnstilePolicy(env({ APP_ENV: 'production' }))).toBe('fail_closed');
    expect(turnstilePolicy(env({ APP_ENV: 'staging' }))).toBe('fail_closed');
  });
  it('only skips in dev', () => {
    expect(turnstilePolicy(env({ APP_ENV: 'dev' }))).toBe('skip');
  });
});

describe('verifyTurnstileToken', () => {
  it('returns unconfigured in production without a secret', async () => {
    expect(await verifyTurnstileToken(env({}), 'tok', '1.1.1.1')).toBe('unconfigured');
  });
  it('allows dev without a secret', async () => {
    expect(await verifyTurnstileToken(env({ APP_ENV: 'dev' }), '', undefined)).toBe('ok');
  });
  it('rejects a missing, blank or oversized token without calling Cloudflare', async () => {
    const { fetcher, calls } = fakeFetch({ success: true });
    const e = env({ TURNSTILE_SECRET_KEY: 's' });
    expect(await verifyTurnstileToken(e, undefined, undefined, fetcher)).toBe('missing_token');
    expect(await verifyTurnstileToken(e, '   ', undefined, fetcher)).toBe('missing_token');
    expect(await verifyTurnstileToken(e, 'x'.repeat(2049), undefined, fetcher)).toBe(
      'missing_token',
    );
    expect(calls).toHaveLength(0);
  });
  it('accepts only an explicit success from the siteverify endpoint', async () => {
    const e = env({ TURNSTILE_SECRET_KEY: 'secret' });
    const good = fakeFetch({ success: true });
    expect(await verifyTurnstileToken(e, 'tok', '9.9.9.9', good.fetcher)).toBe('ok');
    expect(good.calls[0]!.url).toBe(TURNSTILE_VERIFY_URL);
    expect(good.calls[0]!.form.get('secret')).toBe('secret');
    expect(good.calls[0]!.form.get('response')).toBe('tok');
    expect(good.calls[0]!.form.get('remoteip')).toBe('9.9.9.9');
    expect(await verifyTurnstileToken(e, 'tok', undefined, fakeFetch({ success: false }).fetcher)).toBe(
      'failed',
    );
    expect(await verifyTurnstileToken(e, 'tok', undefined, fakeFetch({}).fetcher)).toBe('failed');
    expect(await verifyTurnstileToken(e, 'tok', undefined, fakeFetch({ success: true }, false).fetcher)).toBe(
      'failed',
    );
  });
  it('fails closed when the verification request throws', async () => {
    const e = env({ TURNSTILE_SECRET_KEY: 'secret' });
    const boom = async () => {
      throw new Error('network');
    };
    expect(await verifyTurnstileToken(e, 'tok', undefined, boom)).toBe('failed');
  });
});
