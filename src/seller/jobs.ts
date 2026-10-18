/** Notification-queue handlers for seller email jobs. Called by operations/queue.ts; returns true when it handled the job. */
import type { Env } from '../env';
import { PermanentEmailError, type SendEmailFn } from '../operations/email-errors';
import { renderSellerAcknowledgement, renderSellerFollowupDue, renderSellerInternalAlert, TEMPLATE_ACK, type SellerEmailConfig } from './emails';
import { JOB_ACK, JOB_FOLLOWUP_DUE, JOB_INTERNAL_ALERT, findSellerEnquiryForEmail } from './repo';
import { findFollowupForReminder, recordSystemCommunication } from './staff-repo';

export const isSellerJob = (type: string): boolean => type === JOB_ACK || type === JOB_INTERNAL_ALERT || type === JOB_FOLLOWUP_DUE;

export const parseRecipients = (raw: string | undefined): string[] =>
  (raw ?? '').split(',').map((v) => v.trim()).filter((v) => /^[^\s@,]+@[^\s@,]+$/.test(v));

export function sellerEmailConfig(env: Env): SellerEmailConfig {
  const baseUrl = (env.PUBLIC_BASE_URL ?? 'https://casinosofmayfair.com').replace(/\/$/, '');
  return { baseUrl, companyWebsite: env.SELLER_COMPANY_WEBSITE || baseUrl, includePhone: env.SELLER_ALERT_INCLUDE_PHONE === 'true', includePrice: env.SELLER_ALERT_INCLUDE_PRICE === 'true' };
}

export async function handleSellerJob(env: Env, job: { id: string; job_type: string }, payload: Record<string, unknown>, send: SendEmailFn): Promise<boolean> {
  if (!isSellerJob(job.job_type)) return false;
  const cfg = sellerEmailConfig(env);
  const from = env.SELLER_EMAIL_FROM || env.EMAIL_FROM;
  const idem = `mayfair-${job.id}`;

  if (job.job_type === JOB_FOLLOWUP_DUE) {
    const taskId = String(payload['taskId'] ?? '');
    const escalate = payload['escalate'] === true;
    const task = taskId ? await findFollowupForReminder(env.DB, taskId) : null;
    if (!task) throw new PermanentEmailError('Follow-up not found');
    // Completed, cancelled or closed-out work no longer needs a reminder: finish the job without sending.
    if (!['open', 'in_progress', 'blocked'].includes(task.taskStatus) || ['CONVERTED', 'DECLINED', 'CLOSED'].includes(task.enquiryStatus)) return true;
    const to = escalate ? parseRecipients(env.SELLER_ESCALATION_RECIPIENTS) : task.assigneeEmail ? [task.assigneeEmail] : [];
    if (!to.length) throw new PermanentEmailError('No reminder recipient');
    const mail = renderSellerFollowupDue(task, cfg, escalate);
    await send(env, to, mail.subject, mail.html, mail.text, idem, { from });
    return true;
  }

  const enquiryId = String(payload['enquiryId'] ?? '');
  if (!enquiryId) throw new PermanentEmailError('Invalid seller enquiry payload');
  const enquiry = await findSellerEnquiryForEmail(env.DB, enquiryId);
  if (!enquiry) throw new PermanentEmailError('Seller enquiry not found or anonymised');

  if (job.job_type === JOB_ACK) {
    const mail = renderSellerAcknowledgement(enquiry, cfg);
    await send(env, enquiry.email, mail.subject, mail.html, mail.text, idem, { from, replyTo: env.SELLER_REPLY_TO });
    // Only the provider's acceptance is known; this is recorded as such, never as inbox delivery.
    await recordSystemCommunication(env.DB, { id: crypto.randomUUID(), enquiryId, templateId: TEMPLATE_ACK, jobId: job.id, ts: new Date().toISOString() });
    return true;
  }

  const recipients = parseRecipients(env.SELLER_ALERT_RECIPIENTS);
  if (!recipients.length) throw new Error('SELLER_ALERT_RECIPIENTS is not configured');
  const mail = renderSellerInternalAlert(enquiry, cfg);
  await send(env, recipients, mail.subject, mail.html, mail.text, idem, { from });
  return true;
}
