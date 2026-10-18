import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import type { Env } from '../env';
import { authenticateStaff } from './staff-session';
import type { StaffIdentity, StaffSessionState } from './staff-session';
import { portalPage } from './portal-page';
import * as mfa from './mfa';
import * as repo from './mfa-repo';
import { safeReturnPath, stepUpDecision, stepUpMessage } from './step-up-policy';

type App = { Bindings: Env; Variables: { requestId: string } };
type Session = StaffIdentity & StaffSessionState;
const mfaRoutes = new Hono<App>();
const nowIso = () => new Date().toISOString();
const escapeAttr = (v: string) => v.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

const json = (
  c: Context<App>,
  status: 400 | 403 | 404 | 409 | 422 | 429 | 503,
  code: string,
  message: string,
) => c.json({ error: { code, message }, requestId: c.get('requestId') }, status);

/** Resolves the staff session. MFA and must-change-password are deliberately NOT enforced here. */
async function session(c: Context<App>): Promise<Session | Response> {
  const identity = await authenticateStaff(
    c as unknown as Parameters<typeof authenticateStaff>[0],
  );
  return identity;
}

/* ------------------------------------------------------------------- pages */

mfaRoutes.get('/admin/mfa', async (c) => {
  const identity = await session(c);
  if (identity instanceof Response) return identity;
  const stepUp = c.req.query('stepup') === '1' && identity.mfa.enrolled;
  if (identity.mfa.verified && identity.mfa.required && !stepUp) return c.redirect('/dashboard', 302);
  if (!identity.mfa.required && !identity.mfa.enrolled && !mfa.mfaAvailable(c.env))
    return c.redirect('/dashboard', 302);
  const links = '<a href="/admin/logout">Sign out</a>';
  if (identity.mfa.enrolled)
    return c.html(
      portalPage({
        title: 'Two-factor check',
        heading: 'Enter your verification code.',
        intro: 'Open your authenticator app and enter the 6-digit code for Casinos of Mayfair.',
        body: `<form id="mfa-verify" data-mfa-form="verify" data-next="${escapeAttr(safeReturnPath(c.req.query('next')))}" novalidate><div class="field"><label for="mfa-code">Authenticator code</label><input id="mfa-code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" required></div><div class="field" id="mfa-recovery-field" hidden><label for="mfa-recovery">Recovery code</label><input id="mfa-recovery" name="recoveryCode" autocomplete="off" maxlength="12"></div><button type="submit">Verify</button><p class="notice" role="status" aria-live="polite"></p><p class="fine"><a href="#" id="mfa-use-recovery">Use a recovery code instead</a></p></form><script src="/static/js/staff-mfa.js" defer></script>`,
        links,
      }),
    );
  return c.html(
    portalPage({
      title: 'Set up two-factor',
      heading: 'Protect your staff account.',
      intro:
        'Administrator accounts require an authenticator app (such as Google Authenticator, 1Password or Authy). Setup takes about a minute.',
      body: `<div id="mfa-setup" data-mfa-form="setup"><button type="button" id="mfa-start">Start setup</button><p class="notice" role="status" aria-live="polite" id="mfa-setup-notice"></p><div id="mfa-secret-box" hidden><p>1. In your authenticator app choose <strong>add account</strong> and enter this key, or open the setup link on your phone.</p><p><code id="mfa-secret"></code></p><p><a id="mfa-uri" href="#">Open in authenticator app</a></p><form id="mfa-enable" data-mfa-form="enable" novalidate><div class="field"><label for="mfa-enable-code">2. Enter the 6-digit code it shows</label><input id="mfa-enable-code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" required></div><button type="submit">Turn on two-factor</button><p class="notice" role="status" aria-live="polite"></p></form></div><div id="mfa-recovery-box" hidden><p><strong>Save these recovery codes now.</strong> Each works once if you lose your phone. They will not be shown again.</p><pre id="mfa-recovery-codes"></pre><button type="button" id="mfa-done">I have saved them, continue</button></div></div><script src="/static/js/staff-mfa.js" defer></script>`,
      links,
    }),
  );
});

/* --------------------------------------------------------------------- API */

mfaRoutes.post('/api/admin/mfa/setup', async (c) => {
  const identity = await session(c);
  if (identity instanceof Response) return identity;
  const result = await mfa.beginEnrolment(c.env, identity, nowIso());
  if (result.status === 'unavailable')
    return json(c, 503, 'MFA_UNAVAILABLE', 'Two-factor setup is not available yet. Contact the platform owner.');
  if (result.status === 'already_enabled')
    return json(c, 409, 'MFA_ALREADY_ENABLED', 'Two-factor is already turned on for this account.');
  c.header('Cache-Control', 'no-store');
  return c.json({ data: { secret: result.secret, uri: result.uri } });
});

const codeSchema = z.object({ code: z.string().trim().min(6).max(8) });

mfaRoutes.post('/api/admin/mfa/enable', async (c) => {
  const identity = await session(c);
  if (identity instanceof Response) return identity;
  const input = codeSchema.safeParse(await c.req.json().catch(() => null));
  if (!input.success) return json(c, 422, 'VALIDATION_ERROR', 'Enter the 6-digit code.');
  const result = await mfa.confirmEnrolment(c.env, identity.id, input.data.code, Date.now());
  if (result.status === 'rate_limited')
    return json(c, 429, 'RATE_LIMITED', 'Too many attempts. Wait ten minutes and try again.');
  if (result.status === 'unavailable')
    return json(c, 503, 'MFA_UNAVAILABLE', 'Two-factor setup is not available yet.');
  if (result.status === 'no_pending')
    return json(c, 409, 'MFA_NOT_PENDING', 'Start setup first, then enter the code.');
  if (result.status === 'invalid')
    return json(c, 422, 'INVALID_CODE', 'That code is not right. Check the time on your phone and try again.');
  const at = nowIso();
  await repo.markSessionVerified(c.env, identity.sessionId, at);
  await repo.audit(c.env, {
    actorUserId: identity.id,
    action: 'staff.mfa.enabled',
    entityId: identity.id,
    requestId: c.get('requestId'),
    at,
  });
  c.header('Cache-Control', 'no-store');
  return c.json({ data: { enabled: true, recoveryCodes: result.recoveryCodes } });
});

const verifySchema = z
  .object({
    code: z.string().trim().min(6).max(8).optional(),
    recoveryCode: z.string().trim().min(8).max(16).optional(),
    next: z.string().max(200).optional(),
  })
  .refine((value) => Boolean(value.code) !== Boolean(value.recoveryCode));

mfaRoutes.post('/api/admin/mfa/verify', async (c) => {
  const identity = await session(c);
  if (identity instanceof Response) return identity;
  const input = verifySchema.safeParse(await c.req.json().catch(() => null));
  if (!input.success) return json(c, 422, 'VALIDATION_ERROR', 'Enter your code.');
  const result = await mfa.verifySecondFactor(c.env, identity.id, input.data, Date.now());
  if (result.status === 'not_enrolled')
    return json(c, 409, 'MFA_NOT_ENROLLED', 'Set up two-factor first.');
  if (result.status === 'rate_limited')
    return json(c, 429, 'RATE_LIMITED', 'Too many attempts. Wait ten minutes and try again.');
  const at = nowIso();
  if (result.status === 'invalid') {
    await repo.audit(c.env, {
      actorUserId: identity.id,
      action: 'staff.mfa.failed',
      entityId: identity.id,
      requestId: c.get('requestId'),
      at,
    });
    return json(c, 422, 'INVALID_CODE', 'That code is not right. Try again.');
  }
  await repo.markSessionVerified(c.env, identity.sessionId, at);
  await repo.audit(c.env, {
    actorUserId: identity.id,
    action: result.method === 'recovery' ? 'staff.mfa.recovery_used' : 'staff.mfa.verified',
    entityId: identity.id,
    requestId: c.get('requestId'),
    ...(result.method === 'recovery'
      ? { details: { recoveryCodesLeft: result.recoveryCodesLeft ?? 0 } }
      : {}),
    at,
  });
  return c.json({
    data: {
      verified: true,
      redirectTo: safeReturnPath(input.data.next),
      ...(result.method === 'recovery' ? { recoveryCodesLeft: result.recoveryCodesLeft ?? 0 } : {}),
    },
  });
});

/** Super administrators can clear another user's MFA (lost device, no recovery codes). */
mfaRoutes.post('/api/admin/mfa/reset/:userId', async (c) => {
  const identity = await session(c);
  if (identity instanceof Response) return identity;
  if (identity.mfa.required && !identity.mfa.verified)
    return json(c, 403, 'MFA_REQUIRED', 'Complete two-factor verification first.');
  if (
    identity.role === 'super_admin' &&
    stepUpDecision({ enrolled: identity.mfa.enrolled, verifiedAt: identity.mfa.verifiedAt }, Date.now()) !== 'ok'
  )
    return json(c, 403, 'STEP_UP_REQUIRED', stepUpMessage('/staff/ui'));
  if (identity.role !== 'super_admin')
    return json(c, 403, 'FORBIDDEN', 'Only a super administrator can reset two-factor.');
  const targetId = c.req.param('userId');
  if (targetId === identity.id)
    return json(c, 422, 'VALIDATION_ERROR', 'You cannot reset your own two-factor.');
  const target = await repo.targetUser(c.env, targetId);
  if (!target) return json(c, 404, 'NOT_FOUND', 'Staff account not found.');
  const at = nowIso();
  const removed = await mfa.resetMfa(c.env, targetId, at);
  await repo.audit(c.env, {
    actorUserId: identity.id,
    action: 'staff.mfa.reset',
    entityId: targetId,
    requestId: c.get('requestId'),
    details: { hadMfa: removed },
    at,
  });
  return c.json({ data: { reset: true, hadMfa: removed } });
});

export default mfaRoutes;
