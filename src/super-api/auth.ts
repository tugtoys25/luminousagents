import type { Env } from '../env';
import { constantTimeEqual, hmacSha256Hex, sha256Hex } from './crypto';
import { consumeNonce, consumeRateSlot } from './super-repo';

const TIMESTAMP_WINDOW_MS = 5 * 60_000;
const RATE_LIMIT_MAX = 120;

export type SuperAuthResult = { ok: true; credentialId: string } | { ok: false; status: 401 | 429 | 503; reason: string };

/**
 * Verifies a control plane request. Headers: Authorization: Bearer <credential id>, X-Lummet-Timestamp (unix ms),
 * X-Lummet-Nonce, X-Lummet-Signature = hex HMAC-SHA256 of
 *   METHOD \n PATH \n TIMESTAMP \n NONCE \n SHA256_HEX(BODY)
 * under SUPER_API_SECRET. The nonce is consumed only after the signature is correct, so unsigned traffic cannot fill the table.
 */
export async function verifySuperRequest(request: Request, env: Env, path: string, bodyText: string): Promise<SuperAuthResult> {
  const credentialId = env.SUPER_API_CREDENTIAL_ID;
  const secret = env.SUPER_API_SECRET;
  if (!credentialId || !secret) return { ok: false, status: 503, reason: 'not_configured' };

  const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.get('Authorization') ?? '');
  const presented = bearer?.[1]?.trim() ?? '';
  const timestampHeader = request.headers.get('X-Lummet-Timestamp') ?? '';
  const nonce = request.headers.get('X-Lummet-Nonce') ?? '';
  const signature = request.headers.get('X-Lummet-Signature') ?? '';
  if (!presented || !timestampHeader || !nonce || !signature) return { ok: false, status: 401, reason: 'missing_credentials' };
  if (!constantTimeEqual(presented, credentialId)) return { ok: false, status: 401, reason: 'unknown_credential' };

  const timestamp = Number(timestampHeader);
  const now = Date.now();
  if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > TIMESTAMP_WINDOW_MS) return { ok: false, status: 401, reason: 'stale_timestamp' };

  const canonical = [request.method.toUpperCase(), path, String(timestamp), nonce, await sha256Hex(bodyText)].join('\n');
  if (!constantTimeEqual(signature.toLowerCase(), await hmacSha256Hex(secret, canonical))) return { ok: false, status: 401, reason: 'bad_signature' };

  if (!(await consumeNonce(env.DB, presented, nonce, now))) return { ok: false, status: 401, reason: 'replayed_nonce' };
  if (!(await consumeRateSlot(env.DB, presented, now, RATE_LIMIT_MAX))) return { ok: false, status: 429, reason: 'rate_limited' };
  return { ok: true, credentialId: presented };
}

/** A pushed payload (site access, storage limit) is signed with the same secret over JSON.stringify(payload). */
export async function payloadSignatureValid(env: Env, payload: unknown, signature: unknown): Promise<boolean> {
  if (!env.SUPER_API_SECRET || typeof signature !== 'string') return false;
  return constantTimeEqual(signature.toLowerCase(), await hmacSha256Hex(env.SUPER_API_SECRET, JSON.stringify(payload)));
}
