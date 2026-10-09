import { Hono } from 'hono';
import type { Env } from './env';
import { toSafeErrorResponse } from './lib/errors';
import { requestIdMiddleware } from './middleware/request-id';
import { securityHeadersMiddleware } from './middleware/security-headers';
import { publicCacheMiddleware } from './middleware/public-cache';
import { sameOriginMutationMiddleware } from './middleware/origin-check';
import publicPages from './web/pages/public';
import adminRoutes from './admin/routes';
import enquiryRoutes from './enquiries/routes';
import buyerRoutes from './buyers/routes';
import { consumeNotifications, recoverNotificationJobs } from './operations/queue';

const app = new Hono<{ Bindings: Env; Variables: { requestId: string } }>();

app.use('*', requestIdMiddleware);
app.use('*', securityHeadersMiddleware);
app.use('*', publicCacheMiddleware);
app.use('/api/buyer/*', sameOriginMutationMiddleware);
app.use('/dashboard/*', sameOriginMutationMiddleware);

app.get('/healthz', (c) => {
  return c.json({ status: 'ok', service: 'mayfair-platform' }, 200);
});

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
