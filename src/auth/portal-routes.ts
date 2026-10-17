import { Hono } from 'hono';
import {
  applyBuyerSetPassword,
  applyPasswordChange,
  applyPasswordReset,
  closeOpenEmailCode,
  completeLogin,
  consumeEmailCode,
  consumeResetToken,
  countStaff,
  countUnconfiguredStaff,
  createEmailCodeSession,
  emailTaken,
  findActiveBuyerByEmail,
  findActiveUserByEmail,
  findLatestEmailCode,
  findSignedInUser,
  findUnconfiguredStaffByEmail,
  findUserForLogin,
  findValidResetToken,
  insertBuyerRegistration,
  insertEmailCode,
  insertFirstAdmin,
  insertUserAudit,
  invalidateOpenEmailCodes,
  markEmailCodeUsed,
  provisionStaffPassword,
  recordEmailCodeMiss,
  recordFailedLogin,
  revokeSessionByTokenHash,
  staffUserExists,
} from './portal-repo';
import type { Context } from 'hono';
import { z } from 'zod';
import type { Env } from '../env';
import {
  LOCKOUT_MINUTES,
  MAX_FAILED_LOGINS,
  needsRehash,
  dummyVerify,
  hashPassword,
  issueResetToken,
  passwordPolicyError,
  randomToken,
  readCookie,
  sessionCookie,
  sha256Hex,
  verifyPassword,
} from './password';
import { STAFF_COOKIE, STAFF_SESSION_SECONDS } from './staff-session';

type Kind = 'staff' | 'buyer';
type App = { Bindings: Env; Variables: { requestId: string } };
const portal = new Hono<App>();
const now = () => new Date().toISOString();
const newId = () => crypto.randomUUID();
const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
  );

const BUYER_COOKIE = 'mayfair_buyer_session';
const BUYER_SESSION_SECONDS = 12 * 60 * 60;
const PRIVACY_VERSION = '2026-10-10-v1';
const cookieFor = (kind: Kind) => (kind === 'staff' ? STAFF_COOKIE : BUYER_COOKIE);
const sessionSeconds = (kind: Kind) =>
  kind === 'staff' ? STAFF_SESSION_SECONDS : BUYER_SESSION_SECONDS;

const emailSchema = z.string().trim().email().max(254);
const passwordField = z.string().min(1).max(200);

const err = (
  c: Context<App>,
  status: 400 | 401 | 403 | 404 | 409 | 410 | 422 | 429 | 503,
  code: string,
  message: string,
) => c.json({ error: { code, message }, requestId: c.get('requestId') }, status);

/** Returns true when the limit has been reached; otherwise records an attempt. */
async function throttled(
  env: Env,
  key: string,
  limit: number,
  ttlSeconds: number,
): Promise<boolean> {
  const hashed = `${key.split(':')[0]}:${await sha256Hex(key)}`;
  const attempts = Number.parseInt((await env.CACHE.get(hashed)) ?? '0', 10) || 0;
  if (attempts >= limit) return true;
  await env.CACHE.put(hashed, String(attempts + 1), { expirationTtl: ttlSeconds });
  return false;
}
const clientIp = (c: Context<App>) => c.req.header('cf-connecting-ip') ?? 'unknown';

async function auditEvent(
  env: Env,
  c: Context<App>,
  kind: Kind | 'public',
  userId: string | null,
  action: string,
  entityId: string,
  details: Record<string, unknown> = {},
) {
  await insertUserAudit(env.DB, {
    id: newId(),
    actorUserId: userId,
    actorType: kind,
    action,
    entityId,
    requestId: c.get('requestId'),
    detailsJson: JSON.stringify(details),
    timestamp: now(),
  });
}

/** Resolves the currently signed-in user for a kind, regardless of must_change_password. */
async function currentUser(c: Context<App>, kind: Kind) {
  const token = readCookie(c.req.header('cookie'), cookieFor(kind));
  if (!token) return null;
  return findSignedInUser(c.env.DB, { tokenHash: await sha256Hex(token), kind, timestamp: now() });
}

/* ------------------------------------------------------------------ pages */

function page(
  title: string,
  heading: string,
  intro: string,
  form: string,
  links: string,
  storyTitle = 'A considered approach to <em>exceptional assets.</em>',
  status = 200 as 200 | 410 | 503,
) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="robots" content="noindex"><title>${escape(title)} · Casinos of Mayfair</title><link rel="stylesheet" href="/static/css/portal.css"></head><body><main class="shell"><aside class="story"><div><div class="brand"><span class="mark">M</span><span>CASINOS OF MAYFAIR<br><small class="brand-subtitle">INTERNATIONAL BROKERAGE</small></span></div><h1>${storyTitle}</h1><p>Private access for qualified buyers and a carefully controlled workspace for the team behind each opportunity.</p></div><div class="story-foot">CONFIDENTIAL BY DESIGN · ACCESS IS ROLE-BASED</div></aside><section class="panel"><span class="eyebrow">${escape(title.toUpperCase())}</span><h2>${escape(heading)}</h2><p class="muted">${escape(intro)}</p>${form}<div class="links">${links}</div><p class="fine">Never share your password or confidential deal materials by email. Casinos of Mayfair will never ask for your password. All opportunities remain subject to verification and appropriate due diligence.</p></section></main></body></html>`;
  return { html, status };
}
const send = (c: Context<App>, p: ReturnType<typeof page>) => c.html(p.html, p.status);

const field = (id: string, label: string, attrs: string) =>
  `<div class="field"><label for="${id}">${label}</label><input id="${id}" ${attrs}></div>`;
const emailField = (label = 'Email') =>
  field('email', label, 'name="email" type="email" autocomplete="email" maxlength="254" required');
const currentPasswordField = () =>
  field(
    'password',
    'Password',
    'name="password" type="password" autocomplete="current-password" maxlength="200" required',
  );
const newPasswordFields = (name = 'password', label = 'Password') =>
  field(
    name,
    label,
    `name="${name}" type="password" autocomplete="new-password" minlength="12" maxlength="200" required aria-describedby="pw-hint"`,
  ) +
  field(
    'confirm',
    'Confirm password',
    'name="confirmPassword" type="password" autocomplete="new-password" minlength="12" maxlength="200" required',
  ) +
  '<p id="pw-hint" class="fine">At least 12 characters, with letters and numbers.</p>';
const optionalPasswordFields = () =>
  field('password', 'Password (optional — leave blank to use email codes)', 'name="password" type="password" autocomplete="new-password" minlength="12" maxlength="200" aria-describedby="pw-hint"') +
  field('confirm', 'Confirm password (if setting one)', 'name="confirmPassword" type="password" autocomplete="new-password" minlength="12" maxlength="200"') +
  '<p id="pw-hint" class="fine">You may leave both password fields blank and sign in using a one-time code sent to your email.</p>';
// Forms whose endpoint is Turnstile-protected server-side (see security/turnstile.ts).
const TURNSTILE_FORM_ENDPOINTS = new Set<string>([
  '/api/admin/auth/login',
  '/api/admin/auth/forgot-password',
  '/api/buyer/auth/forgot-password',
  '/api/buyer/register',
]);
const formTag = (id: string, endpoint: string, extra = '') =>
  `<form id="${id}" data-auth-form data-endpoint="${endpoint}"${TURNSTILE_FORM_ENDPOINTS.has(endpoint) ? ' data-turnstile' : ''} ${extra} novalidate>`;
const formEnd = (button: string) =>
  `<button type="submit">${button}</button><p class="notice" role="status" aria-live="polite"></p></form><script src="/static/js/turnstile-forms.js" defer></script><script src="/static/js/auth-forms.js" defer></script>`;

const staffLinks = (extra = '') => `${extra}<a href="/">Public website</a>`;

async function staffCount(env: Env): Promise<number> {
  return countStaff(env.DB);
}
async function unconfiguredStaffCount(env: Env): Promise<number> {
  return countUnconfiguredStaff(env.DB);
}
/** Setup is open while no staff exist, or while an active staff account (created before passwords) still has no password. */
async function setupOpen(env: Env): Promise<boolean> {
  return (await staffCount(env)) === 0 || (await unconfiguredStaffCount(env)) > 0;
}
const bootstrapEnabled = (env: Env) =>
  Boolean(env.ADMIN_BOOTSTRAP_TOKEN && env.ADMIN_BOOTSTRAP_TOKEN.length >= 32);

/* staff pages */
portal.get('/admin/logout', (c) =>
  send(
    c,
    page(
      'Sign out',
      'End your staff session?',
      'Signing out revokes this browser session immediately.',
      '<button id="staff-signout" type="button">Sign out</button><script src="/static/js/dashboard-session.js" defer></script>',
      staffLinks('<a href="/dashboard">Back to dashboard</a>'),
      'Good decisions start with <em>trusted access.</em>',
    ),
  ),
);
portal.get('/admin/login', async (c) => {
  if (await currentUser(c, 'staff')) return c.redirect('/dashboard', 302);
  const setup =
    (await setupOpen(c.env)) && bootstrapEnabled(c.env)
      ? '<a href="/admin/setup">First administrator setup</a>'
      : '';
  return send(
    c,
    page(
      'Staff sign in',
      'Welcome back.',
      'Sign in with your staff email and password.',
      `${formTag('staff-login', '/api/admin/auth/login')}${emailField('Work email')}${currentPasswordField()}${formEnd('Sign in')}`,
      staffLinks(`<a href="/admin/forgot-password">Forgot password?</a>${setup}`),
      'Good decisions start with <em>trusted access.</em>',
    ),
  );
});
portal.get('/admin/forgot-password', (c) =>
  send(
    c,
    page(
      'Reset password',
      'Forgot your password?',
      'Enter your staff email. If it matches an active account we will send a reset link.',
      `${formTag('staff-forgot', '/api/admin/auth/forgot-password')}${emailField('Work email')}${formEnd('Send reset link')}`,
      staffLinks('<a href="/admin/login">Back to sign in</a>'),
      'Good decisions start with <em>trusted access.</em>',
    ),
  ),
);
portal.get('/admin/reset-password', (c) =>
  send(
    c,
    page(
      'Choose a password',
      'Set a new password.',
      'Choose a strong password. All existing sessions will be signed out.',
      `${formTag('staff-reset', '/api/admin/auth/reset-password', 'data-token-from-query data-success-redirect="/admin/login"')}${newPasswordFields('password', 'New password')}${formEnd('Save new password')}`,
      staffLinks('<a href="/admin/login">Back to sign in</a>'),
      'Good decisions start with <em>trusted access.</em>',
    ),
  ),
);
portal.get('/admin/change-password', async (c) => {
  if (!(await currentUser(c, 'staff'))) return c.redirect('/admin/login', 302);
  return send(
    c,
    page(
      'Change password',
      'Change your password.',
      'Enter your current password, then choose a new one. Other sessions will be signed out.',
      `${formTag('staff-change', '/api/admin/auth/change-password', 'data-success-redirect="/dashboard"')}${field('current', 'Current password', 'name="currentPassword" type="password" autocomplete="current-password" maxlength="200" required')}${newPasswordFields('newPassword', 'New password')}${formEnd('Change password')}`,
      staffLinks('<a href="/dashboard">Back to dashboard</a>'),
      'Good decisions start with <em>trusted access.</em>',
    ),
  );
});
portal.get('/admin/setup', async (c) => {
  if (!(await setupOpen(c.env)))
    return send(
      c,
      page(
        'Setup closed',
        'Administrator setup is closed.',
        'The one-time first-administrator registration has already been completed. Use staff sign in.',
        '<a class="btn" href="/admin/login">Go to staff sign in</a>',
        staffLinks(),
        undefined,
        410,
      ),
    );
  if (!bootstrapEnabled(c.env))
    return send(
      c,
      page(
        'Setup unavailable',
        'Initial setup is not enabled.',
        'The deployer must configure a strong one-time bootstrap secret before the first administrator form can be used.',
        '<a class="btn" href="/admin/login">Go to staff sign in</a>',
        staffLinks(),
        undefined,
        503,
      ),
    );
  return send(
    c,
    page(
      'First administrator setup',
      'Set up administrator access.',
      'Creates the super administrator on a fresh install, or sets the first password for an existing staff account that has none. Requires the one-time setup token configured by the deployer.',
      `${formTag('bootstrap-form', '/api/admin/bootstrap', 'data-success-redirect="/admin/login"')}${field('name', 'Full name', 'name="displayName" autocomplete="name" minlength="2" maxlength="120" required')}${emailField('Work email')}${newPasswordFields('password', 'Password')}${field('token', 'One-time setup token', 'name="token" type="password" autocomplete="off" minlength="32" required')}${formEnd('Create super administrator')}`,
      staffLinks('<a href="/admin/login">Staff sign in</a>'),
      'Set the foundation for <em>trusted stewardship.</em>',
    ),
  );
});

/* buyer pages (sign-in itself lives at /account) */
portal.get('/register', (c) =>
  send(
    c,
    page(
      'Buyer registration',
      'Your next opportunity starts here.',
      'Create a buyer account. New accounts require team approval before sign-in and confidential access are enabled.',
      `${formTag('buyer-register', '/api/buyer/register')}${field('name', 'Full name', 'name="displayName" autocomplete="name" minlength="2" maxlength="120" required')}${emailField('Business email')}${optionalPasswordFields()}${field('company', 'Company', 'name="companyName" autocomplete="organization" maxlength="160"')}${field('role', 'Role / title', 'name="roleTitle" maxlength="120"')}<div class="field"><label for="interest">Investment focus</label><select id="interest" name="investmentFocus"><option value="casino-hotel">Casino &amp; hotel</option><option value="casino">Casino</option><option value="hotel">Hotel / hospitality</option><option value="resort">Resort / destination</option><option value="other">Other</option></select></div><div class="field"><label class="consent-row"><input class="consent-checkbox" type="checkbox" name="consent" required> I have read the <a href="/legal/privacy">privacy notice</a> and agree that the team may use these details to review my registration.</label></div>${formEnd('Submit registration')}`,
      '<a href="/account">Buyer sign in</a><a href="/">Public website</a>',
      'Access to the right information, <em>at the right time.</em>',
    ),
  ),
);
portal.get('/forgot-password', (c) =>
  send(
    c,
    page(
      'Reset password',
      'Forgot your password?',
      'Enter your email. If it matches an active buyer account we will send a reset link.',
      `${formTag('buyer-forgot', '/api/buyer/auth/forgot-password')}${emailField('Email')}${formEnd('Send reset link')}`,
      '<a href="/account">Back to sign in</a><a href="/">Public website</a>',
    ),
  ),
);
portal.get('/reset-password', (c) =>
  send(
    c,
    page(
      'Choose a password',
      'Set a new password.',
      'Choose a strong password. All existing sessions will be signed out.',
      `${formTag('buyer-reset', '/api/buyer/auth/reset-password', 'data-token-from-query data-success-redirect="/account"')}${newPasswordFields('password', 'New password')}${formEnd('Save new password')}`,
      '<a href="/account">Back to sign in</a><a href="/">Public website</a>',
    ),
  ),
);
portal.get('/account/change-password', async (c) => {
  const user = await currentUser(c, 'buyer');
  if (!user) return c.redirect('/account', 302);
  const hasPassword = Boolean(user.passwordHash);
  return send(
    c,
    page(
      hasPassword ? 'Change password' : 'Set a password',
      hasPassword ? 'Change your password.' : 'Add a password to your account.',
      hasPassword ? 'Enter your current password, then choose a new one. Other sessions will be signed out.' : 'You signed in with an email code. You can add a password now or continue using email codes.',
      hasPassword ? `${formTag('buyer-change', '/api/buyer/auth/change-password', 'data-success-redirect="/account"')}${field('current', 'Current password', 'name="currentPassword" type="password" autocomplete="current-password" maxlength="200" required')}${newPasswordFields('newPassword', 'New password')}${formEnd('Change password')}` : `${formTag('buyer-set-password', '/api/buyer/auth/set-password', 'data-success-redirect="/account"')}${newPasswordFields('password', 'New password')}${formEnd('Set password')}`,
      '<a href="/account">Back to account</a><a href="/">Public website</a>',
    ),
  );
});

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


/* ----------------------------------------------- buyer email-code sign-in */
const buyerCodeCookie = 'mayfair_buyer_session';
async function buyerCodeHash(email: string, code: string, secret: string): Promise<string> {
  return sha256Hex(`mayfair-buyer-code-v1:${secret}:${email.toLowerCase()}:${code}`);
}
async function sendBuyerCodeEmail(env: Env, email: string, code: string): Promise<void> {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) throw new Error('Email provider is not configured');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: [email],
      subject: 'Your sign-in code · Casinos of Mayfair',
      html: `<p>Your Casinos of Mayfair sign-in code is <strong>${code}</strong>.</p><p>It expires in 10 minutes and can be used once. If you did not request it, you can ignore this email.</p>`,
      text: `Your Casinos of Mayfair sign-in code is ${code}. It expires in 10 minutes and can be used once. If you did not request it, ignore this email.`,
    }),
  });
  if (!response.ok) throw new Error(`Email provider returned HTTP ${response.status}`);
}
portal.post('/api/buyer/auth/request-code', async (c) => {
  const input = z.object({ email: emailSchema }).safeParse(await c.req.json().catch(() => null));
  if (!input.success) return err(c, 422, 'VALIDATION_ERROR', 'Enter a valid email address.');
  const email = input.data.email.toLowerCase();
  if ((await throttled(c.env, `buyer-code-ip:${clientIp(c)}`, 10, 900)) || (await throttled(c.env, `buyer-code-email:${email}`, 5, 900)))
    return err(c, 429, 'RATE_LIMITED', 'Too many code requests. Please wait and try again.');
  const generic = { data: { accepted: true, message: 'If this is an active buyer account, a sign-in code has been sent.' } };
  if (!c.env.OTP_ENCRYPTION_KEY || c.env.OTP_ENCRYPTION_KEY.length < 32 || !c.env.RESEND_API_KEY || !c.env.EMAIL_FROM)
    return err(c, 503, 'EMAIL_CODE_UNAVAILABLE', 'Email-code sign-in is temporarily unavailable. Please use password sign-in or contact the team.');
  const user = await findActiveBuyerByEmail(c.env.DB, email);
  if (!user) return c.json(generic, 202);
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000).padStart(6, '0');
  const timestamp = now();
  const expires = new Date(Date.now() + 10 * 60_000).toISOString();
  const challengeId = newId();
  await invalidateOpenEmailCodes(c.env.DB, user.id, timestamp);
  await insertEmailCode(c.env.DB, {
    id: challengeId,
    userId: user.id,
    codeHash: await buyerCodeHash(user.email, code, c.env.OTP_ENCRYPTION_KEY),
    expiresAt: expires,
    timestamp,
  });
  try {
    await sendBuyerCodeEmail(c.env, user.email, code);
  } catch {
    await markEmailCodeUsed(c.env.DB, challengeId, now());
    return err(c, 503, 'EMAIL_DELIVERY_FAILED', 'We could not send a sign-in code. Please try again later or use password sign-in.');
  }
  await auditEvent(c.env, c, 'public', user.id, 'buyer.email_code_requested', challengeId);
  return c.json(generic, 202);
});
portal.post('/api/buyer/auth/verify-code', async (c) => {
  const input = z.object({ email: emailSchema, code: z.string().regex(/^\d{6}$/) }).safeParse(await c.req.json().catch(() => null));
  if (!input.success) return err(c, 422, 'VALIDATION_ERROR', 'Enter your email and six-digit code.');
  const email = input.data.email.toLowerCase();
  if ((await throttled(c.env, `buyer-code-verify-ip:${clientIp(c)}`, 20, 900)) || (await throttled(c.env, `buyer-code-verify-email:${email}`, 10, 900)))
    return err(c, 429, 'RATE_LIMITED', 'Too many verification attempts. Please wait and try again.');
  if (!c.env.OTP_ENCRYPTION_KEY || c.env.OTP_ENCRYPTION_KEY.length < 32) return err(c, 503, 'EMAIL_CODE_UNAVAILABLE', 'Email-code sign-in is not configured.');
  const row = await findLatestEmailCode(c.env.DB, email);
  const timestamp = now();
  if (!row || row.status !== 'active' || row.expiresAt <= timestamp || row.attempts >= 5) return err(c, 401, 'INVALID_CODE', 'The code is invalid or expired. Request a new code and try again.');
  if (row.mustChange === 1) {
    await closeOpenEmailCode(c.env.DB, row.challengeId, timestamp);
    return err(c, 403, 'PASSWORD_CHANGE_REQUIRED', 'This account must complete its password change using password sign-in before email-code sign-in can be used.');
  }
  const candidate = await buyerCodeHash(row.email, input.data.code, c.env.OTP_ENCRYPTION_KEY);
  if (candidate !== row.codeHash) {
    await recordEmailCodeMiss(c.env.DB, row.challengeId, timestamp);
    return err(c, 401, 'INVALID_CODE', 'The code is invalid or expired. Request a new code and try again.');
  }
  const token = randomToken(32);
  const sessionId = newId();
  const expires = new Date(Date.now() + BUYER_SESSION_SECONDS * 1000).toISOString();
  if (!(await consumeEmailCode(c.env.DB, row.challengeId, timestamp))) return err(c, 401, 'INVALID_CODE', 'The code is invalid or expired. Request a new code and try again.');
  await createEmailCodeSession(c.env.DB, {
    userId: row.id,
    sessionId,
    tokenHash: await sha256Hex(token),
    timestamp,
    expiresAt: expires,
    auditId: newId(),
    requestId: c.get('requestId'),
  });
  c.header('Set-Cookie', sessionCookie(buyerCodeCookie, token, BUYER_SESSION_SECONDS));
  return c.json({ data: { id: row.id, email: row.email, displayName: row.displayName, expiresAt: expires, redirectTo: '/account' } });
});

/* ------------------------------------------------ first administrator */

portal.post('/api/admin/bootstrap', async (c) => {
  const configured = c.env.ADMIN_BOOTSTRAP_TOKEN;
  if (!configured || configured.length < 32)
    return err(c, 503, 'BOOTSTRAP_DISABLED', 'One-time administrator setup is not configured.');
  const input = z
    .object({
      displayName: z.string().trim().min(2).max(120),
      email: emailSchema,
      password: z.string().max(200),
      token: z.string().min(32).max(512),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!input.success)
    return err(c, 422, 'VALIDATION_ERROR', 'Enter a valid name, email, password and setup token.');
  if (await throttled(c.env, `admin-bootstrap:${clientIp(c)}`, 5, 900))
    return err(c, 429, 'RATE_LIMITED', 'Setup attempts are temporarily limited.');
  const a = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input.data.token)),
  );
  const b = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(configured)),
  );
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  if (diff !== 0) return err(c, 403, 'INVALID_SETUP_TOKEN', 'Setup could not be authorised.');
  const email = input.data.email.toLowerCase();
  const policy = input.data.password ? passwordPolicyError(input.data.password, email) : null;
  if (policy) return err(c, 422, 'WEAK_PASSWORD', policy);
  const timestamp = now();
  const userId = newId();
  const hash = await hashPassword(input.data.password);
  // Credential migration: a staff account created before passwords existed (password_hash IS NULL) can be given
  // its first password here, using the same one-time token. Accounts that already have a password are never touched.
  const unconfigured = await findUnconfiguredStaffByEmail(c.env.DB, email);
  if (unconfigured) {
    const provisioned = await provisionStaffPassword(c.env.DB, {
      userId: unconfigured.id,
      passwordHash: hash,
      timestamp,
    });
    if (!provisioned)
      return err(
        c,
        409,
        'SETUP_CONFLICT',
        'Credentials could not be provisioned. Setup may already be complete.',
      );
    await auditEvent(
      c.env,
      c,
      'staff',
      unconfigured.id,
      'staff.credentials_bootstrapped',
      unconfigured.id,
    );
    return c.json(
      {
        data: {
          created: true,
          signInPath: '/admin/login',
          message: 'Password set. Sign in with your email and new password.',
        },
      },
      201,
    );
  }
  if ((await staffCount(c.env)) > 0)
    return err(
      c,
      410,
      'SETUP_CLOSED',
      'Setup is closed for this email. If the account has no password yet, use that account email with the setup token.',
    );
  try {
    await insertFirstAdmin(c.env.DB, {
      userId,
      email,
      displayName: input.data.displayName,
      passwordHash: hash,
      timestamp,
      auditId: newId(),
      requestId: c.get('requestId'),
    });
  } catch {
    return err(
      c,
      409,
      'SETUP_CONFLICT',
      'Setup is already complete or the account could not be created.',
    );
  }
  const created = await staffUserExists(c.env.DB, userId);
  if (!created)
    return err(c, 410, 'SETUP_CLOSED', 'A staff account already exists; setup is closed.');
  return c.json(
    {
      data: {
        created: true,
        signInPath: '/admin/login',
        message:
          'Super administrator created. Setup is now closed — sign in with your email and password.',
      },
    },
    201,
  );
});

/* ----------------------------------------------------- buyer registration */

portal.post('/api/buyer/register', async (c) => {
  const input = z
    .object({
      displayName: z.string().trim().min(2).max(120),
      email: emailSchema,
      password: z.string().max(200).optional().default(''),
      companyName: z.string().trim().max(160).optional().default(''),
      roleTitle: z.string().trim().max(120).optional().default(''),
      investmentFocus: z
        .enum(['casino-hotel', 'casino', 'hotel', 'resort', 'other'])
        .default('casino-hotel'),
      consent: z.literal(true),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!input.success)
    return err(c, 422, 'VALIDATION_ERROR', 'Check the registration details and try again.');
  const email = input.data.email.toLowerCase();
  const policy = input.data.password ? passwordPolicyError(input.data.password, email) : null;
  if (policy) return err(c, 422, 'WEAK_PASSWORD', policy);
  if (
    (await throttled(c.env, `buyer-register-email:${email}`, 5, 3600)) ||
    (await throttled(c.env, `buyer-register-ip:${clientIp(c)}`, 20, 3600))
  )
    return err(c, 429, 'RATE_LIMITED', 'Please wait before submitting another registration.');
  const accepted = {
    data: {
      accepted: true,
      message: 'Registration received. The team will review your details before enabling sign-in.',
    },
  };
  const existing = await emailTaken(c.env.DB, email);
  if (existing) return c.json(accepted, 202); // identical response avoids revealing registered emails
  const timestamp = now();
  const userId = newId();
  const jobId = newId();
  const hash = input.data.password ? await hashPassword(input.data.password) : null;
  try {
    await insertBuyerRegistration(c.env.DB, {
      userId,
      email,
      displayName: input.data.displayName,
      passwordHash: hash,
      companyName: input.data.companyName,
      roleTitle: input.data.roleTitle,
      experienceNotes: `Investment focus: ${input.data.investmentFocus}`,
      privacyVersion: PRIVACY_VERSION,
      timestamp,
      auditId: newId(),
      requestId: c.get('requestId'),
      auditDetailsJson: JSON.stringify({
        investmentFocus: input.data.investmentFocus,
        consentVersion: PRIVACY_VERSION,
      }),
      jobId,
      jobPayloadJson: JSON.stringify({ userId }),
    });
    try {
      await c.env.NOTIFICATIONS_QUEUE.send({ jobId, type: 'buyer.registration_review' });
    } catch {
      /* durable job remains queued for scheduled recovery */
    }
  } catch {
    /* concurrent duplicate: stay silent */
  }
  return c.json(accepted, 202);
});

export default portal;
