import { Hono } from 'hono';
import type { Env } from '../env';
import { brandFromSettings, buildManifest, type BrandValues } from './branding';

const KEYS = [
  'site_name',
  'logo_url',
  'favicon_url',
  'favicon_svg_url',
  'apple_touch_icon_url',
  'icon_192_url',
  'icon_512_url',
];

async function loadBrand(env: Env): Promise<BrandValues> {
  const values = new Map<string, string>();
  try {
    const rows = await env.DB.prepare(
      `SELECT setting_key AS key, value_json AS value FROM platform_settings WHERE setting_key IN (${KEYS.map(() => '?').join(',')})`,
    )
      .bind(...KEYS)
      .all<{ key: string; value: string }>();
    for (const row of rows.results ?? []) {
      try {
        const parsed: unknown = JSON.parse(row.value);
        if (typeof parsed === 'string') values.set(row.key, parsed);
      } catch {
        /* ignore malformed setting */
      }
    }
  } catch {
    /* settings table unavailable: nothing configured */
  }
  return brandFromSettings((key) => values.get(key) ?? '');
}

const brandingRoutes = new Hono<{ Bindings: Env }>();

/** Web app manifest: the static manifest's values plus the configured name and icons. */
brandingRoutes.get('/manifest.webmanifest', async (c) => {
  const manifest = buildManifest(await loadBrand(c.env));
  return c.body(JSON.stringify(manifest, null, 2), 200, {
    'Content-Type': 'application/manifest+json; charset=utf-8',
    'Cache-Control': 'public, max-age=300',
  });
});

/** Well-known icon URLs browsers request without being told. Nothing configured: normal 404, as before. */
const redirectTo = (target: string, self: string) =>
  target && target !== self
    ? new Response(null, {
        status: 302,
        headers: { Location: target, 'Cache-Control': 'public, max-age=300' },
      })
    : null;

brandingRoutes.get('/favicon.ico', async (c, next) => {
  const b = await loadBrand(c.env);
  const hit = redirectTo(b.favicon || b.faviconSvg || b.icon192 || b.apple, '/favicon.ico');
  return hit ?? next();
});

for (const path of ['/apple-touch-icon.png', '/apple-touch-icon-precomposed.png']) {
  brandingRoutes.get(path, async (c, next) => {
    const b = await loadBrand(c.env);
    const hit = redirectTo(b.apple || b.icon192 || b.icon512, path);
    return hit ?? next();
  });
}

export default brandingRoutes;
