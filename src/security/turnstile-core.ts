/**
 * Pure Turnstile verification logic (no framework imports) so it is trivially unit-testable.
 * See ./turnstile.ts for the Hono middleware that applies it to routes.
 */
import type { Env } from '../env';

export const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
export const TURNSTILE_FIELD = 'cf-turnstile-response';
export const TURNSTILE_HEADER = 'x-turnstile-token';

export type TurnstileOutcome = 'ok' | 'failed' | 'missing_token' | 'unconfigured';

export type TurnstileEnv = Pick<Env, 'APP_ENV' | 'TURNSTILE_SECRET_KEY'> & {
  TURNSTILE_ENFORCEMENT?: string;
};
type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

const isDeployed = (env: Pick<Env, 'APP_ENV'>) =>
  env.APP_ENV === 'staging' || env.APP_ENV === 'production';

/** Pure decision on whether verification is required at all and what to do when it cannot run. */
export function turnstilePolicy(env: TurnstileEnv): 'verify' | 'skip' | 'fail_closed' {
  if (env.TURNSTILE_SECRET_KEY) return 'verify';
  return isDeployed(env) ? 'fail_closed' : 'skip';
}

export async function verifyTurnstileToken(
  env: TurnstileEnv,
  token: string | undefined | null,
  remoteIp: string | undefined,
  fetcher: Fetcher = (input, init) => fetch(input, init),
): Promise<TurnstileOutcome> {
  const policy = turnstilePolicy(env);
  if (policy === 'skip') return 'ok';
  if (policy === 'fail_closed' || !env.TURNSTILE_SECRET_KEY) return 'unconfigured';
  const value = (token ?? '').trim();
  if (!value || value.length > 2048) return 'missing_token';
  const form = new FormData();
  form.set('secret', env.TURNSTILE_SECRET_KEY);
  form.set('response', value);
  if (remoteIp) form.set('remoteip', remoteIp);
  try {
    const response = await fetcher(TURNSTILE_VERIFY_URL, { method: 'POST', body: form });
    if (!response.ok) return 'failed';
    const result = (await response.json()) as { success?: boolean };
    return result.success === true ? 'ok' : 'failed';
  } catch {
    return 'failed';
  }
}

