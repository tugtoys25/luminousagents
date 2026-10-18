import type { MiddlewareHandler } from 'hono';
import type { StaffApp } from './staff-session';
import { safeReturnPath, stepUpDecision, stepUpMessage } from './step-up-policy';

/**
 * Requires a second-factor verification within the step-up window (default 10 minutes) before a sensitive
 * staff action. Place after `staffAuth()` and `requireRole(...)`. `returnTo` is where the re-verify page sends
 * the person back to.
 */
export function requireRecentMfa(returnTo = '/dashboard', windowSeconds?: number): MiddlewareHandler<StaffApp> {
  const safe = safeReturnPath(returnTo);
  return async (c, next) => {
    const decision =
      windowSeconds === undefined
        ? stepUpDecision(c.get('mfa'), Date.now())
        : stepUpDecision(c.get('mfa'), Date.now(), windowSeconds);
    if (decision !== 'ok')
      return c.json(
        { error: { code: 'STEP_UP_REQUIRED', message: stepUpMessage(safe) }, requestId: c.get('requestId') },
        403,
      );
    await next();
  };
}
