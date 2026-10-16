import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../env';
import { verifyTurnstileToken } from '../security/turnstile-core';
import { findPublishedOpportunity, insertEnquiryBundle } from './repo';

const enquiries = new Hono<{ Bindings: Env; Variables: { requestId: string } }>();
const enquirySchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(254),
  company: z.string().trim().max(160).optional().default(''),
  message: z.string().trim().min(10).max(5000),
  opportunity: z.string().trim().max(120).optional().default(''),
  consent: z.union([z.literal('on'), z.literal('true'), z.literal('1')]),
  website: z.string().max(0).optional().default(''),
});
const isoNow = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();
function oneWorkingDayLater(from: Date): string {
  const due = new Date(from);
  do {
    due.setUTCDate(due.getUTCDate() + 1);
  } while (due.getUTCDay() === 0 || due.getUTCDay() === 6);
  due.setUTCHours(16, 0, 0, 0);
  return due.toISOString();
}

async function keyedHash(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

enquiries.post('/api/enquiries', async (c) => {
  const contentType = c.req.header('content-type') ?? '';
  let raw: Record<string, unknown>;
  if (contentType.includes('application/json'))
    raw = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  else {
    const body = await c.req.parseBody().catch(() => ({}));
    raw = Object.fromEntries(
      Object.entries(body).map(([key, value]) => [key, typeof value === 'string' ? value : '']),
    );
  }
  if (typeof raw.website === 'string' && raw.website.trim()) {
    if (contentType.includes('application/json')) return c.json({ data: { accepted: true } }, 202);
    return c.redirect('/contact?submitted=1', 303);
  }
  const parsed = enquirySchema.safeParse(raw);
  if (!parsed.success) {
    if (contentType.includes('application/json'))
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'Check the required fields and consent.' } },
        422,
      );
    return c.redirect('/contact?error=validation', 303);
  }
  const remoteIp = c.req.header('cf-connecting-ip');
  const secret = c.env.IP_HASH_SECRET;
  if (['staging', 'production'].includes(c.env.APP_ENV ?? '') && !secret)
    return c.json(
      {
        error: {
          code: 'SERVICE_NOT_CONFIGURED',
          message: 'The enquiry service is temporarily unavailable.',
        },
        requestId: c.get('requestId'),
      },
      503,
    );
  const rateKey =
    secret && remoteIp
      ? await keyedHash(secret, remoteIp)
      : remoteIp
        ? await crypto.subtle
            .digest('SHA-256', new TextEncoder().encode(remoteIp))
            .then((d) =>
              Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join(''),
            )
        : 'unknown';
  const rateLimitKey = `enquiry-rate:${rateKey}`;
  const rateState = await c.env.CACHE.get(rateLimitKey);
  const rateCount = Number.parseInt(rateState ?? '0', 10) || 0;
  if (rateCount >= 5)
    return c.json(
      {
        error: { code: 'RATE_LIMITED', message: 'Please wait before sending another enquiry.' },
        requestId: c.get('requestId'),
      },
      429,
    );
  await c.env.CACHE.put(rateLimitKey, String(rateCount + 1), { expirationTtl: 600 });
  const token =
    typeof raw['cf-turnstile-response'] === 'string' ? raw['cf-turnstile-response'] : '';
  const outcome = await verifyTurnstileToken(c.env, token, remoteIp);
  if (outcome === 'unconfigured')
    return c.json(
      {
        error: {
          code: 'SERVICE_NOT_CONFIGURED',
          message: 'The enquiry service is temporarily unavailable.',
        },
        requestId: c.get('requestId'),
      },
      503,
    );
  if (outcome !== 'ok') {
    if (contentType.includes('application/json'))
      return c.json(
        {
          error: {
            code: 'CHALLENGE_FAILED',
            message: 'Complete the security check and try again.',
          },
        },
        422,
      );
    return c.redirect('/contact?error=challenge', 303);
  }

  const opportunity = parsed.data.opportunity
    ? await findPublishedOpportunity(c.env.DB, parsed.data.opportunity)
    : null;
  const opportunityId = opportunity?.id ?? null;
  const assignedBrokerId = opportunity?.assignedBrokerId ?? null;
  const enquiryId = uuid();
  const jobId = uuid();
  const acknowledgementJobId = uuid();
  const brokerJobId = assignedBrokerId ? uuid() : null;
  const timestamp = isoNow();
  const ipHash = secret && remoteIp ? await keyedHash(secret, remoteIp) : null;
  await insertEnquiryBundle(c.env.DB, {
    enquiryId,
    opportunityId,
    opportunityTitle: opportunity?.title ?? '',
    assignedBrokerId,
    name: parsed.data.name,
    email: parsed.data.email.toLowerCase(),
    company: parsed.data.company,
    message: parsed.data.message,
    ipHash,
    requestId: c.get('requestId'),
    taskId: uuid(),
    auditId: uuid(),
    jobId,
    acknowledgementJobId,
    brokerJobId,
    timestamp,
    dueAt: oneWorkingDayLater(new Date(timestamp)),
  });
  try {
    await c.env.NOTIFICATIONS_QUEUE.send({ type: 'enquiry.received', jobId });
  } catch {
    /* Durable job row remains available for recovery. */
  }
  try {
    await c.env.NOTIFICATIONS_QUEUE.send({
      type: 'enquiry.acknowledgement',
      jobId: acknowledgementJobId,
    });
  } catch {
    /* Durable job row remains available for recovery. */
  }
  if (brokerJobId) {
    try {
      await c.env.NOTIFICATIONS_QUEUE.send({ type: 'enquiry.assigned', jobId: brokerJobId });
    } catch {
      /* Scheduled recovery will enqueue the durable job. */
    }
  }
  if (contentType.includes('application/json'))
    return c.json({ data: { accepted: true, reference: enquiryId } }, 202);
  return c.redirect('/contact?submitted=1', 303);
});
export default enquiries;
