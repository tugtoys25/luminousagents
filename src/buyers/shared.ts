import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env } from '../env';
import { touchSession } from '../auth/staff-session-repo';
import { findBuyerSession, insertBuyerAudit } from './buyers-repo';


export type Buyer = {
  id: string;
  email: string;
  displayName: string;
  status: string;
  hasPassword: number;
};
export type BuyerApp = { Bindings: Env; Variables: { requestId: string; buyer: Buyer } };
export const now = () => new Date().toISOString();
export const uuid = () => crypto.randomUUID();
export const jsonError = (
  c: Context<BuyerApp>,
  status: ContentfulStatusCode,
  code: string,
  message: string,
) => c.json({ error: { code, message }, requestId: c.get('requestId') }, status);
export async function digest(value: string): Promise<string> {
  const result = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(result), (b) => b.toString(16).padStart(2, '0')).join('');
}
export function readCookie(header: string | undefined, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=') || null;
  }
  return null;
}
export async function buyerAuth(c: Context<BuyerApp>): Promise<Buyer | Response> {
  const token = readCookie(c.req.header('cookie'), 'mayfair_buyer_session');
  if (!token) return jsonError(c, 401, 'UNAUTHENTICATED', 'Buyer sign-in required.');
  const tokenHash = await digest(token);
  const row = await findBuyerSession(c.env.DB, tokenHash, now());
  if (!row) return jsonError(c, 401, 'UNAUTHENTICATED', 'Buyer session is invalid or expired.');
  await touchSession(c.env.DB, row.sessionId, now());
  if (row.mustChange === 1)
    return jsonError(
      c,
      403,
      'PASSWORD_CHANGE_REQUIRED',
      'Change your temporary password before continuing.',
    );
  const { sessionId: _sessionId, mustChange: _mustChange, ...buyer } = row;
  return buyer;
}
export async function requireBuyer(c: Context<BuyerApp>, next: () => Promise<void>) {
  const identity = await buyerAuth(c);
  if (identity instanceof Response) return identity;
  c.set('buyer', identity);
  await next();
}
export async function audit(
  c: Context<BuyerApp>,
  action: string,
  entityType: string,
  entityId: string,
  details: Record<string, unknown> = {},
) {
  await insertBuyerAudit(c.env.DB, {
    id: uuid(),
    buyerId: c.get('buyer').id,
    action,
    entityType,
    entityId,
    requestId: c.get('requestId'),
    detailsJson: JSON.stringify(details),
    timestamp: now(),
  });
}

export async function digestBytes(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), (value) => value.toString(16).padStart(2, '0')).join('');
}
