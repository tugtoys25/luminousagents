import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import type { Env } from '../env';
import {
  TURNSTILE_FIELD,
  TURNSTILE_HEADER,
  verifyTurnstileToken,
  type TurnstileEnv,
  type TurnstileOutcome,
} from './turnstile-core';

export { turnstilePolicy, verifyTurnstileToken } from './turnstile-core';
export type { TurnstileOutcome } from './turnstile-core';

/**
 * One server-side Turnstile verifier for every public form and authentication route.
 *
 * Rules:
 *  - The token is always verified server-side; a token that is merely present proves nothing.
 *  - In staging and production a missing secret FAILS CLOSED (503). Only `dev` may skip.
 *  - `TURNSTILE_ENFORCEMENT=log-only` is an explicit, temporary rollout switch. It never
 *    applies in production unless an operator sets it deliberately, and every bypass is logged.
 */

type App = { Bindings: Env; Variables: { requestId: string } };

async function tokenFromRequest(c: Context<App>): Promise<string> {
  const header = c.req.header(TURNSTILE_HEADER);
  if (header) return header;
  const contentType = c.req.header('content-type') ?? '';
  try {
    if (contentType.includes('application/json')) {
      // Hono caches the parsed body, so the route handler can read it again.
      const body = (await c.req.json()) as Record<string, unknown>;
      const value = body?.[TURNSTILE_FIELD];
      return typeof value === 'string' ? value : '';
    }
    const body = await c.req.parseBody();
    const value = body[TURNSTILE_FIELD];
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

function reject(c: Context<App>, outcome: Exclude<TurnstileOutcome, 'ok'>) {
  if (outcome === 'unconfigured')
    return c.json(
      {
        error: {
          code: 'SERVICE_NOT_CONFIGURED',
          message: 'This service is temporarily unavailable. Please try again later.',
        },
        requestId: c.get('requestId'),
      },
      503,
    );
  return c.json(
    {
      error: {
        code: 'CHALLENGE_FAILED',
        message: 'Complete the security check and try again.',
      },
      requestId: c.get('requestId'),
    },
    422,
  );
}

/** Middleware for JSON endpoints. Register before the route handler. */
export const requireTurnstile: MiddlewareHandler<App> = async (c, next) => {
  if (c.req.method !== 'POST') return next();
  const env: TurnstileEnv & Env = c.env;
  const outcome = await verifyTurnstileToken(
    env,
    await tokenFromRequest(c),
    c.req.header('cf-connecting-ip'),
  );
  if (outcome === 'ok') return next();
  if (env.TURNSTILE_ENFORCEMENT === 'log-only') {
    console.warn('turnstile_bypassed', {
      requestId: c.get('requestId'),
      outcome,
      path: new URL(c.req.url).pathname,
    });
    return next();
  }
  return reject(c, outcome);
};

/** Public, non-secret config the browser needs to render the widget. */
export const turnstileConfigRoutes = new Hono<App>();
turnstileConfigRoutes.get('/api/public/turnstile', (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json({ data: { siteKey: c.env.TURNSTILE_SITE_KEY ?? null } });
});

/** Every POST route that must be protected. Keep this list the single source of truth. */
export const TURNSTILE_PROTECTED_POSTS = [
  '/api/admin/auth/login',
  '/api/admin/auth/forgot-password',
  '/api/buyer/auth/login',
  '/api/buyer/auth/forgot-password',
  '/api/buyer/auth/request-code',
  '/api/buyer/register',
  '/api/forms/:slug/submit',
  '/api/sell-a-casino',
] as const;
