import type { MiddlewareHandler } from 'hono';
import type { Env } from '../env';

const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,100}$/;

export const requestIdMiddleware: MiddlewareHandler<{
  Bindings: Env;
  Variables: { requestId: string };
}> = async (c, next) => {
  const supplied = c.req.header('x-request-id');
  const requestId = supplied && SAFE_REQUEST_ID.test(supplied) ? supplied : crypto.randomUUID();
  c.set('requestId', requestId);
  c.header('X-Request-ID', requestId);
  await next();
};
