import { Hono } from 'hono';
import type { Env } from '../../env';
import { slugify } from '../../domain/opportunities/slug';
import { STATIC_PAGES, staticPageSlug } from '../static-pages';
import { findPublicListingImage, loadSitemapData } from '../public-listings-repo';
import type { PublicApp } from './public-shared';
import { SITE_URL } from './public-shared';

const publicPages = new Hono<PublicApp>();

publicPages.get('/media/opportunities/:opportunityId/:mediaId', async (c) => {
  const media = await findPublicListingImage(c.env.DB, c.req.param('mediaId'), c.req.param('opportunityId'));
  if (!media) return c.notFound();
  // ETag from the stored SHA-256: a repeat view is answered before any storage read. Publication state was
  // already checked by the query above, so an unpublished listing image still returns 404.
  const etag = media.sha256 ? `"${media.sha256.toLowerCase()}"` : '';
  if (etag) {
    const candidates = (c.req.header('If-None-Match') ?? '')
      .split(',')
      .map((value) => value.trim().replace(/^W\//, ''));
    if (candidates.includes(etag) || candidates.includes('*')) {
      return new Response(null, {
        status: 304,
        headers: {
          ETag: etag,
          'Cache-Control': 'public, max-age=300',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    }
  }
  const file = await c.env.PRIVATE_FILES.get(media.r2Key);
  if (!file || file.size !== media.byteSize || file.size > 8 * 1024 * 1024) return c.notFound();
  const bytes = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const actual = [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
  if (!media.sha256 || actual !== media.sha256) return c.notFound();
  c.header('Content-Type', media.contentType);
  c.header('Cache-Control', 'public, max-age=300');
  if (etag) c.header('ETag', etag);
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Content-Length', String(bytes.byteLength));
  return c.body(bytes, 200);
});

const xmlEscape = (value: string) => value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const isoDate = (value: string | null | undefined) => {
  const time = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(time) ? '' : new Date(time).toISOString();
};

/** Canonical origin: configured URL in production; the request origin on staging/dev. */
const siteOrigin = (c: { env: Env; req: { url: string } }) =>
  (
    c.env.PUBLIC_BASE_URL || (c.env.APP_ENV === 'production' ? SITE_URL : new URL(c.req.url).origin)
  ).replace(/\/$/, '');

publicPages.get('/robots.txt', (c) => {
  const baseUrl = siteOrigin(c);
  // Only production is indexable; staging and dev must never appear in search results.
  const body =
    c.env.APP_ENV === 'production'
      ? `User-agent: *\nAllow: /\nDisallow: /dashboard/\nDisallow: /account/\nDisallow: /api/\nDisallow: /admin/\nDisallow: /register\nDisallow: /staff-access\nDisallow: /forms/\nDisallow: /media/\n\nSitemap: ${baseUrl}/sitemap.xml\n`
      : 'User-agent: *\nDisallow: /\n';
  return c.text(body, 200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'public, max-age=300',
  });
});

publicPages.get('/sitemap.xml', async (c) => {
  const baseUrl = siteOrigin(c);
  const entries: { path: string; lastmod?: string; priority?: string }[] = [
    { path: '/', priority: '1.0' },
    { path: '/casinos-for-sale', priority: '0.9' },
    { path: '/casino-hotels', priority: '0.8' },
    { path: '/archive', priority: '0.5' },
    { path: '/services', priority: '0.8' },
    { path: '/about', priority: '0.7' },
    { path: '/faq', priority: '0.6' },
    { path: '/contact', priority: '0.8' },
    ...STATIC_PAGES.filter(([path]) => path.startsWith('/legal/')).map(([path]) => ({
      path,
      priority: '0.3',
    })),
  ];
  try {
    const sitemap = await loadSitemapData(c.env.DB);
    const newest = sitemap.listings[0]?.updatedAt;
    if (entries[1]) entries[1].lastmod = isoDate(newest);
    if (entries[0]) entries[0].lastmod = isoDate(newest);
    if (entries[3]) entries[3].lastmod = isoDate(sitemap.archivedUpdatedAt);
    // Managed pages that override a built-in page are served at the built-in path.
    const builtIn = new Map(STATIC_PAGES.map(([path]) => [staticPageSlug(path), path]));
    for (const row of sitemap.pages) {
      const override = builtIn.get(row.slug);
      if (override) {
        const entry = entries.find((item) => item.path === override);
        if (entry) entry.lastmod = isoDate(row.updatedAt);
      } else {
        entries.push({
          path: `/pages/${encodeURIComponent(row.slug)}`,
          lastmod: isoDate(row.updatedAt),
          priority: '0.5',
        });
      }
    }
    for (const row of sitemap.countries)
      entries.push({
        path: `/casinos-for-sale/${encodeURIComponent(slugify(row.country))}`,
        lastmod: isoDate(row.updatedAt),
        priority: '0.7',
      });
    for (const row of sitemap.listings)
      entries.push({
        path: `/opportunities/${encodeURIComponent(row.slug)}`,
        lastmod: isoDate(row.updatedAt),
        priority: '0.8',
      });
  } catch (error) {
    // Still serve the static URLs if the database is briefly unavailable.
    console.error('sitemap_query_failed', {
      requestId: c.get('requestId'),
      errorType: error instanceof Error ? error.name : 'UnknownError',
    });
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries
    .map(
      (entry) =>
        `<url><loc>${xmlEscape(baseUrl + entry.path)}</loc>${entry.lastmod ? `<lastmod>${entry.lastmod}</lastmod>` : ''}${entry.priority ? `<priority>${entry.priority}</priority>` : ''}</url>`,
    )
    .join('')}</urlset>`;
  return c.body(xml, 200, {
    'Content-Type': 'application/xml; charset=utf-8',
    'Cache-Control': 'public, max-age=300',
  });
});


export default publicPages;
