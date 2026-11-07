import type { Hono } from 'hono';
import type { Env } from '../env';
import routes from './routes';
import { currentAccessState, wouldExceedLimit } from './state';

type App = Hono<{ Bindings: Env; Variables: { requestId: string } }>;
const SUPER_PREFIX = '/en/api/super';
const FILE_PREFIXES = ['/dashboard', '/api/'];

const blockedPage = (title: string, message: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem;text-align:center"><h1>${title}</h1><p>${message}</p></body></html>`;

/**
 * Mounts the control plane surface: the signed Super API, and a gate in front of everything else that (1) serves a
 * suspended or closed site's holding page and (2) refuses file uploads that would pass the plan's storage cap.
 * /healthz and the Super API itself are never gated, so a suspended site still answers health checks and can be resumed.
 */
export function mountSuperApi(app: App): void {
  app.use('*', async (c, next) => {
    const path = new URL(c.req.url).pathname;
    if (path === '/healthz' || path === SUPER_PREFIX || path.startsWith(`${SUPER_PREFIX}/`)) return next();
    const state = await currentAccessState(c.env);
    if (state !== 'serving') {
      const closed = state === 'closed';
      const wantsHtml = (c.req.header('accept') ?? '').includes('text/html');
      const status = closed ? 410 : 503;
      const title = closed ? 'This site is closed' : 'Temporarily unavailable';
      const message = closed ? 'This site is no longer available.' : 'This site is temporarily unavailable. Please try again later.';
      c.header('Cache-Control', 'no-store');
      if (!closed) c.header('Retry-After', '3600');
      return wantsHtml ? c.html(blockedPage(title, message), status) : c.json({ error: { code: closed ? 'SITE_CLOSED' : 'SITE_SUSPENDED', message } }, status);
    }
    const isUpload = ['POST', 'PUT'].includes(c.req.method) && (c.req.header('content-type') ?? '').startsWith('multipart/form-data');
    if (isUpload && FILE_PREFIXES.some((prefix) => path.startsWith(prefix))) {
      const length = Number.parseInt(c.req.header('content-length') ?? '0', 10);
      if (Number.isFinite(length) && length > 0 && (await wouldExceedLimit(c.env, length))) {
        return c.json({ error: { code: 'STORAGE_LIMIT_REACHED', message: 'The storage included in this plan is full. Delete files or upgrade the plan.' } }, 413);
      }
    }
    return next();
  });
  app.route(SUPER_PREFIX, routes);
}
