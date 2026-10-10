import { Hono } from 'hono';
import type { Env } from './env';
import { toSafeErrorResponse } from './lib/errors';
import { requestIdMiddleware } from './middleware/request-id';
import { securityHeadersMiddleware } from './middleware/security-headers';
import { publicCacheMiddleware } from './middleware/public-cache';
import { sameOriginMutationMiddleware } from './middleware/origin-check';
import publicPages from './web/pages/public';
import managedContentRoutes from './web/managed-content';
import adminRoutes from './admin/routes';
import enquiryRoutes from './enquiries/routes';
import buyerRoutes from './buyers/routes';
import portalRoutes from './auth/portal-routes';
import { consumeNotifications, recoverNotificationJobs } from './operations/queue';

const app = new Hono<{ Bindings: Env; Variables: { requestId: string } }>();

app.use('*', requestIdMiddleware);
app.use('*', securityHeadersMiddleware);
app.use('*', publicCacheMiddleware);
app.use('/api/buyer/*', sameOriginMutationMiddleware);
app.use('/api/admin/*', sameOriginMutationMiddleware);
app.use('/dashboard/*', sameOriginMutationMiddleware);
const escapeAttr = (value: unknown): string =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
  );

// Staff workspace shell (Sprint 18 final): every successful dashboard HTML page gets the
// shared workspace script plus a small identity meta tag, so the navigation can be role-aware
// on every page. Authorization stays server-side; the meta tag is presentation only.
app.use('/dashboard*', async (c, next) => {
  await next();
  const contentType = c.res.headers.get('content-type') ?? '';
  if (!contentType.includes('text/html') || c.res.status >= 400) return;
  let html = await c.res.text();
  if (!html.includes('/static/js/dashboard-shell.js')) {
    const staff = (c as unknown as { get(key: string): unknown }).get('staff') as
      { displayName?: string | null; email?: string | null; role?: string | null } | undefined;
    const identity = staff
      ? `<meta name="mayfair-staff" content="${escapeAttr(staff.role)}" data-name="${escapeAttr(staff.displayName || staff.email)}" data-email="${escapeAttr(staff.email)}">`
      : '';
    html = html.replace('</head>', () => `${identity}</head>`);
    html = html.replace(
      '</body>',
      () => '<script src="/static/js/dashboard-shell.js" defer></script></body>',
    );
    const headers = new Headers(c.res.headers);
    headers.delete('content-length');
    c.res = new Response(html, {
      status: c.res.status,
      statusText: c.res.statusText,
      headers,
    });
  }
});

app.get('/healthz', (c) => {
  return c.json({ status: 'ok', service: 'mayfair-platform' }, 200);
});

app.use('*', async (c, next) => {
  await next();
  if (
    c.req.path.startsWith('/admin') ||
    c.req.path.startsWith('/dashboard') ||
    c.req.path.startsWith('/api/') ||
    c.req.path.startsWith('/static/')
  )
    return;
  const contentType = c.res.headers.get('content-type') ?? '';
  if (!contentType.includes('text/html') || c.res.status >= 400) return;
  try {
    const settings = await c.env.DB.prepare(
      'SELECT setting_key AS key, value_json AS value FROM platform_settings',
    ).all<{ key: string; value: string }>();
    const config: Record<string, unknown> = {};
    for (const row of settings.results ?? []) {
      try {
        config[row.key] = JSON.parse(row.value);
      } catch {
        /* ignore malformed settings */
      }
    }
    const get = (key: string, fallback = '') =>
      typeof config[key] === 'string' ? String(config[key]) : fallback;
    const escape = (value: string) =>
      value.replace(
        /[&<>"']/g,
        (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
      );
    const favicon = get('favicon_url');
    const faviconSvg = get('favicon_svg_url');
    const ga4 = get('ga4_id');
    const whatsapp = get('whatsapp_number').replace(/[^0-9]/g, '');
    const whatsappMessage = encodeURIComponent(
      get('whatsapp_message', 'Hello, I would like to enquire about Casinos of Mayfair.'),
    );
    const primary = /^#[0-9a-fA-F]{6}$/.test(get('primary_color')) ? get('primary_color') : '';
    const accent = /^#[0-9a-fA-F]{6}$/.test(get('accent_color')) ? get('accent_color') : '';
    const background = /^#[0-9a-fA-F]{6}$/.test(get('background_color'))
      ? get('background_color')
      : '';
    const font = (get('font_body') || get('font_family'))
      .replace(/[^a-zA-Z0-9 ,\-'"]/g, '')
      .slice(0, 100);
    const siteName = get('site_name').trim().slice(0, 100);
    const siteDescription = get('site_description').trim().slice(0, 300);
    const logoUrl = get('logo_url');
    const logoText = get('logo_text').trim().slice(0, 100);
    const navItems = (key: string) =>
      Array.isArray(config[key])
        ? (config[key] as unknown[])
            .filter(
              (x): x is { label: string; url: string } =>
                !!x &&
                typeof x === 'object' &&
                typeof (x as { label?: unknown }).label === 'string' &&
                typeof (x as { url?: unknown }).url === 'string',
            )
            .slice(0, 20)
        : [];
    const navHtml = (items: { label: string; url: string }[]) =>
      items
        .map((item) => {
          const url = item.url.trim();
          if (!(url.startsWith('/') && !url.startsWith('//')) && !/^https:\/\//i.test(url))
            return '';
          return `<a href="${escape(url)}">${escape(item.label.slice(0, 80))}</a>`;
        })
        .join('');
    let html = await c.res.text();
    if (siteName)
      html = html
        .replace(/Casinos of Mayfair/g, () => escape(siteName))
        .replace(/CASINOS OF MAYFAIR/g, () => escape(siteName.toUpperCase()));
    if (siteDescription)
      html = html.replace(
        /(<meta name="description" content=")[^"]*(">)/,
        (_match, prefix, suffix) => `${prefix}${escape(siteDescription)}${suffix}`,
      );
    if (logoText)
      html = html.replace(
        /(<span class="brand-copy">\s*<strong>)[^<]*(<\/strong>)/g,
        (_match, prefix, suffix) => `${prefix}${escape(logoText)}${suffix}`,
      );
    if (
      logoUrl &&
      ((logoUrl.startsWith('/') && !logoUrl.startsWith('//')) || /^https:\/\//i.test(logoUrl))
    )
      html = html.replace(
        /<span class="brand-mark"[^>]*>M<\/span>/g,
        `<img src="${escape(logoUrl)}" alt="${escape(get('logo_alt', siteName || 'Brand logo'))}" class="brand-logo-image">`,
      );
    const headerItems = navItems('header_navigation');
    if (headerItems.length)
      html = html.replace(
        /<nav aria-label="Main navigation" class="main-nav">[\s\S]*?<\/nav>/,
        `<nav aria-label="Main navigation" class="main-nav">${navHtml(headerItems)}</nav>`,
      );
    const footerItems = navItems('footer_navigation');
    if (footerItems.length)
      html = html.replace(
        /<div>\s*<strong>Information<\/strong>[\s\S]*?<\/div>/,
        `<div><strong>Information</strong>${navHtml(footerItems)}</div>`,
      );
    if (c.req.path === '/') {
      const renderSections = (key: string, label: string) => {
        const rows = Array.isArray(config[key]) ? (config[key] as unknown[]).slice(0, 20) : [];
        return rows
          .map((item) => {
            if (!item || typeof item !== 'object') return '';
            const v = item as Record<string, unknown>;
            const title = typeof v.title === 'string' ? v.title.slice(0, 160) : '';
            const body = typeof v.body === 'string' ? v.body.slice(0, 1000) : '';
            const link =
              typeof v.url === 'string' && v.url.startsWith('/') && !v.url.startsWith('//')
                ? v.url
                : '';
            if (!title && !body) return '';
            return `<section class="section section-muted managed-section"><div class="container content-narrow"><span class="eyebrow">${escape(label)}</span>${title ? `<h2>${escape(title)}</h2>` : ''}${body ? `<p>${escape(body)}</p>` : ''}${link ? `<a class="button button-dark" href="${escape(link)}">${escape(typeof v.linkText === 'string' ? v.linkText.slice(0, 60) : 'Learn more')}</a>` : ''}</div></section>`;
          })
          .join('');
      };
      const dynamicSections =
        renderSections('homepage_sections', 'MORE FROM MAYFAIR') +
        renderSections('geo_sections', 'OUR MARKETS');
      if (dynamicSections) html = html.replace('</main>', `${dynamicSections}</main>`);
    }
    let head = '';
    if (favicon) head += `<link rel="icon" href="${escape(favicon)}">`;
    if (faviconSvg) head += `<link rel="icon" type="image/svg+xml" href="${escape(faviconSvg)}">`;
    if (primary || accent || background || font)
      head += `<style>:root{${primary ? `--red:${primary};--color-primary:${primary};` : ''}${accent ? `--gold:${accent};--color-accent:${accent};` : ''}${background ? `--paper:${background};--color-background:${background};` : ''}${font ? `--sans:${font};--font-family:${font};` : ''}${
        get('font_heading')
          ? `--serif:${get('font_heading')
              .replace(/[^a-zA-Z0-9 ,\-'\"]/g, '')
              .slice(0, 100)};`
          : ''
      }}</style>`;
    if (/^G-[A-Z0-9]+$/.test(ga4))
      head += `<script src="/static/js/analytics-consent.js" data-ga4="${ga4}" defer></script>`;
    if (head) html = html.replace('</head>', `${head}</head>`);
    if (whatsapp.length >= 8 && whatsapp.length <= 15)
      html = html.replace(
        '</body>',
        `<a class="mayfair-whatsapp" href="https://wa.me/${whatsapp}?text=${whatsappMessage}" target="_blank" rel="noopener noreferrer" aria-label="Contact us on WhatsApp">WhatsApp&nbsp; ↗</a></body>`,
      );
    if (/^G-[A-Z0-9]+$/.test(ga4))
      html = html.replace(
        '</body>',
        `<aside class="analytics-consent" id="analytics-consent" hidden role="dialog" aria-label="Analytics cookie preferences"><p>We use optional analytics to understand site usage. You can accept or reject analytics cookies.</p><button type="button" data-consent="accept">Accept analytics</button><button type="button" data-consent="reject">Reject analytics</button><a href="/legal/cookies">Cookie notice</a></aside><script src="/static/js/analytics-consent-ui.js" defer></script></body>`,
      );
    const headers = new Headers(c.res.headers);
    headers.delete('content-length');
    c.res = new Response(html, { status: c.res.status, statusText: c.res.statusText, headers });
  } catch {
    /* site remains available if optional customisation is not yet migrated */
  }
});

app.route('/', portalRoutes);
app.route('/', managedContentRoutes);
app.route('/', publicPages);
app.route('/', enquiryRoutes);
app.route('/', buyerRoutes);
app.route('/dashboard', adminRoutes);

app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: 'Not found.' } }, 404));

app.onError((error, c) => {
  const safe = toSafeErrorResponse(error, c.get('requestId'));
  if (safe.status >= 500) {
    // Avoid logging request bodies, secrets, or raw exception messages.
    console.error('request_failed', {
      requestId: c.get('requestId'),
      status: safe.status,
      errorType: error instanceof Error ? error.name : 'UnknownError',
    });
  }
  return c.json(safe.body, safe.status as 400 | 401 | 403 | 404 | 409 | 429 | 500);
});

export default {
  fetch: app.fetch,
  queue: consumeNotifications,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(recoverNotificationJobs(env));
  },
};
