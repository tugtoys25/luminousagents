import type { Context } from 'hono';
import { z } from 'zod';
import type { Env } from '../env';
import {
  insertUserAudit,
  findSignedInUser,
} from './portal-repo';
import { readCookie, sha256Hex } from './password';
import { STAFF_COOKIE, STAFF_SESSION_SECONDS } from './staff-session';

export type Kind = 'staff' | 'buyer';
export type App = { Bindings: Env; Variables: { requestId: string } };
export const now = () => new Date().toISOString();
export const newId = () => crypto.randomUUID();
export const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
  );

export const BUYER_COOKIE = 'mayfair_buyer_session';
export const BUYER_SESSION_SECONDS = 12 * 60 * 60;
export const PRIVACY_VERSION = '2026-10-10-v1';
export const cookieFor = (kind: Kind) => (kind === 'staff' ? STAFF_COOKIE : BUYER_COOKIE);
export const sessionSeconds = (kind: Kind) =>
  kind === 'staff' ? STAFF_SESSION_SECONDS : BUYER_SESSION_SECONDS;

export const emailSchema = z.string().trim().email().max(254);
export const passwordField = z.string().min(1).max(200);

export const err = (
  c: Context<App>,
  status: 400 | 401 | 403 | 404 | 409 | 410 | 422 | 429 | 503,
  code: string,
  message: string,
) => c.json({ error: { code, message }, requestId: c.get('requestId') }, status);

/** Returns true when the limit has been reached; otherwise records an attempt. */
export async function throttled(
  env: Env,
  key: string,
  limit: number,
  ttlSeconds: number,
): Promise<boolean> {
  const hashed = `${key.split(':')[0]}:${await sha256Hex(key)}`;
  const attempts = Number.parseInt((await env.CACHE.get(hashed)) ?? '0', 10) || 0;
  if (attempts >= limit) return true;
  await env.CACHE.put(hashed, String(attempts + 1), { expirationTtl: ttlSeconds });
  return false;
}
export const clientIp = (c: Context<App>) => c.req.header('cf-connecting-ip') ?? 'unknown';

export async function auditEvent(
  env: Env,
  c: Context<App>,
  kind: Kind | 'public',
  userId: string | null,
  action: string,
  entityId: string,
  details: Record<string, unknown> = {},
) {
  await insertUserAudit(env.DB, {
    id: newId(),
    actorUserId: userId,
    actorType: kind,
    action,
    entityId,
    requestId: c.get('requestId'),
    detailsJson: JSON.stringify(details),
    timestamp: now(),
  });
}

/** Resolves the currently signed-in user for a kind, regardless of must_change_password. */
export async function currentUser(c: Context<App>, kind: Kind) {
  const token = readCookie(c.req.header('cookie'), cookieFor(kind));
  if (!token) return null;
  return findSignedInUser(c.env.DB, { tokenHash: await sha256Hex(token), kind, timestamp: now() });
}
