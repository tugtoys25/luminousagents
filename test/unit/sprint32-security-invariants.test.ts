import { describe, expect, it } from 'vitest';
import { readAdminSources } from '../../scripts/lib/admin-sources.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Static source guards. They run in plain Node (vitest.node.config.ts) because they read repository files.
const read = (path: string) =>
  path === 'src/admin/routes.ts'
    ? readAdminSources()
    : readFileSync(resolve(process.cwd(), path), 'utf8');

/** The sign-in portal is split across src/auth/portal-*.ts (pages, auth API, email codes, onboarding); invariants read them as one. */
const readPortal = () =>
  ['portal-routes', 'portal-shared', 'portal-pages', 'portal-auth-api', 'portal-buyer-code', 'portal-onboarding']
    .map((n) => read(`src/auth/${n}.ts`))
    .join('\n');

/** The public site is split across src/web/pages/public-*.ts(x); invariants read them as one. */
const readPublicPages = () =>
  ['public', 'public-shared', 'public-home', 'public-listings', 'public-detail', 'public-info', 'public-seo']
    .map((n) => read(`src/web/pages/${n}.${n === 'public-shared' || n === 'public-seo' ? 'ts' : 'tsx'}`))
    .join('\n');

describe('Sprint 32 static guards', () => {
  it('buyer email-code request returns the generic response object, not a call to it', () => {
    const auth = readPortal();
    const start = auth.indexOf("portal.post('/api/buyer/auth/request-code'");
    const end = auth.indexOf("portal.post('/api/buyer/auth/verify-code'");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const handler = auth.slice(start, end);
    expect(handler).toContain('const generic = {');
    expect(handler).not.toContain('generic()');
    expect(handler).toContain('c.json(generic, 202)');
  });

  it('checks the lifecycle transition before writing the publication change', () => {
    const admin = read('src/admin/routes.ts');
    const route = admin.indexOf("admin.post('/opportunities/:id/publication'");
    expect(route).toBeGreaterThan(-1);
    const body = admin.slice(route, route + 4000);
    const check = body.indexOf('checkLifecycleTransition(');
    // The write now lives in the repository; the route must call it only after the transition check.
    const write = body.indexOf('setPublication(');
    expect(check).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(check);
    expect(body).toContain('transition.code');
    expect(body).toContain('fromLifecycle');
    expect(admin).toMatch(/UPDATE opportunities SET lifecycle = \?, public_visibility = \?/);
  });

  it('registers fixed opportunity paths before the :id wildcard so they are reachable', () => {
    const admin = read('src/admin/routes.ts');
    const wildcard = admin.indexOf("admin.get('/opportunities/:id',");
    expect(wildcard).toBeGreaterThan(-1);
    for (const fixed of [
      "admin.get('/opportunities/lifecycle-transitions'",
      "admin.get('/opportunities/reconciliation'",
      "admin.get('/opportunities/review-queue'",
      "admin.get('/opportunities/export.csv'",
    ]) {
      const at = admin.indexOf(fixed);
      expect(at, fixed).toBeGreaterThan(-1);
      expect(at, `${fixed} must come before the :id route`).toBeLessThan(wildcard);
    }
  });

  it('keeps the public serializer on the shared redaction module', () => {
    const serializer = read('src/domain/opportunities/serialize.ts');
    expect(serializer).toContain("from './redaction.ts'");
    expect(serializer).toContain('redactConfidentialText');
    const pages = readPublicPages();
    expect(pages).not.toContain('serializeOpportunity(row, 1)');
  });

  it('runs the static source tests in Node and excludes them from the Workers pool and tsc', () => {
    expect(read('vitest.config.ts')).toContain("'test/unit/sprint2[4-9]-*.test.ts'");
    expect(read('vitest.node.config.ts')).toContain("'test/unit/sprint2[4-9]-*.test.ts'");
    const tsconfig = read('tsconfig.json');
    for (const name of ['sprint25-security-baseline', 'sprint31-completion-hardening', 'sprint32-security-invariants']) {
      expect(tsconfig).toContain(`test/unit/${name}.test.ts`);
    }
  });

  it('ships the generated role matrix and the offline audit scripts', () => {
    for (const path of [
      'docs/ROLE_ROUTE_MATRIX.md',
      'scripts/role-matrix.mjs',
      'scripts/leak-audit.mjs',
      'scripts/reconcile.mjs',
      'src/domain/opportunities/lifecycle.ts',
      'src/domain/opportunities/redaction.ts',
      'src/domain/opportunities/reconciliation.ts',
    ]) {
      expect(existsSync(resolve(process.cwd(), path)), path).toBe(true);
    }
  });
});
