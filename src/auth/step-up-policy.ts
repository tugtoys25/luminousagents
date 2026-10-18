/**
 * Step-up re-authentication policy (pure, no framework imports so it is unit-testable).
 * Sensitive staff actions need a second-factor check made recently, not just at sign-in.
 */
export const STEP_UP_WINDOW_SECONDS = 10 * 60;

export interface MfaState {
  enrolled: boolean;
  verifiedAt: string | null;
}

export type StepUpDecision = 'ok' | 'step_up_required';

/**
 * Staff with no enrolled factor cannot step up (nothing to verify with); enforcing a factor for them is the job of
 * STAFF_MFA_REQUIRED_ROLES at sign-in. Everyone enrolled must have verified within the window. A missing or
 * unparseable timestamp, or one in the future, fails closed.
 */
export function stepUpDecision(
  mfa: MfaState | undefined,
  nowMs: number,
  windowSeconds: number = STEP_UP_WINDOW_SECONDS,
): StepUpDecision {
  if (!mfa) return 'step_up_required';
  if (!mfa.enrolled) return 'ok';
  if (!mfa.verifiedAt) return 'step_up_required';
  const at = Date.parse(mfa.verifiedAt);
  if (Number.isNaN(at) || at > nowMs + 5_000) return 'step_up_required';
  return nowMs - at <= windowSeconds * 1000 ? 'ok' : 'step_up_required';
}

/** Only same-site absolute paths may be used as a post-verification redirect (no open redirect). */
export function safeReturnPath(value: unknown, fallback = '/dashboard'): string {
  if (typeof value !== 'string') return fallback;
  if (!/^\/[A-Za-z0-9\-._~/?=&%]*$/.test(value) || value.startsWith('//') || value.includes('/\\')) return fallback;
  if (value.length > 200) return fallback;
  return value;
}

export const stepUpMessage = (returnTo: string): string =>
  `Confirm it is you: verify your authenticator code at /admin/mfa?stepup=1&next=${encodeURIComponent(
    safeReturnPath(returnTo),
  )} and then repeat this action.`;
