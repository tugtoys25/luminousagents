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
    path === '/healthz';
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
