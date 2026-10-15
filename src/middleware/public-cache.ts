import type { MiddlewareHandler } from 'hono';
import type { Env } from '../env';

/** Short CDN caching only for anonymous GET routes; private APIs and workspaces remain no-store. */
export const publicCacheMiddleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  await next();
  const path = new URL(c.req.url).pathname;
  const method = c.req.method.toUpperCase();
  const privatePath =
    path.startsWith('/api/') ||
    path.startsWith('/dashboard') ||
    path.startsWith('/account') ||
    path.startsWith('/media/') ||
    path.startsWith('/admin/') ||
    path === '/register' ||
    path === '/forgot-password' ||
    path === '/reset-password' ||
    path === '/healthz';
  // Public media handlers set their own revalidating policy and an ETag (derived from the stored SHA-256),
  // so repeat views are answered with 304. Anything else under /media/ stays no-store as before.
  if (
    method === 'GET' &&
    path.startsWith('/media/') &&
    (c.res.status === 200 || c.res.status === 304) &&
    c.res.headers.has('ETag')
  )
    return;
  if (
    method === 'GET' &&
    !privatePath &&
    c.res.status >= 200 &&
    c.res.status < 400 &&
    c.res.headers.get('Set-Cookie') === null
  ) {
    c.header('Cache-Control', 'public, max-age=0, s-maxage=60, stale-while-revalidate=30');
    c.header('Vary', 'Accept-Encoding');
  } else {
    c.header('Cache-Control', 'no-store');
  }
};
