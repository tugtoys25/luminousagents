import type { Context } from 'hono';
import { safeReturnPath, stepUpDecision, stepUpMessage } from '../auth/step-up-policy';
import type { AdminApp } from '../admin/shared';
import { REFERENCE_PATTERN } from './reference';
import { findRef, type EnquiryRef, type Scope } from './staff-repo';

export type Ctx = Context<AdminApp>;

export const scopeOf = (c: Ctx): Scope => {
  const staff = c.get('staff');
  return { brokerOnly: staff.role === 'broker' ? 1 : 0, staffId: staff.id };
};
export const jsonError = (c: Ctx, status: 400 | 403 | 404 | 409 | 422, code: string, message: string) =>
  c.json({ error: { code, message }, requestId: c.get('requestId') }, status);

/**
 * Resolves `:ref` to an enquiry the actor may access. Unknown, malformed and out-of-scope references all return the
 * same 404 so a broker cannot probe for records assigned to someone else.
 */
export async function loadEnquiry(c: Ctx): Promise<EnquiryRef | Response> {
  const ref = c.req.param('ref') ?? '';
  if (!REFERENCE_PATTERN.test(ref)) return jsonError(c, 404, 'NOT_FOUND', 'Enquiry not found.');
  const found = await findRef(c.env.DB, ref, scopeOf(c));
  return found ?? jsonError(c, 404, 'NOT_FOUND', 'Enquiry not found.');
}

export async function readJson(c: Ctx): Promise<unknown> {
  const text = await c.req.text().catch(() => '');
  if (text.length > 16_384) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/** Inline equivalent of requireRecentMfa for actions that are only sensitive for some inputs. Returns a 403 response, or null if the check passes. */
export function stepUpResponse(c: Ctx, returnTo: string): Response | null {
  if (stepUpDecision(c.get('mfa'), Date.now()) === 'ok') return null;
  return c.json({ error: { code: 'STEP_UP_REQUIRED', message: stepUpMessage(safeReturnPath(returnTo)) }, requestId: c.get('requestId') }, 403);
}
