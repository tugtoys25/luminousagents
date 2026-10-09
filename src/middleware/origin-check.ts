import type { MiddlewareHandler } from 'hono';
import type { Env } from '../env';

/** Browser-facing authenticated APIs accept state-changing requests only from their own origin. */
export const sameOriginMutationMiddleware: MiddlewareHandler<{
  Bindings: Env;
  Variables: { requestId: string };
}> = async (c, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(c.req.method)) return next();
  const origin = c.req.header('origin');
  if (!origin)
    return c.json(
      {
        error: { code: 'ORIGIN_REQUIRED', message: 'A same-origin request is required.' },
        requestId: c.get('requestId'),
      },
      403,
    );
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return c.json(
      {
        error: { code: 'ORIGIN_INVALID', message: 'Request origin is invalid.' },
        requestId: c.get('requestId'),
      },
      403,
    );
  }
  const requestUrl = new URL(c.req.url);
  if (parsed.origin !== requestUrl.origin)
    return c.json(
      {
        error: { code: 'ORIGIN_FORBIDDEN', message: 'Cross-origin state changes are not allowed.' },
        requestId: c.get('requestId'),
      },
      403,
    );
  return next();
};
