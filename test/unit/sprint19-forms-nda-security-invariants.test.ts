import { describe, expect, it } from 'vitest';
import { readAdminSources } from '../../scripts/lib/admin-sources.mjs';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
const read = (path: string) =>
  path === 'src/admin/routes.ts'
    ? readAdminSources()
    : readFileSync(resolve(process.cwd(), path), 'utf8');

/** The buyer API is split across src/buyers/*-routes.ts and shared.ts; invariants read them as one. */
const readBuyers = () =>
  ['routes', 'shared', 'profile-routes', 'documents-routes', 'nda-routes']
    .map((n) => read(`src/buyers/${n}.ts`))
    .join('\n');

/** The public site is split across src/web/pages/public-*.ts(x); invariants read them as one. */
const readPublicPages = () =>
  ['public', 'public-shared', 'public-home', 'public-listings', 'public-detail', 'public-info', 'public-seo']
    .map((n) => read(`src/web/pages/${n}.${n === 'public-shared' || n === 'public-seo' ? 'ts' : 'tsx'}`))
    .join('\n');

describe('Sprint 19 forms, enquiries and NDA invariants', () => {
  const routes = read('src/admin/routes.ts');
  const queue = read('src/operations/queue.ts');
  const buyers = readBuyers() + read('src/buyers/buyers-repo.ts');
  const managed = read('src/web/managed-content.ts');
  const shell = read('public/static/js/dashboard-shell.js');

  it('serves the enquiries inbox page before the :id route so "ui" is never read as an id', () => {
    const ui = routes.indexOf("'/enquiries/ui'");
    const byId = routes.indexOf("'/enquiries/:id'");
    expect(ui).toBeGreaterThan(-1);
    expect(byId).toBeGreaterThan(ui);
    expect(shell).toContain("href: '/dashboard/enquiries/ui'");
  });

  it('keeps triage and export role-restricted and audited', () => {
    expect(routes).toMatch(
      /'\/form-submissions\/export\.csv', requireRole\('admin', 'super_admin'\)/,
    );
    expect(routes).toContain('managed_form.submissions_exported');
    expect(routes).toContain('managed_form.submission_updated');
    expect(routes).toMatch(/\[=\+\\-@/);
  });

  it('only writes known submission statuses and parameterises every filter', () => {
    expect(routes).toContain("['new', 'in_progress', 'closed', 'spam'] as const");
    expect(routes).toContain('submissionFilters(c)');
  });

  it('migration 0017 is additive only', () => {
    const files = readdirSync(resolve(process.cwd(), 'migrations'));
    const name = files.find((f) => f.startsWith('0017_'));
    expect(name).toBeDefined();
    const sql = read(`migrations/${name}`);
    expect(sql).not.toMatch(/\bDROP\b|\bDELETE\b|\bRENAME\b/i);
    expect(sql).toContain('managed_form_submissions');
  });

  it('notifies the buyer of an NDA decision and the worker can render it', () => {
    expect(routes).toContain("'nda.decision'");
    expect(queue).toContain("job.job_type === 'nda.decision'");
  });

  it('lets a buyer re-request only when no live approval or pending request exists', () => {
    expect(buyers).toContain('g.revoked_at IS NULL AND g.expires_at > ?');
  });

  it('rate limits public managed-form submissions', () => {
    expect(managed).toContain('form-rate:');
    expect(managed).toContain("code: 'RATE_LIMITED'");
  });

  it('lets staff override built-in public pages through published managed pages', () => {
    const pub = readPublicPages();
    const pages = read('src/web/static-pages.ts');
    expect(pub).toContain('staticPageSlug(path)');
    expect(read('src/web/public-listings-repo.ts')).toMatch(/status = 'published'/); // override lookup lives in the repo
    expect(pages).toContain("'/legal/privacy'");
    expect(routes).toContain("'/pages/defaults'");
  });
});
