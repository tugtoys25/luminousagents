import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../env';

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

async function verifyTurnstile(
  token: string,
  secret: string,
  remoteIp: string | undefined,
): Promise<boolean> {
  if (!token || !secret) return false;
  const form = new FormData();
  form.set('secret', secret);
  form.set('response', token);
  if (remoteIp) form.set('remoteip', remoteIp);
  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: form,
    });
    if (!response.ok) return false;
    const result = (await response.json()) as { success?: boolean };
    return result.success === true;
  } catch {
    return false;
  }
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
  if (c.env.TURNSTILE_SECRET_KEY) {
    if (!(await verifyTurnstile(token, c.env.TURNSTILE_SECRET_KEY, remoteIp))) {
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
  } else if (['staging', 'production'].includes(c.env.APP_ENV ?? ''))
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

  let opportunityId: string | null = null;
  let assignedBrokerId: string | null = null;
  let opportunityTitle = '';
  if (parsed.data.opportunity) {
    const found = await c.env.DB.prepare(
      "SELECT id, assigned_broker_id AS assignedBrokerId, title FROM opportunities WHERE slug = ? AND lifecycle = 'published' AND content_review_status = 'approved' AND public_visibility = 1 LIMIT 1",
    )
      .bind(parsed.data.opportunity)
      .first<{ id: string; assignedBrokerId: string | null; title: string }>();
    opportunityId = found?.id ?? null;
    assignedBrokerId = found?.assignedBrokerId ?? null;
    opportunityTitle = found?.title ?? '';
  }
  const enquiryId = uuid();
  const jobId = uuid();
  const acknowledgementJobId = uuid();
  const brokerJobId = assignedBrokerId ? uuid() : null;
  const taskId = uuid();
  const timestamp = isoNow();
  const dueAt = oneWorkingDayLater(new Date(timestamp));
  const ipHash = secret && remoteIp ? await keyedHash(secret, remoteIp) : null;
  const statements = [
    c.env.DB.prepare(
      "INSERT INTO enquiries (id, opportunity_id, name, email, company, message, source, status, assigned_to, consent_at, ip_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'website', 'new', ?, ?, ?, ?, ?)",
    ).bind(
      enquiryId,
      opportunityId,
      parsed.data.name,
      parsed.data.email.toLowerCase(),
      parsed.data.company,
      parsed.data.message,
      assignedBrokerId,
      timestamp,
      ipHash,
      timestamp,
      timestamp,
    ),
    c.env.DB.prepare(
      "INSERT INTO staff_tasks (id,title,description,status,priority,due_at,assigned_to,related_entity_type,related_entity_id,created_by,created_at,updated_at) VALUES (?,?,?,'open','normal',?,?,?,?,NULL,?,?)",
    ).bind(
      taskId,
      'Review new website enquiry',
      `Enquiry reference: ${enquiryId}${opportunityTitle ? ` · Opportunity: ${opportunityTitle}` : ''}`,
      dueAt,
      assignedBrokerId,
      'enquiry',
      enquiryId,
      timestamp,
      timestamp,
    ),
    c.env.DB.prepare(
      "INSERT INTO audit_logs (id, actor_user_id, actor_type, action, entity_type, entity_id, request_id, details_json, created_at) VALUES (?, NULL, 'public', 'enquiry.created', 'enquiry', ?, ?, ?, ?)",
    ).bind(
      uuid(),
      enquiryId,
      c.get('requestId'),
      JSON.stringify({
        source: 'website',
        hasOpportunity: Boolean(opportunityId),
        assignedBrokerId,
        taskId,
        taskDueAt: dueAt,
      }),
      timestamp,
    ),
    c.env.DB.prepare(
      "INSERT INTO notification_jobs (id, job_type, payload_json, status, attempts, available_at, created_at, updated_at) VALUES (?, 'enquiry.received', ?, 'queued', 0, ?, ?, ?)",
    ).bind(jobId, JSON.stringify({ enquiryId }), timestamp, timestamp, timestamp),
    c.env.DB.prepare(
      "INSERT INTO notification_jobs (id, job_type, payload_json, status, attempts, available_at, created_at, updated_at) VALUES (?, 'enquiry.acknowledgement', ?, 'queued', 0, ?, ?, ?)",
    ).bind(acknowledgementJobId, JSON.stringify({ enquiryId }), timestamp, timestamp, timestamp),
  ];
  if (brokerJobId && assignedBrokerId)
    statements.push(
      c.env.DB.prepare(
        "INSERT INTO notification_jobs (id, job_type, payload_json, status, attempts, available_at, created_at, updated_at) VALUES (?, 'enquiry.assigned', ?, 'queued', 0, ?, ?, ?)",
      ).bind(
        brokerJobId,
        JSON.stringify({ enquiryId, assignedBrokerId }),
        timestamp,
        timestamp,
        timestamp,
      ),
    );
  await c.env.DB.batch(statements);
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
