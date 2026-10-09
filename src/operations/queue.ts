import type { Env } from '../env';

type NotificationJob = {
  id: string;
  job_type: string;
  payload_json: string;
  attempts: number;
  status: string;
};
type QueueEnvelope = { jobId?: string; type?: string };
const now = () => new Date().toISOString();
const decoder = new TextDecoder();
function b64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (ch) => ch.charCodeAt(0));
}
async function decryptPayload(value: string, secret: string): Promise<string> {
  const parsed = JSON.parse(value) as {
    encrypted?: boolean;
    algorithm?: string;
    iv?: string;
    ciphertext?: string;
  };
  if (!parsed.encrypted) return value;
  if (parsed.algorithm !== 'AES-GCM' || !parsed.iv || !parsed.ciphertext)
    throw new Error('Invalid encrypted payload');
  const raw = b64ToBytes(secret);
  if (raw.byteLength !== 32) throw new Error('Invalid OTP encryption key configuration');
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64ToBytes(parsed.iv) },
    key,
    b64ToBytes(parsed.ciphertext),
  );
  return decoder.decode(plaintext);
}
function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
  );
}
async function sendEmail(
  env: Env,
  to: string,
  subject: string,
  html: string,
  text: string,
): Promise<void> {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) throw new Error('Email provider is not configured');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject, html, text }),
  });
  if (!response.ok) throw new Error(`Email provider returned HTTP ${response.status}`);
}
async function renderAndSend(env: Env, job: NotificationJob): Promise<void> {
  const payload = JSON.parse(
    await decryptPayload(job.payload_json, env.OTP_ENCRYPTION_KEY ?? ''),
  ) as Record<string, unknown>;
  if (job.job_type === 'buyer.login_code') {
    const email = String(payload['email'] ?? '');
    const code = String(payload['code'] ?? '');
    if (!email || !/^\d{6}$/.test(code)) throw new Error('Invalid login-code payload');
    await sendEmail(
      env,
      email,
      'Your Casinos of Mayfair sign-in code',
      `<p>Your sign-in code is <strong style="font-size:24px;letter-spacing:4px">${escapeHtml(code)}</strong>.</p><p>It expires in 10 minutes. If you did not request this code, you can ignore this email.</p>`,
      `Your Casinos of Mayfair sign-in code is ${code}. It expires in 10 minutes. If you did not request it, ignore this email.`,
    );
    return;
  }
  if (job.job_type === 'enquiry.acknowledgement') {
    const enquiryId = String(payload['enquiryId'] ?? '');
    if (!enquiryId) throw new Error('Invalid enquiry acknowledgement payload');
    const enquiry = await env.DB.prepare('SELECT id, name, email FROM enquiries WHERE id = ?')
      .bind(enquiryId)
      .first<{ id: string; name: string; email: string }>();
    if (!enquiry) throw new Error('Enquiry record not found');
    const base = (env.PUBLIC_BASE_URL ?? 'https://casinosofmayfair.com').replace(/\/$/, '');
    await sendEmail(
      env,
      enquiry.email,
      'We received your enquiry · Casinos of Mayfair',
      `<p>Dear ${escapeHtml(enquiry.name)},</p><p>Thank you for contacting Casinos of Mayfair. Your enquiry has been received.</p><p><strong>Reference:</strong> ${escapeHtml(enquiry.id)}</p><p>Our team will review your message and follow up as appropriate. Please do not email sensitive or confidential transaction documents until the team has confirmed a secure process.</p><p><a href="${base}">Casinos of Mayfair</a></p>`,
      `Dear ${enquiry.name}, we received your Casinos of Mayfair enquiry. Reference: ${enquiry.id}. Our team will review it and follow up as appropriate. Please do not email confidential transaction documents until a secure process is confirmed.`,
    );
    return;
  }
  if (job.job_type === 'enquiry.assigned') {
    const enquiryId = String(payload['enquiryId'] ?? '');
    const brokerId = String(payload['assignedBrokerId'] ?? '');
    if (!enquiryId || !brokerId) throw new Error('Invalid assigned-enquiry payload');
    const row = await env.DB.prepare(
      "SELECT e.id, e.name, e.email, e.company, o.title AS opportunityTitle, u.email AS brokerEmail FROM enquiries e JOIN users u ON u.id = e.assigned_to LEFT JOIN opportunities o ON o.id = e.opportunity_id WHERE e.id = ? AND u.id = ? AND u.status = 'active' AND u.role = 'broker'",
    )
      .bind(enquiryId, brokerId)
      .first<{
        id: string;
        name: string;
        email: string;
        company: string;
        opportunityTitle: string | null;
        brokerEmail: string;
      }>();
    if (!row) throw new Error('Assigned broker or enquiry record not found');
    const base = (env.PUBLIC_BASE_URL ?? 'https://casinosofmayfair.com').replace(/\/$/, '');
    await sendEmail(
      env,
      row.brokerEmail,
      'New enquiry assigned to you · Casinos of Mayfair',
      `<p>A new website enquiry has been assigned to you.</p><p><strong>Enquiry reference:</strong> ${escapeHtml(row.id)}</p><p><strong>Contact:</strong> ${escapeHtml(row.name)} (${escapeHtml(row.email)})</p><p><strong>Company:</strong> ${escapeHtml(row.company || 'Not provided')}</p><p><strong>Opportunity:</strong> ${escapeHtml(row.opportunityTitle || 'General enquiry')}</p><p><a href="${base}/dashboard/enquiries">Open enquiry CRM</a></p>`,
      `New enquiry ${row.id} assigned to you. Contact: ${row.name} (${row.email}). Company: ${row.company || 'Not provided'}. Opportunity: ${row.opportunityTitle || 'General enquiry'}. Open CRM: ${base}/dashboard/enquiries`,
    );
    return;
  }
  const opsEmail = env.OPS_EMAIL;
  if (!opsEmail) throw new Error('Operations email is not configured');
  if (job.job_type === 'enquiry.received') {
    const enquiryId = String(payload['enquiryId'] ?? '');
    if (!enquiryId) throw new Error('Invalid enquiry notification payload');
    const enquiry = await env.DB.prepare(
      'SELECT name, email, company, message FROM enquiries WHERE id = ?',
    )
      .bind(enquiryId)
      .first<{ name: string; email: string; company: string; message: string }>();
    if (!enquiry) throw new Error('Enquiry record not found');
    const base = (env.PUBLIC_BASE_URL ?? 'https://casinosofmayfair.com').replace(/\/$/, '');
    await sendEmail(
      env,
      opsEmail,
      'New website enquiry · Casinos of Mayfair',
      `<h2>New website enquiry</h2><p><strong>Name:</strong> ${escapeHtml(enquiry.name)}</p><p><strong>Email:</strong> ${escapeHtml(enquiry.email)}</p><p><strong>Company:</strong> ${escapeHtml(enquiry.company || 'Not provided')}</p><p><strong>Message:</strong></p><p>${escapeHtml(enquiry.message).replace(/\n/g, '<br>')}</p><p><a href="${base}/dashboard/enquiries">Open enquiry CRM</a></p>`,
      `New website enquiry from ${enquiry.name} (${enquiry.email}). Company: ${enquiry.company || 'Not provided'}. Message: ${enquiry.message}. Open CRM: ${base}/dashboard/enquiries`,
    );
    return;
  }
  if (job.job_type === 'nda.review_requested') {
    const requestId = String(payload['ndaRequestId'] ?? '');
    if (!requestId) throw new Error('Invalid NDA notification payload');
    const request = await env.DB.prepare(
      'SELECT n.id, u.email, o.title FROM nda_requests n JOIN users u ON u.id = n.user_id JOIN opportunities o ON o.id = n.opportunity_id WHERE n.id = ?',
    )
      .bind(requestId)
      .first<{ id: string; email: string; title: string }>();
    if (!request) throw new Error('NDA request not found');
    const base = (env.PUBLIC_BASE_URL ?? 'https://casinosofmayfair.com').replace(/\/$/, '');
    await sendEmail(
      env,
      opsEmail,
      'NDA review requested · Casinos of Mayfair',
      `<p>A buyer has requested access to an opportunity data room.</p><p><strong>Opportunity:</strong> ${escapeHtml(request.title)}</p><p><strong>Buyer:</strong> ${escapeHtml(request.email)}</p><p><a href="${base}/dashboard/nda-requests">Review NDA requests</a></p>`,
      `NDA review requested for ${request.title} by ${request.email}. Review: ${base}/dashboard/nda-requests`,
    );
    return;
  }
  throw new Error(`Unsupported notification job type: ${job.job_type}`);
}
export async function consumeNotifications(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    const envelope = message.body as QueueEnvelope | null;
    const jobId = envelope?.jobId;
    if (!jobId) {
      message.ack();
      continue;
    }
    const job = await env.DB.prepare(
      'SELECT id, job_type, payload_json, attempts, status FROM notification_jobs WHERE id = ?',
    )
      .bind(jobId)
      .first<NotificationJob>();
    if (!job || job.status === 'sent' || job.status === 'dead' || job.status === 'processing') {
      message.ack();
      continue;
    }
    const claim = await env.DB.prepare(
      "UPDATE notification_jobs SET status = 'processing', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'queued'",
    )
      .bind(now(), job.id)
      .run();
    if ((claim.meta?.changes ?? 0) === 0) {
      message.ack();
      continue;
    }
    try {
      await renderAndSend(env, job);
      await env.DB.prepare(
        "UPDATE notification_jobs SET status = 'sent', updated_at = ? WHERE id = ?",
      )
        .bind(now(), job.id)
        .run();
      message.ack();
    } catch (error) {
      const attempt = job.attempts + 1;
      const dead = attempt >= 5;
      const delay = Math.min(3600, 30 * 2 ** Math.min(attempt - 1, 7));
      await env.DB.prepare(
        'UPDATE notification_jobs SET status = ?, available_at = ?, updated_at = ? WHERE id = ?',
      )
        .bind(
          dead ? 'dead' : 'queued',
          new Date(Date.now() + delay * 1000).toISOString(),
          now(),
          job.id,
        )
        .run();
      console.error('notification_delivery_failed', {
        jobId: job.id,
        jobType: job.job_type,
        attempt,
        dead,
        errorType: error instanceof Error ? error.name : 'UnknownError',
      });
      if (dead) message.ack();
      else message.retry({ delaySeconds: delay });
    }
  }
}
export async function recoverNotificationJobs(env: Env): Promise<void> {
  const staleBefore = new Date(Date.now() - 10 * 60_000).toISOString();
  await env.DB.prepare(
    "UPDATE notification_jobs SET status = 'queued', available_at = ?, updated_at = ? WHERE status = 'processing' AND updated_at < ?",
  )
    .bind(now(), now(), staleBefore)
    .run();
  const due = await env.DB.prepare(
    "SELECT id, job_type AS type FROM notification_jobs WHERE status = 'queued' AND available_at <= ? ORDER BY created_at LIMIT 100",
  )
    .bind(now())
    .all<{ id: string; type: string }>();
  for (const job of due.results ?? []) {
    try {
      await env.NOTIFICATIONS_QUEUE.send({ jobId: job.id, type: job.type });
    } catch (error) {
      console.error('notification_recovery_enqueue_failed', {
        jobId: job.id,
        errorType: error instanceof Error ? error.name : 'UnknownError',
      });
    }
  }
}
