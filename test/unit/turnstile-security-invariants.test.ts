import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Static guards (plain Node). They stop a public entry point being added without a challenge.
const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

const PROTECTED = [
  '/api/admin/auth/login',
  '/api/admin/auth/forgot-password',
  '/api/buyer/auth/login',
  '/api/buyer/auth/forgot-password',
  '/api/buyer/auth/request-code',
  '/api/buyer/register',
  '/api/forms/:slug/submit',
];

describe('Turnstile coverage', () => {
  const turnstile = read('src/security/turnstile.ts');
  const index = read('src/index.ts');

  it('lists every public form and authentication entry point', () => {
    for (const path of PROTECTED) expect(turnstile).toContain(`'${path}'`);
  });

  it('mounts the middleware before any router that owns those paths', () => {
    const mount = index.indexOf("app.on('POST', [...TURNSTILE_PROTECTED_POSTS], requireTurnstile)");
    expect(mount).toBeGreaterThan(-1);
    for (const router of ["app.route('/', portalRoutes)", "app.route('/', managedContentRoutes)", "app.route('/', buyerRoutes)"])
      expect(index.indexOf(router)).toBeGreaterThan(mount);
  });

  it('every protected path is a real route', () => {
    const sources = [
      read('src/auth/portal-routes.ts'),
      read('src/web/managed-content.ts'),
      read('src/buyers/routes.ts'),
    ].join('\n');
    expect(sources).toContain("'/api/buyer/register'");
    expect(sources).toContain("'/api/buyer/auth/request-code'");
    expect(sources).toContain("'/api/forms/:slug/submit'");
    expect(sources).toContain('mountAuthApi(');
  });

  it('renders the widget on every protected form', () => {
    const portal = read('src/auth/portal-routes.ts');
    for (const path of [
      '/api/admin/auth/login',
      '/api/admin/auth/forgot-password',
      '/api/buyer/auth/forgot-password',
      '/api/buyer/register',
    ])
      expect(portal).toContain(`'${path}',`);
    const buyers = read('src/buyers/routes.ts');
    expect(buyers).toContain('id="sign-in-form" data-auth-form data-turnstile');
    expect(buyers).toContain('id="buyer-code-request" data-auth-form data-turnstile');
    expect(read('src/web/managed-content.ts')).toContain('id="managed-public-form" data-turnstile');
  });

  it('the enquiry route uses the shared verifier, not its own copy', () => {
    const enquiries = read('src/enquiries/routes.ts');
    expect(enquiries).toContain('verifyTurnstileToken');
    expect(enquiries).not.toContain('challenges.cloudflare.com/turnstile/v0/siteverify');
  });

  it('browser scripts reset the single-use token after each attempt', () => {
    expect(read('public/static/js/auth-forms.js')).toContain('mayfairResetTurnstile');
    expect(read('public/static/js/managed-form.js')).toContain('mayfairResetTurnstile');
  });
});
