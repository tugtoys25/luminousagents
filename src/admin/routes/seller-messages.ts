import { Hono } from 'hono';
import { requireRole } from '../../auth/staff-session';
import { requireRecentMfa } from '../../auth/step-up';
import { contentHash, renderSellerFollowup, TEMPLATE_FOLLOWUP, type BrokerIdentity } from '../../seller/emails-outbound';
import { approveAndQueue, cancelMessage, dispatchView, findMessage, insertDraft, type MessageRow } from '../../seller/message-repo';
import { cancelMessageSchema, followupDraftSchema, sendMessageSchema } from '../../seller/seller-schemas';
import { sellerEmailConfig } from '../../seller/jobs';
import { isStatus, isTerminal } from '../../seller/lifecycle';
import { jsonError, loadEnquiry, readJson, scopeOf, type Ctx } from '../../seller/staff-access';
import { getEnquiry } from '../../seller/staff-repo';
import { dualApprovalEnabled } from '../../seller/seller-access';
import { type AdminApp, id, now, sellerInterestApproveRoles, sellerWorkRoles } from '../shared';

const admin = new Hono<AdminApp>();

export const brokerFrom = (c: Ctx, title: string, telephone: string | undefined): BrokerIdentity => {
  const staff = c.get('staff');
  return { name: staff.displayName, title, email: staff.email, telephone: telephone ?? null, website: sellerEmailConfig(c.env).companyWebsite };
};

/** Step 1 of "Send Follow-up": render the email from the broker's selected questions. Nothing is sent. */
admin.post('/seller-enquiries/:ref/followup-drafts', requireRole(...sellerWorkRoles), async (c) => {
  const parsed = followupDraftSchema.safeParse(await readJson(c));
  if (!parsed.success) return jsonError(c, 422, 'VALIDATION_ERROR', 'Provide 1 to 8 questions (5 to 300 characters each) and your title.');
  const enquiry = await loadEnquiry(c);
  if (enquiry instanceof Response) return enquiry;
  if (!isStatus(enquiry.status) || isTerminal(enquiry.status)) return jsonError(c, 409, 'INVALID_STATE', 'Follow-ups cannot be sent for a closed enquiry.');
  if (!enquiry.assignedTo) return jsonError(c, 409, 'GATE_NOT_MET', 'Assign an owner first.');
  const row = await getEnquiry(c.env.DB, enquiry.reference, scopeOf(c));
  if (!row) return jsonError(c, 404, 'NOT_FOUND', 'Enquiry not found.');
  const mail = renderSellerFollowup({ contactName: String(row.contactName), reference: enquiry.reference, questions: parsed.data.questions, broker: brokerFrom(c, parsed.data.brokerTitle, parsed.data.brokerTelephone) });
  const messageId = id();
  const ok = await insertDraft(c.env.DB, {
    id: c.get('staff').id, requestId: c.get('requestId'), ts: now(), messageId, auditId: id(), kind: 'FOLLOWUP', enquiryId: enquiry.id, enquiryReference: enquiry.reference, sellerId: null, opportunityId: null,
    interestId: null, interestVersion: null, templateId: TEMPLATE_FOLLOWUP, recipient: String(row.email), subject: mail.subject, text: mail.text, html: mail.html, requireOpenEnquiry: true,
  });
  if (!ok) return jsonError(c, 409, 'INVALID_STATE', 'A draft could not be created.');
  return c.json({ data: { id: messageId, recipient: row.email, subject: mail.subject, text: mail.text, version: 1 } }, 201);
});

/** Revalidation shared by the follow-up send route and the material-interest send route. */
export async function loadSendable(c: Ctx, kind: 'FOLLOWUP' | 'MATERIAL_INTEREST'): Promise<MessageRow | Response> {
  const parsed = sendMessageSchema.safeParse(await readJson(c));
  if (!parsed.success) return jsonError(c, 422, 'CONFIRMATION_REQUIRED', 'Review the preview, then confirm to send.');
  const message = await findMessage(c.env.DB, c.req.param('messageId') ?? '', scopeOf(c));
  if (!message) return jsonError(c, 404, 'NOT_FOUND', 'Message not found.');
  if (message.kind !== kind) return jsonError(c, 404, 'NOT_FOUND', 'Message not found.');
  if (message.status !== 'DRAFT') return jsonError(c, 409, 'INVALID_STATE', `This message is already ${message.status.toLowerCase()}.`);
  if (parsed.data.expectedVersion !== message.version) return jsonError(c, 409, 'VERSION_CONFLICT', 'This draft changed. Reload and try again.');
  return message;
}

export async function approveAndEnqueue(c: Ctx, message: MessageRow): Promise<Response> {
  const staff = c.get('staff');
  const hash = await contentHash({ subject: message.subject, text: message.bodyText, html: message.bodyHtml, recipient: message.recipient });
  const jobId = id();
  const ok = await approveAndQueue(c.env.DB, { id: staff.id, requestId: c.get('requestId'), ts: now(), message, contentHash: hash, jobId, auditId: id() });
  if (!ok) return jsonError(c, 409, 'VERSION_CONFLICT', 'This message changed or was already approved.');
  try { await c.env.NOTIFICATIONS_QUEUE.send({ jobId, type: 'seller.message_send' }); } catch { /* the durable job row is picked up by the recovery cron */ }
  return c.json({ data: { id: message.id, status: 'QUEUED', note: 'Queued for sending. "Sent" will show only once the email provider has accepted it; inbox delivery is not confirmed.' } });
}

admin.post('/seller-messages/:messageId/send', requireRole(...sellerWorkRoles), async (c) => {
  const message = await loadSendable(c, 'FOLLOWUP');
  if (message instanceof Response) return message;
  const enquiry = await getEnquiry(c.env.DB, message.enquiryReference, scopeOf(c));
  if (!enquiry || !isStatus(String(enquiry.status)) || isTerminal(String(enquiry.status) as never)) return jsonError(c, 409, 'INVALID_STATE', 'The enquiry is no longer open.');
  if (String(enquiry.email).toLowerCase() !== message.recipient.toLowerCase()) return jsonError(c, 409, 'INVALID_STATE', 'The recipient changed. Create a new draft.');
  return approveAndEnqueue(c, message);
});

/** Material-interest notices: approver roles only, recent MFA, and (optionally) a second person. Eligibility is re-checked here and again at dispatch. */
admin.post('/seller-material-notices/:messageId/send', requireRole(...sellerInterestApproveRoles), requireRecentMfa('/dashboard/sellers/ui'), async (c) => {
  const message = await loadSendable(c, 'MATERIAL_INTEREST');
  if (message instanceof Response) return message;
  const staff = c.get('staff');
  if (dualApprovalEnabled(c.env) && staff.id === message.createdBy) return jsonError(c, 403, 'SEPARATION_OF_DUTIES', 'The person who drafted this notice cannot approve it.');
  const view = await dispatchView(c.env.DB, message.id, now());
  if (!view || view.interestStage !== 'APPROVED') return jsonError(c, 409, 'GATE_NOT_MET', 'The material-interest record is not approved for seller notification.');
  if (view.currentInterestVersion !== message.interestVersion) return jsonError(c, 409, 'GATE_NOT_MET', 'The interest record changed after this draft. Create a new draft.');
  if (!view.entitled) return jsonError(c, 409, 'GATE_NOT_MET', 'The seller is not currently entitled to this notification (active relationship, reviewed confidentiality and valid authority are required).');
  if (!view.sellerEmail || view.sellerEmail.toLowerCase() !== message.recipient.toLowerCase()) return jsonError(c, 409, 'GATE_NOT_MET', 'The seller email changed. Create a new draft.');
  return approveAndEnqueue(c, message);
});

/** Revoking approval before dispatch. A message that is already sending or sent cannot be cancelled. */
admin.post('/seller-messages/:messageId/cancel', requireRole(...sellerWorkRoles), async (c) => {
  const parsed = cancelMessageSchema.safeParse(await readJson(c));
  if (!parsed.success) return jsonError(c, 422, 'VALIDATION_ERROR', 'Give a reason (5+ characters) and confirm.');
  const message = await findMessage(c.env.DB, c.req.param('messageId') ?? '', scopeOf(c));
  if (!message) return jsonError(c, 404, 'NOT_FOUND', 'Message not found.');
  if (message.kind === 'MATERIAL_INTEREST' && !sellerInterestApproveRoles.includes(c.get('staff').role) && message.status !== 'DRAFT')
    return jsonError(c, 403, 'FORBIDDEN', 'Only an approver can revoke a queued material-interest notice.');
  const ok = await cancelMessage(c.env.DB, { id: c.get('staff').id, requestId: c.get('requestId'), ts: now(), message, reason: parsed.data.reason, auditId: id() });
  if (!ok) return jsonError(c, 409, 'INVALID_STATE', 'This message can no longer be cancelled (it is sending or already sent).');
  return c.json({ data: { id: message.id, status: 'CANCELLED' } });
});

export default admin;
