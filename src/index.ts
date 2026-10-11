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
    const mediaCss = html.includes('/static/css/dashboard-media.css')
      ? ''
      : '<link rel="stylesheet" href="/static/css/dashboard-media.css">';
    html = html.replace('</head>', () => `${identity}${mediaCss}</head>`);
    html = html.replace(
      '</body>',
      () => '<script src="/static/js/dashboard-media-picker.js" defer></script><script src="/static/js/dashboard-shell.js" defer></script></body>',
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

// Public media is served only for assets explicitly marked public in the staff library.
app.get('/media/:id', async (c) => {
  const asset = await c.env.DB.prepare('SELECT r2_key AS r2Key, content_type AS contentType, filename, byte_size AS byteSize, sha256 FROM media_assets WHERE (id = ? OR public_slug = ?) AND visibility = \'public\'').bind(c.req.param('id'), c.req.param('id')).first<{ r2Key: string; contentType: string; filename: string; byteSize: number; sha256: string }>();
  if (!asset) return c.notFound();
  const object = await c.env.PRIVATE_FILES.get(asset.r2Key);
  if (!object || object.size !== asset.byteSize || object.size > 25 * 1024 * 1024) return c.notFound();
  const bytes = await object.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const actual = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
  if (!asset.sha256 || actual !== asset.sha256.toLowerCase()) return c.notFound();
  const isImage = asset.contentType.startsWith('image/');
  const headers = new Headers();
  headers.set('Content-Type', asset.contentType);
  headers.set('Content-Length', String(bytes.byteLength));
  headers.set('Cache-Control', 'public, max-age=0, s-maxage=0, must-revalidate');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Disposition', `${isImage ? 'inline' : 'attachment'}; filename="${asset.filename.replace(/["\\\r\n]/g, '_')}"`);
  return new Response(bytes, { headers });
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
              .replace(/[^a-zA-Z0-9 ,\-'"]/g, '')
              .slice(0, 100)};`
          : ''
      }}</style>`;
    if (/^G-[A-Z0-9]+$/.test(ga4))
      head += `<script src="/static/js/analytics-consent.js" data-ga4="${ga4}" data-days="${Math.min(730, Math.max(1, Number.parseInt(get('cookie_consent_days'), 10) || 180))}" defer></script>`;
    if (head) html = html.replace('</head>', `${head}</head>`);
    if (whatsapp.length >= 8 && whatsapp.length <= 15)
      html = html.replace(
        '</body>',
        `<a class="mayfair-whatsapp" href="https://wa.me/${whatsapp}?text=${whatsappMessage}" target="_blank" rel="noopener noreferrer" aria-label="Contact us on WhatsApp">WhatsApp&nbsp; ↗</a></body>`,
      );
    if (get('cookie_banner_enabled', 'on') !== 'off') {
      const safeLink = (value: string, fallback: string) =>
        (value.startsWith('/') && !value.startsWith('//')) || /^https:\/\//i.test(value)
          ? value
          : fallback;
      const text = (key: string, fallback: string, max: number) =>
        escape((get(key).trim() || fallback).slice(0, max));
      const position = ['bottom-left', 'bottom', 'center'].includes(get('cookie_banner_position'))
        ? get('cookie_banner_position')
        : 'bottom-left';
      const days = Math.min(
        730,
        Math.max(1, Number.parseInt(get('cookie_consent_days'), 10) || 180),
      );
      const privacyUrl = safeLink(get('cookie_privacy_url').trim(), '/legal/privacy');
      const cookieUrl = safeLink(get('cookie_policy_url').trim(), '/legal/cookies');
      const termsUrl = safeLink(get('cookie_terms_url').trim(), '/legal/terms');
      html = html.replace(
        '</body>',
        `<aside class="cookie-banner" id="analytics-consent" data-position="${position}" data-days="${days}" data-ga4="${/^G-[A-Z0-9]+$/.test(ga4) ? ga4 : ''}" hidden role="dialog" aria-modal="false" aria-labelledby="cookie-title" aria-describedby="cookie-text"><div class="cookie-banner-body"><strong id="cookie-title">${text('cookie_banner_title', 'Your privacy matters', 80)}</strong><p id="cookie-text">${text('cookie_banner_text', 'We use essential cookies to run this site. With your consent we also use analytics cookies to understand how it is used.', 600)}</p><p class="cookie-links"><a href="${escape(privacyUrl)}">Privacy notice</a><a href="${escape(cookieUrl)}">Cookie notice</a><a href="${escape(termsUrl)}">Terms of use</a></p></div><div class="cookie-actions"><button type="button" class="cookie-btn cookie-btn-ghost" data-consent="reject">${text('cookie_reject_label', 'Reject non-essential', 40)}</button><button type="button" class="cookie-btn cookie-btn-primary" data-consent="accept">${text('cookie_accept_label', 'Accept all', 40)}</button></div></aside><script src="/static/js/analytics-consent-ui.js" defer></script></body>`,
      );
    }
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
