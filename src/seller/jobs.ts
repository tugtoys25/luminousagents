/** Notification-queue handlers for seller email jobs. Called by operations/queue.ts; returns true when it handled the job. */
import { BRAND } from '../brand/defaults';
import type { Env } from '../env';
import { PermanentEmailError, type SendEmailFn } from '../operations/email-errors';
import { renderSellerAcknowledgement, renderSellerFollowupDue, renderSellerInternalAlert, TEMPLATE_ACK, type SellerEmailConfig } from './emails';
import { JOB_ACK, JOB_ASSIGNMENT, JOB_FOLLOWUP_DUE, JOB_INTERNAL_ALERT, findSellerEnquiryForEmail } from './repo';
import { contentHash } from './emails-outbound';
import type { SellerPolicy } from './policy';
import { loadSellerPolicy } from './policy-load';
import { cancelIneligible, claimForSend, completeSend, dispatchView } from './message-repo';
import { renderSellerAssignment } from './emails-internal';
import { findAssignmentNotice, findFollowupForReminder, recordSystemCommunication } from './staff-repo';

export const JOB_SELLER_MESSAGE = 'seller.message_send';
export const isSellerJob = (type: string): boolean => type === JOB_ACK || type === JOB_INTERNAL_ALERT || type === JOB_FOLLOWUP_DUE || type === JOB_SELLER_MESSAGE || type === JOB_ASSIGNMENT;

export const parseRecipients = (raw: string | undefined): string[] =>
  (raw ?? '').split(',').map((v) => v.trim()).filter((v) => /^[^\s@,]+@[^\s@,]+$/.test(v));

export function sellerEmailConfig(env: Env, policy?: SellerPolicy): SellerEmailConfig {
  const baseUrl = (env.PUBLIC_BASE_URL ?? BRAND.siteUrl).replace(/\/$/, '');
  return { baseUrl, companyWebsite: env.SELLER_COMPANY_WEBSITE || baseUrl, includePhone: policy?.alertIncludePhone ?? env.SELLER_ALERT_INCLUDE_PHONE === 'true', includePrice: policy?.alertIncludePrice ?? env.SELLER_ALERT_INCLUDE_PRICE === 'true' };
}

export async function handleSellerJob(env: Env, job: { id: string; job_type: string }, payload: Record<string, unknown>, send: SendEmailFn): Promise<boolean> {
  if (!isSellerJob(job.job_type)) return false;
  const policy = await loadSellerPolicy(env);
  const cfg = sellerEmailConfig(env, policy);
  const from = env.SELLER_EMAIL_FROM || env.EMAIL_FROM;
  const idem = `mayfair-${job.id}`;

  if (job.job_type === JOB_SELLER_MESSAGE) {
    const messageId = String(payload['messageId'] ?? '');
    const ts = new Date().toISOString();
    const m = messageId ? await dispatchView(env.DB, messageId, ts) : null;
    if (!m) throw new PermanentEmailError('Message not found');
    // Already finished or revoked before dispatch: nothing to send, and not an error.
    if (m.status === 'SENT' || m.status === 'CANCELLED') return true;
    if (m.status !== 'QUEUED' && m.status !== 'SENDING') throw new PermanentEmailError('Message was never approved');
    const same = (a: string | null | undefined) => (a ?? '').toLowerCase() === m.recipient.toLowerCase();
    let reason: string | null = null;
    if ((await contentHash({ subject: m.subject, text: m.bodyText, html: m.bodyHtml, recipient: m.recipient })) !== m.contentHash) reason = 'Approved content no longer matches its recorded hash';
    else if (m.kind === 'FOLLOWUP' && !same(m.enquiryEmail)) reason = 'The enquiry recipient changed or was anonymised';
    else if (m.kind === 'MATERIAL_INTEREST') {
      if (m.interestStage !== 'APPROVED') reason = 'The material-interest approval was revoked or the record is no longer approved';
      else if (m.currentInterestVersion !== m.interestVersion) reason = 'The interest record changed after approval';
      else if (!m.entitled) reason = 'The seller is no longer entitled to this notification';
      else if (!same(m.sellerEmail)) reason = 'The seller email changed after approval';
    }
    if (reason) { await cancelIneligible(env.DB, m, reason, ts); return true; }
    if (!(await claimForSend(env.DB, m.id, ts))) return true; // revoked between the checks and the claim
    await send(env, m.recipient, m.subject, m.bodyHtml, m.bodyText, idem, { from, replyTo: env.SELLER_REPLY_TO });
    await completeSend(env.DB, { message: m, jobId: job.id, commId: crypto.randomUUID(), eventId: crypto.randomUUID(), auditId: crypto.randomUUID(), ts: new Date().toISOString() });
    return true;
  }

  if (job.job_type === JOB_ASSIGNMENT) {
    const notice = await findAssignmentNotice(env.DB, String(payload['enquiryId'] ?? ''));
    // Reassigned again (or the person left) before this ran: the new assignment has its own notice.
    if (!notice || notice.assigneeId !== String(payload['assigneeId'] ?? '')) return true;
    const mail = renderSellerAssignment(notice, cfg);
    await send(env, [notice.assigneeEmail], mail.subject, mail.html, mail.text, idem, { from });
    return true;
  }

  if (job.job_type === JOB_FOLLOWUP_DUE) {
    const taskId = String(payload['taskId'] ?? '');
    const escalate = payload['escalate'] === true;
    const task = taskId ? await findFollowupForReminder(env.DB, taskId) : null;
    if (!task) throw new PermanentEmailError('Follow-up not found');
    // Completed, cancelled or closed-out work no longer needs a reminder: finish the job without sending.
    if (!['open', 'in_progress', 'blocked'].includes(task.taskStatus) || ['CONVERTED', 'DECLINED', 'CLOSED'].includes(task.enquiryStatus)) return true;
    const to = escalate ? policy.escalationRecipients : task.assigneeEmail ? [task.assigneeEmail] : [];
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

  const recipients = policy.alertRecipients;
  if (!recipients.length) throw new Error('No new-enquiry alert recipients are configured (Seller settings, or SELLER_ALERT_RECIPIENTS)');
  const mail = renderSellerInternalAlert(enquiry, cfg);
  await send(env, recipients, mail.subject, mail.html, mail.text, idem, { from });
  return true;
}
