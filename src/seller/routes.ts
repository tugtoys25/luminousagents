import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import type { Env } from '../env';
import { JOB_ACK, JOB_INTERNAL_ALERT, findByIdempotencyHash, insertSellerEnquiry, isUniqueViolation } from './repo';
import { generateReference, keyedHash } from './reference';
import { MAX_BODY_BYTES, fieldErrors, normaliseSellerEnquiry, sellerEnquirySchema } from './schema';

const seller = new Hono<{ Bindings: Env; Variables: { requestId: string } }>();
export const SELLER_SUBMIT_PATH = '/api/sell-a-casino';
const RATE_LIMIT = 5;
const RATE_WINDOW_SECONDS = 600;

type SellerContext = Context<{ Bindings: Env; Variables: { requestId: string } }>;
type FailStatus = 400 | 413 | 415 | 422 | 429 | 500 | 503;
const fail = (c: SellerContext, status: FailStatus, code: string, message: string, extra: Record<string, unknown> = {}) =>
  c.json({ error: { code, message, ...extra }, requestId: c.get('requestId') }, status);

/** Cheap pre-parse guard using the declared length; the handler re-checks the real byte length. */
export const sellerBodyLimit: MiddlewareHandler = async (c, next) => {
  if (c.req.method === 'POST' && Number.parseInt(c.req.header('content-length') ?? '0', 10) > MAX_BODY_BYTES)
    return c.json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'The submission is too large.' } }, 413);
  await next();
};

seller.post(SELLER_SUBMIT_PATH, async (c) => {
  if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json'))
    return fail(c, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Unsupported request format.');
  const declared = Number.parseInt(c.req.header('content-length') ?? '0', 10);
  if (declared > MAX_BODY_BYTES) return fail(c, 413, 'PAYLOAD_TOO_LARGE', 'The submission is too large.');
  const bodyText = await c.req.text().catch(() => null);
  if (bodyText === null || new TextEncoder().encode(bodyText).byteLength > MAX_BODY_BYTES)
    return fail(c, 413, 'PAYLOAD_TOO_LARGE', 'The submission is too large.');
  let raw: unknown;
  try {
    raw = JSON.parse(bodyText);
  } catch {
    return fail(c, 400, 'INVALID_REQUEST', 'The submission could not be read.');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fail(c, 400, 'INVALID_REQUEST', 'The submission could not be read.');
  const body = raw as Record<string, unknown>;
  // Honeypot: look successful, store nothing.
  if (typeof body.website === 'string' && body.website.trim()) return c.json({ data: { accepted: true } }, 202);

  const secret = c.env.IP_HASH_SECRET;
  if (!secret && c.env.APP_ENV !== 'dev') return fail(c, 503, 'SERVICE_NOT_CONFIGURED', 'The enquiry service is temporarily unavailable.');
  const hashSecret = secret ?? 'dev-only-seller-hash-secret';

  // Unknown fields (including the Turnstile token, already verified by middleware) are stripped by the schema.
  const parsed = sellerEnquirySchema.safeParse(body);
  if (!parsed.success) return fail(c, 422, 'VALIDATION_ERROR', 'Please correct the highlighted fields.', { fields: fieldErrors(parsed.error) });

  // Per-IP pseudonymous rate limit. cf-connecting-ip is set by Cloudflare; it is not trusted from other proxies.
  const ip = c.req.header('cf-connecting-ip');
  const ipHash = ip ? await keyedHash(hashSecret, ip) : null;
  const rateKey = `seller-rate:${ipHash ?? 'unknown'}`;
  const count = Number.parseInt((await c.env.CACHE.get(rateKey)) ?? '0', 10) || 0;
  if (count >= RATE_LIMIT) return fail(c, 429, 'RATE_LIMITED', 'Please wait before sending another enquiry.');
  await c.env.CACHE.put(rateKey, String(count + 1), { expirationTtl: RATE_WINDOW_SECONDS });

  const idempotencyHash = await keyedHash(hashSecret, `seller-idem:${parsed.data.idempotency_key}`);
  // A repeat of the same browser submission gets the same neutral success; nothing about other submitters is revealed.
  const existing = await findByIdempotencyHash(c.env.DB, idempotencyHash);
  if (existing) return c.json({ data: { accepted: true, reference: existing.reference } }, 202);

  const data = normaliseSellerEnquiry(parsed.data, c.env.SELLER_MARKETING_CONSENT_ENABLED === 'true');
  const id = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const ackJobId = crypto.randomUUID();
  const alertJobId = crypto.randomUUID();
  for (let attempt = 0; attempt < 5; attempt++) {
    const reference = generateReference();
    try {
      await insertSellerEnquiry(c.env.DB, {
        id, reference, data, idempotencyHash, sourceIpHash: ipHash, requestId: c.get('requestId'),
        auditId: crypto.randomUUID(), ackJobId, alertJobId, timestamp,
      });
    } catch (error) {
      if (!isUniqueViolation(error)) {
        console.error('seller_enquiry_persist_failed', { requestId: c.get('requestId'), errorType: error instanceof Error ? error.name : 'UnknownError' });
        return fail(c, 500, 'SUBMISSION_FAILED', 'We could not record your enquiry. Please try again later.');
      }
      // Concurrent duplicate submission with the same key wins; otherwise it was a reference collision: retry.
      const concurrent = await findByIdempotencyHash(c.env.DB, idempotencyHash);
      if (concurrent) return c.json({ data: { accepted: true, reference: concurrent.reference } }, 202);
      continue;
    }
    // Persisted first. Enqueue is best-effort; the durable job rows are recovered by the scheduled recovery job.
    for (const [jobId, type] of [[ackJobId, JOB_ACK], [alertJobId, JOB_INTERNAL_ALERT]] as const) {
      try {
        await c.env.NOTIFICATIONS_QUEUE.send({ jobId, type });
      } catch {
        console.warn('seller_enquiry_enqueue_deferred', { requestId: c.get('requestId'), type });
      }
    }
    return c.json({ data: { accepted: true, reference } }, 202);
  }
  return fail(c, 500, 'SUBMISSION_FAILED', 'We could not record your enquiry. Please try again later.');
});

export default seller;
