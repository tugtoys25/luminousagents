import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { defaultSiteContent } from '../../src/site-content/resolve';
import { seedCollection } from '../../src/site-content/site-content-repo';
import { notFoundPage, wantsNotFoundPage } from '../../src/web/pages/not-found';

const html = { headers: { accept: 'text/html,application/xhtml+xml' } };
const req = (path: string, init: RequestInit = {}) => new Request(`https://mayfair.test${path}`, init);

describe('not found page', () => {
  it('only treats browser page requests as pages', () => {
    expect(wantsNotFoundPage(req('/nope', html))).toBe(true);
    expect(wantsNotFoundPage(req('/nope', { method: 'HEAD', ...html }))).toBe(true);
    expect(wantsNotFoundPage(req('/nope'))).toBe(false);
    expect(wantsNotFoundPage(req('/nope', { method: 'POST', ...html }))).toBe(false);
    for (const path of ['/api/x', '/dashboard/x', '/account', '/admin/x', '/media/x', '/static/x.css'])
      expect(wantsNotFoundPage(req(path, html)), path).toBe(false);
  });

  it('ships built-in wording that every field accepts', () => {
    const copy = defaultSiteContent().notFound;
    expect(copy['heading']).toBe('Page not found');
    expect(copy['primaryUrl']).toBe('/');
  });

  it('answers a missing page with a branded, non-indexed HTML 404', async () => {
    const res = await SELF.fetch('https://mayfair.test/no-such-page', html);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.text();
    expect(body).toContain('Page not found');
    expect(body).toContain('href="/casinos-for-sale"');
    expect(body).toMatch(/name="robots"[^>]*noindex/);
  });

  it('keeps JSON for API, dashboard and non-browser requests', async () => {
    for (const [path, init] of [['/no-such-page', {}], ['/api/nothing', html], ['/dashboard/nothing', html]] as const) {
      const res = await SELF.fetch(`https://mayfair.test${path}`, init);
      expect(res.status, path).toBe(404);
      expect(res.headers.get('content-type'), path).toContain('application/json');
    }
  });

  it('uses staff-edited wording and drops unsafe or empty buttons', async () => {
    const ts = '2026-11-03T10:00:00.000Z';
    await env.DB.prepare(
      "INSERT INTO users (id, email, display_name, role, user_type, status, created_at, updated_at) VALUES ('nf-staff', 'nf-staff@example.com', 'NF', 'admin', 'staff', 'active', ?, ?)",
    ).bind(ts, ts).run();
    const data = {
      eyebrow: '', heading: 'Lost?', message: 'Try the home page.',
      primaryLabel: 'Home', primaryUrl: 'javascript:alert(1)', secondaryLabel: 'Sell', secondaryUrl: '/sell',
    };
    await seedCollection(env.DB, 'not_found', [{ id: 'nf1', sortOrder: 0, enabled: true, data }], 'nf-staff', ts);
    const res = await notFoundPage(env, req('/gone', html));
    expect(res?.status).toBe(404);
    const body = (await res?.text()) ?? '';
    expect(body).toContain('Lost?');
    expect(body).toContain('href="/sell"');
    expect(body).not.toContain('javascript:');
    expect(body).not.toContain('Error 404');
  });
});
