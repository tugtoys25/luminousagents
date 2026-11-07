import { Hono } from 'hono';
import type { Env } from '../env';
import { BRAND } from '../brand/defaults';
import { loggerFor } from '../lib/logger';
import { payloadSignatureValid, verifySuperRequest } from './auth';
import { applySiteAccess, readLimit } from './state';
import { pingDatabase, usedBytes, writeState } from './super-repo';

export const SUPER_API_VERSION = 1;
export const SUPER_CAPABILITIES = ['handshake', 'health', 'capabilities', 'site_access_state', 'storage_limit', 'storage_usage'] as const;
const DAY_MS = 24 * 60 * 60_000;

type Ctx = { Bindings: Env; Variables: { superBody: string } };
const routes = new Hono<Ctx>();

/** Every route below this point is signed server-to-server traffic from the control plane; nothing else may reach it. */
routes.use('*', async (c, next) => {
  const bodyText = ['GET', 'HEAD'].includes(c.req.method) ? '' : await c.req.text();
  const path = new URL(c.req.url).pathname;
  const auth = await verifySuperRequest(c.req.raw, c.env, path, bodyText);
  if (!auth.ok) {
    loggerFor(c.env).warn('super_api_rejected', { reason: auth.reason, path });
    // A uniform, generic answer: the reason is logged, never explained to the caller.
    return c.json({ success: false, error: auth.status === 503 ? 'not_configured' : auth.status === 429 ? 'rate_limited' : 'unauthorized' }, auth.status);
  }
  c.set('superBody', bodyText);
  c.header('Cache-Control', 'no-store');
  return next();
});

const parse = (text: string): Record<string, unknown> => {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const freshIssuedAt = (p: Record<string, unknown>) => finite(p['issuedAt']) && Date.now() - p['issuedAt'] <= DAY_MS && p['issuedAt'] <= Date.now() + 5 * 60_000;

routes.get('/handshake', (c) => {
  const base = c.env.PUBLIC_BASE_URL ?? c.req.url;
  const host = new URL(base).hostname;
  return c.json({
    success: true,
    platform: 'luminousagents-brokerage',
    host,
    site_name: BRAND.name,
    deployment_id: c.env.DEPLOYMENT_ID ?? host,
    api_version: SUPER_API_VERSION,
    capabilities: [...SUPER_CAPABILITIES],
  });
});

routes.get('/health', async (c) => {
  try {
    await pingDatabase(c.env.DB);
    return c.json({ success: true, status: 'online' });
  } catch {
    return c.json({ success: false, error: 'database_unavailable' }, 503);
  }
});

routes.get('/capabilities', (c) =>
  c.json({ success: true, api_version: SUPER_API_VERSION, capabilities: Object.fromEntries(SUPER_CAPABILITIES.map((k) => [k, true])) }),
);

routes.put('/site-access-state', async (c) => {
  const body = parse(c.get('superBody'));
  const p = (body['payload'] ?? null) as Record<string, unknown> | null;
  const state = String(p?.['state']);
  const generation = p?.['generation'];
  if (!p || !['serving', 'suspended', 'closed'].includes(state) || !finite(generation) || generation < 1 || !finite(p['issuedAt'])) {
    return c.json({ success: false, error: 'invalid_site_access_state' }, 422);
  }
  if (!freshIssuedAt(p)) return c.json({ success: false, error: 'stale_site_access_state' }, 422);
  if (!(await payloadSignatureValid(c.env, p, body['signature']))) return c.json({ success: false, error: 'invalid_site_access_signature' }, 401);
  const applied = await applySiteAccess(c.env, state as 'serving' | 'suspended' | 'closed', generation);
  return c.json(applied ? { success: true, accepted: true, generation } : { success: true, accepted: false, reason: 'stale_generation' });
});

routes.put('/storage-limit', async (c) => {
  const body = parse(c.get('superBody'));
  const p = (body['payload'] ?? null) as Record<string, unknown> | null;
  const max = p?.['maxBytes'];
  const generation = p?.['generation'];
  const maxOk = max === null || (typeof max === 'number' && Number.isSafeInteger(max) && max >= 0);
  if (!p || p['purpose'] !== 'storage_limit' || !maxOk || !finite(generation) || !Number.isSafeInteger(generation) || generation < 1 || !finite(p['issuedAt'])) {
    return c.json({ success: false, error: 'invalid_storage_limit' }, 422);
  }
  if (!freshIssuedAt(p)) return c.json({ success: false, error: 'stale_storage_limit' }, 422);
  if (!(await payloadSignatureValid(c.env, p, body['signature']))) return c.json({ success: false, error: 'invalid_storage_limit_signature' }, 401);
  const applied = await writeState(c.env.DB, 'storage_limit', JSON.stringify({ maxBytes: max }), generation, new Date().toISOString());
  if (applied) return c.json({ success: true, accepted: true, generation });
  const current = await readLimit(c.env.DB);
  return c.json({ success: true, accepted: false, reason: current.generation === generation ? 'already_applied' : 'stale_generation', generation: current.generation });
});

routes.get('/storage-usage', async (c) => {
  try {
    const [used, limit] = await Promise.all([usedBytes(c.env.DB), readLimit(c.env.DB)]);
    return c.json({
      success: true,
      day: new Date().toISOString().slice(0, 10),
      usedBytes: used,
      reservedBytes: 0,
      limitBytes: limit.maxBytes,
      limitGeneration: limit.generation,
      mode: (c.env.STORAGE_METERING_MODE ?? 'enforce').toLowerCase(),
    });
  } catch {
    return c.json({ success: false, error: 'storage_metering_unavailable' }, 503);
  }
});

export default routes;
