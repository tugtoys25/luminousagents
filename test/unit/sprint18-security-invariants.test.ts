import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('Sprint 18 staff workspace invariants', () => {
  const shell = read('public/static/js/dashboard-shell.js');
  const routes = read('src/admin/routes.ts');
  const index = read('src/index.ts');

  it('ships the workspace assets and keeps the public contact-form script', () => {
    for (const file of [
      'public/static/js/dashboard-shell.js',
      'public/static/js/contact-form.js',
      'public/static/css/dashboard.css',
    ])
      expect(existsSync(resolve(process.cwd(), file))).toBe(true);
  });

  it('never executes dynamic code or writes raw HTML documents from the shell', () => {
    expect(shell).not.toMatch(/\beval\(|new Function\(|document\.write\(/);
    expect(shell).not.toMatch(/setAttribute\(\s*['"]on[a-z]+['"]/i);
  });

  it('only links the menu to routes that exist on the server', () => {
    const hrefs = [...shell.matchAll(/href: '(\/dashboard[^']*)'/g)].map((m) => m[1]!);
    expect(hrefs.length).toBeGreaterThan(10);
    for (const href of hrefs) {
      if (href === '/dashboard') continue;
      const relative = href.replace(/^\/dashboard/, '');
      expect(routes, `${href} must be served by the admin router`).toContain(`'${relative}'`);
    }
  });

  it('keeps Staff accounts server-enforced for super admins only', () => {
    expect(routes).toMatch(/admin\.get\('\/staff\/ui', requireRole\('super_admin'\)/);
  });

  it('escapes the identity meta tag injected into dashboard pages', () => {
    expect(index).toMatch(/escapeAttr\(staff\.role\)/);
    expect(index).toMatch(/escapeAttr\(staff\.displayName \|\| staff\.email\)/);
    expect(index).toMatch(/\/static\/js\/dashboard-shell\.js/);
  });

  it('defines all three themes and uses tokens rather than hard-coded surfaces', () => {
    const css = read('public/static/css/dashboard.css');
    for (const theme of ['ivory', 'midnight']) expect(css).toContain(`data-theme='${theme}'`);
    expect(css).toContain('--ws-surface');
    expect((css.match(/{/g) ?? []).length).toBe((css.match(/}/g) ?? []).length);
  });
});
