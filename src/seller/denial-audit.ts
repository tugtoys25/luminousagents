import type { MiddlewareHandler } from 'hono';
import type { AdminApp } from '../admin/shared';
import { recordDenial } from './audit-repo';

/** Replaces record identifiers (references and UUIDs) so the audit row stores the route shape, never which record was targeted. */
export const routePattern = (path: string): string =>
  path.split('/').map((seg) => (/^(CM-[SCAMP]-[A-Z0-9]{6}|[0-9a-f-]{32,36})$/i.test(seg) ? ':id' : seg)).join('/');

/**
 * Records every 403 from a seller route (role refusals and missing step-up). Best effort: a failure to audit never changes the response.
 * Out-of-scope records return 404 by design (so brokers cannot probe), and those are intentionally not logged as denials.
 */
export const auditSellerDenials: MiddlewareHandler<AdminApp> = async (c, next) => {
  await next();
  if (c.res.status !== 403) return;
  const staff = c.get('staff');
  if (!staff) return;
  let code = 'FORBIDDEN';
  try {
    const body = (await c.res.clone().json()) as { error?: { code?: string } };
    code = body.error?.code ?? code;
  } catch { /* non-JSON refusal */ }
  try {
    await recordDenial(c.env.DB, { id: crypto.randomUUID(), actorId: staff.id, role: staff.role, method: c.req.method, routePath: routePattern(c.req.path), code, requestId: c.get('requestId'), ts: new Date().toISOString() });
  } catch { /* never turn a refusal into an error */ }
};
