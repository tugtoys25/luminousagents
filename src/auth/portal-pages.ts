import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../env';
import { escape, currentUser } from './portal-shared';
import type { App } from './portal-shared';
import {
  countStaff,
  countUnconfiguredStaff,
} from './portal-repo';

const portal = new Hono<App>();

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
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="robots" content="noindex"><title>${escape(title)} · Luminous Agents</title><link rel="stylesheet" href="/static/css/portal.css"></head><body><main class="shell"><aside class="story"><div><div class="brand"><span class="mark">L</span><span>LUMINOUS AGENTS<br><small class="brand-subtitle">INTERNATIONAL BROKERAGE</small></span></div><h1>${storyTitle}</h1><p>Private access for qualified buyers and a carefully controlled workspace for the team behind each opportunity.</p></div><div class="story-foot">CONFIDENTIAL BY DESIGN · ACCESS IS ROLE-BASED</div></aside><section class="panel"><span class="eyebrow">${escape(title.toUpperCase())}</span><h2>${escape(heading)}</h2><p class="muted">${escape(intro)}</p>${form}<div class="links">${links}</div><p class="fine">Never share your password or confidential deal materials by email. Luminous Agents will never ask for your password. All opportunities remain subject to verification and appropriate due diligence.</p></section></main></body></html>`;
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


export default portal;
