import { Hono } from 'hono';
import { z } from 'zod';
import { LOCKOUT_MINUTES, MAX_FAILED_LOGINS, needsRehash, dummyVerify, hashPassword, issueResetToken, passwordPolicyError, randomToken, readCookie, sessionCookie, sha256Hex, verifyPassword } from './password';
import { now, newId, cookieFor, sessionSeconds, emailSchema, passwordField, err, throttled, clientIp, auditEvent, currentUser } from './portal-shared';
import type { Kind, App } from './portal-shared';
import {
  findUserForLogin,
  recordFailedLogin,
  completeLogin,
  revokeSessionByTokenHash,
  findActiveUserByEmail,
  findValidResetToken,
  consumeResetToken,
  applyPasswordReset,
  applyPasswordChange,
  applyBuyerSetPassword,
} from './portal-repo';

const portal = new Hono<App>();

/* ------------------------------------------------------- shared auth APIs */

function mountAuthApi(kind: Kind, base: string) {
  const label = kind === 'staff' ? 'staff' : 'buyer';

  portal.post(`${base}/login`, async (c) => {
    const input = z
      .object({ email: emailSchema, password: passwordField })
      .safeParse(await c.req.json().catch(() => null));
    if (!input.success) return err(c, 422, 'VALIDATION_ERROR', 'Enter your email and password.');
    const email = input.data.email.toLowerCase();
    if (
      (await throttled(c.env, `login-ip:${label}:${clientIp(c)}`, 30, 900)) ||
      (await throttled(c.env, `login-email:${label}:${email}`, 10, 900))
    )
      return err(
        c,
        429,
        'RATE_LIMITED',
        'Too many sign-in attempts. Please wait a few minutes and try again.',
      );
    const generic = () =>
      err(
        c,
        401,
        'INVALID_CREDENTIALS',
        'The email or password is incorrect, or the account is temporarily locked.',
      );
    const user = await findUserForLogin(c.env.DB, email, kind);
    if (!user) {
      await dummyVerify(input.data.password);
      return generic();
    }
    const timestamp = now();
    if (user.lockedUntil && user.lockedUntil > timestamp) {
      await dummyVerify(input.data.password);
      return generic();
    }
    if (!(await verifyPassword(input.data.password, user.passwordHash))) {
      const failed = user.failed + 1;
      const lock = failed >= MAX_FAILED_LOGINS;
      await recordFailedLogin(c.env.DB, {
        userId: user.id,
        failedCount: lock ? 0 : failed,
        lockedUntil: lock ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000).toISOString() : null,
        timestamp,
      });
      if (lock) await auditEvent(c.env, c, 'public', user.id, `${label}.login_locked`, user.id);
      return generic();
    }
    if (user.status === 'invited')
      return err(
        c,
        403,
        'ACCOUNT_PENDING',
        'Your registration is awaiting approval. We will be in touch once it has been reviewed.',
      );
    if (user.status !== 'active')
      return err(
        c,
        403,
        'ACCOUNT_INACTIVE',
        'This account is not active. Contact the team if you think this is a mistake.',
      );
    const token = randomToken(32);
    const sessionId = newId();
    const expires = new Date(Date.now() + sessionSeconds(kind) * 1000).toISOString();
    await completeLogin(c.env.DB, {
      userId: user.id,
      kind,
      rehashedPassword: needsRehash(user.passwordHash) ? await hashPassword(input.data.password) : null,
      sessionId,
      tokenHash: await sha256Hex(token),
      timestamp,
      expiresAt: expires,
      auditId: newId(),
      action: `${label}.session.created`,
      requestId: c.get('requestId'),
    });
    c.header('Set-Cookie', sessionCookie(cookieFor(kind), token, sessionSeconds(kind)));
    const mustChange = user.mustChange === 1;
    return c.json({
      data: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        expiresAt: expires,
        mustChangePassword: mustChange,
        redirectTo:
          kind === 'staff'
            ? mustChange
              ? '/admin/change-password'
              : '/dashboard'
            : mustChange
              ? '/account/change-password'
              : '/account',
      },
    });
  });

  portal.post(`${base}/logout`, async (c) => {
    const token = readCookie(c.req.header('cookie'), cookieFor(kind));
    if (token)
      await revokeSessionByTokenHash(c.env.DB, await sha256Hex(token), now());
    c.header('Set-Cookie', sessionCookie(cookieFor(kind), '', 0));
    return c.json({ data: { signedOut: true } });
  });

  portal.post(`${base}/forgot-password`, async (c) => {
    const input = z.object({ email: emailSchema }).safeParse(await c.req.json().catch(() => null));
    if (!input.success) return err(c, 422, 'VALIDATION_ERROR', 'Enter a valid email address.');
    const email = input.data.email.toLowerCase();
    const reply = () =>
      c.json(
        {
          data: {
            accepted: true,
            message:
              'If an active account exists for that email, a password reset link has been sent.',
          },
        },
        202,
      );
    if (
      (await throttled(c.env, `reset-email:${label}:${email}`, 3, 3600)) ||
      (await throttled(c.env, `reset-ip:${label}:${clientIp(c)}`, 15, 3600))
    )
      return reply();
    const user = await findActiveUserByEmail(c.env.DB, email, kind);
    if (user) {
      await issueResetToken(c.env, user, 'reset', kind);
      await auditEvent(c.env, c, 'public', user.id, `${label}.password_reset_requested`, user.id);
    }
    return reply();
  });

  portal.post(`${base}/reset-password`, async (c) => {
    const input = z
      .object({ token: z.string().regex(/^[a-f0-9]{64}$/), password: z.string().max(200) })
      .safeParse(await c.req.json().catch(() => null));
    const invalid = () =>
      err(
        c,
        400,
        'INVALID_RESET_LINK',
        'This reset link is invalid or has expired. Request a new one.',
      );
    if (!input.success) return invalid();
    if (await throttled(c.env, `reset-submit:${label}:${clientIp(c)}`, 20, 900))
      return err(c, 429, 'RATE_LIMITED', 'Please wait before trying again.');
    const timestamp = now();
    const record = await findValidResetToken(c.env.DB, {
      tokenHash: await sha256Hex(input.data.token),
      kind,
      timestamp,
    });
    if (!record) return invalid();
    const policy = passwordPolicyError(input.data.password, record.email);
    if (policy) return err(c, 422, 'WEAK_PASSWORD', policy);
    const hash = await hashPassword(input.data.password);
    if (!(await consumeResetToken(c.env.DB, record.id, timestamp))) return invalid();
    await applyPasswordReset(c.env.DB, {
      userId: record.userId,
      kind,
      passwordHash: hash,
      timestamp,
      auditId: newId(),
      action: `${label}.password_reset_completed`,
      requestId: c.get('requestId'),
    });
    return c.json({
      data: { reset: true, message: 'Your password has been updated. You can now sign in.' },
    });
  });

  portal.post(`${base}/change-password`, async (c) => {
    const user = await currentUser(c, kind);
    if (!user) return err(c, 401, 'UNAUTHENTICATED', 'Sign in to change your password.');
    const input = z
      .object({ currentPassword: passwordField, newPassword: z.string().max(200) })
      .safeParse(await c.req.json().catch(() => null));
    if (!input.success)
      return err(c, 422, 'VALIDATION_ERROR', 'Enter your current and new password.');
    if (await throttled(c.env, `change-pw:${label}:${user.id}`, 10, 900))
      return err(c, 429, 'RATE_LIMITED', 'Too many attempts. Please wait and try again.');
    if (!(await verifyPassword(input.data.currentPassword, user.passwordHash)))
      return err(c, 403, 'INVALID_CURRENT_PASSWORD', 'Your current password is incorrect.');
    if (input.data.newPassword === input.data.currentPassword)
      return err(c, 422, 'WEAK_PASSWORD', 'Choose a password different from your current one.');
    const policy = passwordPolicyError(input.data.newPassword, user.email);
    if (policy) return err(c, 422, 'WEAK_PASSWORD', policy);
    const timestamp = now();
    await applyPasswordChange(c.env.DB, {
      userId: user.id,
      kind,
      currentSessionId: user.sessionId,
      passwordHash: await hashPassword(input.data.newPassword),
      timestamp,
      auditId: newId(),
      action: `${label}.password_changed`,
      requestId: c.get('requestId'),
    });
    return c.json({ data: { changed: true, message: 'Your password has been changed.' } });
  });
}
mountAuthApi('staff', '/api/admin/auth');
mountAuthApi('buyer', '/api/buyer/auth');
portal.post('/api/buyer/auth/set-password', async (c) => {
  const user = await currentUser(c, 'buyer');
  if (!user) return err(c, 401, 'UNAUTHENTICATED', 'Sign in to set a password.');
  if (user.passwordHash) return err(c, 409, 'PASSWORD_ALREADY_SET', 'Use the change-password form to replace an existing password.');
  const input = z.object({ password: z.string().max(200) }).safeParse(await c.req.json().catch(() => null));
  if (!input.success) return err(c, 422, 'VALIDATION_ERROR', 'Enter a valid password.');
  const policy = passwordPolicyError(input.data.password, user.email);
  if (policy) return err(c, 422, 'WEAK_PASSWORD', policy);
  const timestamp = now();
  await applyBuyerSetPassword(c.env.DB, {
    userId: user.id,
    currentSessionId: user.sessionId,
    passwordHash: await hashPassword(input.data.password),
    timestamp,
    auditId: newId(),
    requestId: c.get('requestId'),
  });
  return c.json({ data: { changed: true, message: 'Password set. You can now sign in using either your password or an email code.' } });
});

export default portal;
