import type { Env } from '../env';
import {
  buryExhaustedJobs,
  claimJob,
  findAssignedEnquiry,
  findEnquiryForAck,
  findEnquiryForOps,
  findFormSubmission,
  findJob,
  findNdaDecision,
  findNdaForReview,
  findPendingBuyer,
  findSignedNda,
  listDueJobs,
  markRetryOrDead,
  markSent,
  readNotificationEmailSetting,
  requeueStaleProcessing,
  type NotificationJob,
} from './queue-repo';
import { JOB_ACK, JOB_INTERNAL_ALERT, findSellerEnquiryForEmail } from '../seller/repo';
import { renderSellerAcknowledgement, renderSellerInternalAlert } from '../seller/emails';

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
type SendOptions = { from?: string | undefined; replyTo?: string | undefined };
class PermanentEmailError extends Error {}
async function sendEmail(
  env: Env,
  to: string | string[],
  subject: string,
  html: string,
  text: string,
  idempotencyKey?: string,
  options: SendOptions = {},
): Promise<void> {
  const from = options.from ?? env.EMAIL_FROM;
  if (!env.RESEND_API_KEY || !from) throw new Error('Email provider is not configured');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json', ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
    body: JSON.stringify({ from, to: Array.isArray(to) ? to : [to], subject, html, text, ...(options.replyTo ? { reply_to: options.replyTo } : {}) }),
  });
  if (!response.ok) {
    // 4xx other than 408/429 will not succeed on retry (bad recipient, bad sender, auth): do not retry indefinitely.
    if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429)
      throw new PermanentEmailError(`Email provider returned HTTP ${response.status}`);
    throw new Error(`Email provider returned HTTP ${response.status}`);
  }
}
async function renderAndSend(env: Env, job: NotificationJob): Promise<void> {
  const payload = JSON.parse(
    await decryptPayload(job.payload_json, env.OTP_ENCRYPTION_KEY ?? ''),
  ) as Record<string, unknown>;
  const sendJobEmail = (emailEnv: Env, to: string, subject: string, html: string, text: string) =>
    sendEmail(emailEnv, to, subject, html, text, `mayfair-${job.id}`);
  if (job.job_type === JOB_ACK || job.job_type === JOB_INTERNAL_ALERT) {
    const enquiryId = String(payload['enquiryId'] ?? '');
    if (!enquiryId) throw new PermanentEmailError('Invalid seller enquiry payload');
    const enquiry = await findSellerEnquiryForEmail(env.DB, enquiryId);
    if (!enquiry) throw new PermanentEmailError('Seller enquiry not found or anonymised');
    const baseUrl = (env.PUBLIC_BASE_URL ?? 'https://casinosofmayfair.com').replace(/\/$/, '');
    const cfg = {
      baseUrl,
      companyWebsite: env.SELLER_COMPANY_WEBSITE || baseUrl,
      includePhone: env.SELLER_ALERT_INCLUDE_PHONE === 'true',
      includePrice: env.SELLER_ALERT_INCLUDE_PRICE === 'true',
    };
    const from = env.SELLER_EMAIL_FROM || env.EMAIL_FROM;
    if (job.job_type === JOB_ACK) {
      const mail = renderSellerAcknowledgement(enquiry, cfg);
      await sendEmail(env, enquiry.email, mail.subject, mail.html, mail.text, `mayfair-${job.id}`, { from, replyTo: env.SELLER_REPLY_TO });
      return;
    }
    const recipients = (env.SELLER_ALERT_RECIPIENTS ?? '').split(',').map((v) => v.trim()).filter((v) => /^[^\s@,]+@[^\s@,]+$/.test(v));
    if (!recipients.length) throw new Error('SELLER_ALERT_RECIPIENTS is not configured');
    const mail = renderSellerInternalAlert(enquiry, cfg);
    await sendEmail(env, recipients, mail.subject, mail.html, mail.text, `mayfair-${job.id}`, { from });
    return;
  }
  if (job.job_type === 'auth.password_reset') {
    const email = String(payload['email'] ?? '');
    const token = String(payload['token'] ?? '');
    const kind = payload['kind'] === 'staff' ? 'staff' : 'buyer';
    const invite = payload['purpose'] === 'invite';
    const minutes = Number(payload['expiresInMinutes'] ?? 60);
    if (!email || !/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid password-reset payload');
    const base = (env.PUBLIC_BASE_URL ?? 'https://casinosofmayfair.com').replace(/\/$/, '');
    const link = `${base}${kind === 'staff' ? '/admin/reset-password' : '/reset-password'}?token=${token}`;
    const hours = Math.round(minutes / 60);
    const lifetime = hours >= 2 ? `${hours} hours` : `${minutes} minutes`;
    await sendJobEmail(
      env,
      email,
      invite
        ? 'Set your password · Casinos of Mayfair'
        : 'Reset your password · Casinos of Mayfair',
      `<p>${invite ? 'An account has been created for you. Use the link below to choose your password.' : 'We received a request to reset your password.'}</p><p><a href="${escapeHtml(link)}">${invite ? 'Set your password' : 'Reset your password'}</a></p><p>This link can be used once and expires in ${lifetime}. If you did not expect this email, you can ignore it — your password will not change.</p>`,
      `${invite ? 'An account has been created for you. Set your password' : 'Reset your password'}: ${link}\nThis link can be used once and expires in ${lifetime}. If you did not expect this email, ignore it.`,
    );
    return;
  }
  if (job.job_type === 'enquiry.acknowledgement') {
    const enquiryId = String(payload['enquiryId'] ?? '');
    if (!enquiryId) throw new Error('Invalid enquiry acknowledgement payload');
    const enquiry = await findEnquiryForAck(env.DB, enquiryId);
    if (!enquiry) throw new Error('Enquiry record not found');
    const base = (env.PUBLIC_BASE_URL ?? 'https://casinosofmayfair.com').replace(/\/$/, '');
    await sendJobEmail(
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
    const row = await findAssignedEnquiry(env.DB, enquiryId, brokerId);
    if (!row) throw new Error('Assigned broker or enquiry record not found');
    const base = (env.PUBLIC_BASE_URL ?? 'https://casinosofmayfair.com').replace(/\/$/, '');
    await sendJobEmail(
      env,
      row.brokerEmail,
      'New enquiry assigned to you · Casinos of Mayfair',
      `<p>A new website enquiry has been assigned to you.</p><p><strong>Enquiry reference:</strong> ${escapeHtml(row.id)}</p><p><strong>Contact:</strong> ${escapeHtml(row.name)} (${escapeHtml(row.email)})</p><p><strong>Company:</strong> ${escapeHtml(row.company || 'Not provided')}</p><p><strong>Opportunity:</strong> ${escapeHtml(row.opportunityTitle || 'General enquiry')}</p><p><a href="${base}/dashboard/enquiries/ui">Open enquiry inbox</a></p>`,
      `New enquiry ${row.id} assigned to you. Contact: ${row.name} (${row.email}). Company: ${row.company || 'Not provided'}. Opportunity: ${row.opportunityTitle || 'General enquiry'}. Open inbox: ${base}/dashboard/enquiries/ui`,
    );
    return;
  }
  const configuredNotificationEmail = await readNotificationEmailSetting(env.DB);
  const opsEmail = configuredNotificationEmail || env.OPS_EMAIL;
  if (!opsEmail) throw new Error('Operations email is not configured');
  if (job.job_type === 'buyer.registration_review') {
    const userId = String(payload['userId'] ?? '');
    if (!userId) throw new Error('Invalid buyer-registration payload');
    const buyer = await findPendingBuyer(env.DB, userId);
    if (!buyer) throw new Error('Pending buyer registration not found');
    const base = (env.PUBLIC_BASE_URL ?? 'https://casinosofmayfair.com').replace(/\/$/, '');
    await sendJobEmail(
      env,
      opsEmail,
      'Buyer registration requires review · Casinos of Mayfair',
      `<p>A buyer has submitted a registration for review.</p><p><strong>Name:</strong> ${escapeHtml(buyer.displayName)}</p><p><strong>Email:</strong> ${escapeHtml(buyer.email)}</p><p><strong>Company:</strong> ${escapeHtml(buyer.companyName || 'Not provided')}</p><p><strong>Role:</strong> ${escapeHtml(buyer.roleTitle || 'Not provided')}</p><p><a href="${base}/dashboard/buyers/ui">Review buyer registrations</a></p>`,
      `Buyer registration requires review: ${buyer.displayName} (${buyer.email}), company: ${buyer.companyName || 'not provided'}. Review: ${base}/dashboard/buyers/ui`,
    );
    return;
  }
  if (job.job_type === 'enquiry.received') {
    const enquiryId = String(payload['enquiryId'] ?? '');
    if (!enquiryId) throw new Error('Invalid enquiry notification payload');
    const enquiry = await findEnquiryForOps(env.DB, enquiryId);
    if (!enquiry) throw new Error('Enquiry record not found');
    const base = (env.PUBLIC_BASE_URL ?? 'https://casinosofmayfair.com').replace(/\/$/, '');
    await sendJobEmail(
      env,
      opsEmail,
      'New website enquiry · Casinos of Mayfair',
      `<h2>New website enquiry</h2><p><strong>Name:</strong> ${escapeHtml(enquiry.name)}</p><p><strong>Email:</strong> ${escapeHtml(enquiry.email)}</p><p><strong>Company:</strong> ${escapeHtml(enquiry.company || 'Not provided')}</p><p><strong>Message:</strong></p><p>${escapeHtml(enquiry.message).replace(/\n/g, '<br>')}</p><p><a href="${base}/dashboard/enquiries/ui">Open enquiry inbox</a></p>`,
      `New website enquiry from ${enquiry.name} (${enquiry.email}). Company: ${enquiry.company || 'Not provided'}. Message: ${enquiry.message}. Open inbox: ${base}/dashboard/enquiries/ui`,
    );
    return;
  }
  if (job.job_type === 'nda.review_requested') {
    const requestId = String(payload['ndaRequestId'] ?? '');
    if (!requestId) throw new Error('Invalid NDA notification payload');
    const request = await findNdaForReview(env.DB, requestId);
    if (!request) throw new Error('NDA request not found');
    const base = (env.PUBLIC_BASE_URL ?? 'https://casinosofmayfair.com').replace(/\/$/, '');
    await sendJobEmail(
      env,
      opsEmail,
      'NDA review requested · Casinos of Mayfair',
      `<p>A buyer has requested access to an opportunity data room.</p><p><strong>Opportunity:</strong> ${escapeHtml(request.title)}</p><p><strong>Buyer:</strong> ${escapeHtml(request.email)}</p><p><a href="${base}/dashboard/nda-requests">Review NDA requests</a></p>`,
      `NDA review requested for ${request.title} by ${request.email}. Review: ${base}/dashboard/nda-requests`,
    );
    return;
  }
  if (job.job_type === 'nda.signed_pdf_uploaded') {
    const requestId = String(payload['ndaRequestId'] ?? '');
    if (!requestId) throw new Error('Invalid signed-NDA notification payload');
    const request = await findSignedNda(env.DB, requestId);
    if (!request) throw new Error('Signed NDA request not found');
    const base = (env.PUBLIC_BASE_URL ?? 'https://casinosofmayfair.com').replace(/\/$/, '');
    await sendJobEmail(env, opsEmail, 'Signed NDA uploaded · Casinos of Mayfair',
      `<p>A buyer uploaded a signed NDA PDF that passed the configured malware scan.</p><p><strong>Opportunity:</strong> ${escapeHtml(request.opportunityTitle)}</p><p><strong>Buyer:</strong> ${escapeHtml(request.buyerName || request.email)}</p><p><a href="${base}/dashboard/nda-requests/ui">Review NDA requests</a></p>`,
      `Signed NDA PDF uploaded for ${request.opportunityTitle} by ${request.buyerName || request.email}. Review: ${base}/dashboard/nda-requests/ui`);
    return;
  }
  if (job.job_type === 'nda.decision') {
    const requestId = String(payload['ndaRequestId'] ?? '');
    if (!requestId) throw new Error('Invalid NDA decision payload');
    const request = await findNdaDecision(env.DB, requestId);
    if (!request) throw new Error('NDA request not found');
    if (request.status !== 'approved' && request.status !== 'rejected') return;
    const base = (env.PUBLIC_BASE_URL ?? 'https://casinosofmayfair.com').replace(/\/$/, '');
    const greeting = escapeHtml(request.name || 'there');
    const approved = request.status === 'approved';
    const until = request.expiresAt ? new Date(request.expiresAt).toUTCString() : '';
    await sendJobEmail(
      env,
      request.email,
      approved
        ? 'Your data room access has been approved · Casinos of Mayfair'
        : 'Update on your NDA request · Casinos of Mayfair',
      approved
        ? `<p>Dear ${greeting},</p><p>Your NDA request for <strong>${escapeHtml(request.title)}</strong> has been approved.${until ? ` Access is available until ${escapeHtml(until)}.` : ''}</p><p><a href="${base}/account">Sign in to your account</a> to view the documents. All materials remain confidential under the NDA you acknowledged.</p>`
        : `<p>Dear ${greeting},</p><p>We are unable to approve your NDA request for <strong>${escapeHtml(request.title)}</strong> at this time.${request.reason ? ` Note from the team: ${escapeHtml(request.reason)}` : ''}</p><p>If you have questions, please reply to this email or contact the team through the website.</p>`,
      approved
        ? `Your NDA request for ${request.title} has been approved.${until ? ` Access runs until ${until}.` : ''} Sign in at ${base}/account to view the documents.`
        : `We are unable to approve your NDA request for ${request.title} at this time.${request.reason ? ` Note from the team: ${request.reason}` : ''}`,
    );
    return;
  }
  if (job.job_type === 'managed_form.submitted') {
    const submissionId = String(payload['submissionId'] ?? '');
    if (!submissionId) throw new Error('Invalid managed-form submission payload');
    const submission = await findFormSubmission(env.DB, submissionId);
    if (!submission) throw new Error('Managed form submission not found');
    const data = JSON.parse(submission.dataJson) as Record<string, unknown>;
    const base = (env.PUBLIC_BASE_URL ?? 'https://casinosofmayfair.com').replace(/\/$/, '');
    const fields = Object.entries(data)
      .map(([key, value]) => `<p><strong>${escapeHtml(key)}:</strong> ${escapeHtml(value)}</p>`)
      .join('');
    await sendJobEmail(
      env,
      opsEmail,
      `New form submission: ${submission.formTitle} · Casinos of Mayfair`,
      `<h2>${escapeHtml(submission.formTitle)}</h2><p><strong>Reference:</strong> ${escapeHtml(submission.id)}</p>${submission.opportunityTitle ? `<p><strong>Listing:</strong> ${escapeHtml(submission.opportunityTitle)}</p>` : ''}${fields}<p><a href="${base}/dashboard">Open staff dashboard</a></p>`,
      `New form submission ${submission.id}: ${submission.formTitle}. ${submission.opportunityTitle ? `Listing: ${submission.opportunityTitle}. ` : ''}${Object.entries(
        data,
      )
        .map(([key, value]) => `${key}: ${String(value)}`)
        .join('; ')}. Dashboard: ${base}/dashboard`,
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
    const job = await findJob(env.DB, jobId);
    if (!job || job.status === 'sent' || job.status === 'dead' || job.status === 'processing') {
      message.ack();
      continue;
    }
    const claimed = await claimJob(env.DB, job.id, now());
    if (!claimed) {
      message.ack();
      continue;
    }
    try {
      await renderAndSend(env, job);
      await markSent(env.DB, job.id, now());
      message.ack();
    } catch (error) {
      const attempt = job.attempts + 1;
      const dead = attempt >= 5 || error instanceof PermanentEmailError;
      const delay = Math.min(3600, 30 * 2 ** Math.min(attempt - 1, 7));
      await markRetryOrDead(env.DB, {
        jobId: job.id,
        dead,
        availableAt: new Date(Date.now() + delay * 1000).toISOString(),
        timestamp: now(),
      });
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
  await requeueStaleProcessing(env.DB, staleBefore, now());
  await buryExhaustedJobs(env.DB, now());
  const due = await listDueJobs(env.DB, now());
  for (const job of due) {
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
