import { Hono } from 'hono';
import { requireRole } from '../../auth/staff-session';
import { renderSellerMaterialInterest, TEMPLATE_MATERIAL_INTEREST } from '../../seller/emails-outbound';
import { findInterest, insertInterest, reviewInterest, interestFromStages } from '../../seller/interest-repo';
import { insertDraft } from '../../seller/message-repo';
import { generateRef } from '../../seller/reference';
import { findLink } from '../../seller/seller-repo';
import { loadSellerPolicy } from '../../seller/policy-load';
import { loadSeller, sellerScopeOf } from '../../seller/seller-access';
import { interestRecordSchema, interestReviewSchema, notificationDraftSchema } from '../../seller/seller-schemas';
import { isUniqueViolation } from '../../seller/repo';
import { jsonError, readJson } from '../../seller/staff-access';
import { type AdminApp, id, now, sellerInterestApproveRoles, sellerWorkRoles } from '../shared';
import { brokerFrom } from './seller-messages';

const admin = new Hono<AdminApp>();
const INTEREST_REF = /^CM-M-[A-HJ-NP-Z2-9]{6}$/;

/** Records that interest exists. It is internal: nothing here reaches the seller until a reviewed summary is approved and a notice is sent. */
admin.post('/sellers/:ref/links/:linkId/interests', requireRole(...sellerWorkRoles), async (c) => {
  const parsed = interestRecordSchema.safeParse(await readJson(c));
  if (!parsed.success) return jsonError(c, 422, 'VALIDATION_ERROR', 'Check the interest type, source and summary.');
  const seller = await loadSeller(c);
  if (seller instanceof Response) return seller;
  const link = await findLink(c.env.DB, seller.id, c.req.param('linkId') ?? '');
  if (!link) return jsonError(c, 404, 'NOT_FOUND', 'Link not found.');
  const d = parsed.data;
  for (let attempt = 0; attempt < 5; attempt++) {
    const reference = generateRef('CM-M');
    try {
      const ok = await insertInterest(c.env.DB, {
        id: c.get('staff').id, requestId: c.get('requestId'), ts: now(), interestId: id(), reference, eventId: id(), auditId: id(), sellerId: seller.id, sellerReference: seller.reference, linkId: link.id,
        interestType: d.interestType, receivedAt: d.receivedAt ? new Date(d.receivedAt).toISOString() : now(), source: d.source, summary: d.summary, buyerReference: d.buyerReference ?? '',
      });
      if (!ok) return jsonError(c, 409, 'INVALID_STATE', 'Interest can only be recorded against an active relationship.');
      return c.json({ data: { reference, stage: 'RECORDED' } }, 201);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }
  return jsonError(c, 409, 'CONFLICT', 'Could not allocate a reference. Try again.');
});

/** start_review is broker work; approve, reject and withdraw are approver-only. Approval needs the reviewed text and every check recorded. */
admin.post('/material-interests/:ref/review', requireRole(...sellerWorkRoles), async (c) => {
  const parsed = interestReviewSchema.safeParse(await readJson(c));
  if (!parsed.success) return jsonError(c, 422, 'VALIDATION_ERROR', 'Provide the action, the record version and a note.');
  const ref = c.req.param('ref') ?? '';
  if (!INTEREST_REF.test(ref)) return jsonError(c, 404, 'NOT_FOUND', 'Record not found.');
  const interest = await findInterest(c.env.DB, ref, sellerScopeOf(c));
  if (!interest) return jsonError(c, 404, 'NOT_FOUND', 'Record not found.');
  const d = parsed.data;
  const staff = c.get('staff');
  if (d.action !== 'start_review' && !sellerInterestApproveRoles.includes(staff.role)) return jsonError(c, 403, 'FORBIDDEN', 'Only an approver can approve, reject or withdraw.');
  if (!interestFromStages(d.action).includes(interest.stage)) return jsonError(c, 409, 'INVALID_TRANSITION', `${interest.stage} cannot be ${d.action.replace('_', ' ')}ed.`);
  if (d.expectedVersion !== interest.version) return jsonError(c, 409, 'VERSION_CONFLICT', 'This record changed. Reload and try again.');
  if (d.action !== 'start_review' && d.confirm !== true) return jsonError(c, 422, 'CONFIRMATION_REQUIRED', 'Confirm this decision to continue.');
  if (d.action === 'approve') {
    if ((d.approvedSummary ?? '').length < 20 || (d.proposedNextStep ?? '').length < 3 || (d.stageLabel ?? '').length < 2) return jsonError(c, 422, 'GATE_NOT_MET', 'Write the approved summary (20+ characters), the current stage and the proposed next step. Do not identify the buyer or disclose terms.');
    if (d.confidentialityChecked !== true || d.notificationEligible !== true) return jsonError(c, 422, 'GATE_NOT_MET', 'Confirm the confidentiality review and that the seller is entitled to be told.');
    if ((await loadSellerPolicy(c.env)).materialInterestDualApproval && staff.id === interest.recordedBy) return jsonError(c, 403, 'SEPARATION_OF_DUTIES', 'The person who recorded this interest cannot approve it.');
  }
  const ok = await reviewInterest(c.env.DB, {
    id: staff.id, requestId: c.get('requestId'), ts: now(), interest, action: d.action, note: d.note, eventId: id(), auditId: id(),
    approvedSummary: d.approvedSummary ?? '', proposedNextStep: d.proposedNextStep ?? '', stageLabel: d.stageLabel ?? '',
  }, now());
  if (!ok) return jsonError(c, 409, d.action === 'approve' ? 'GATE_NOT_MET' : 'VERSION_CONFLICT', d.action === 'approve'
    ? 'The seller is not currently entitled (active relationship, reviewed confidentiality and a valid representation authority or mandate are required), or the record changed.' : 'This record changed. Reload and try again.');
  return c.json({ data: { reference: interest.reference, version: interest.version + 1 } });
});

/** Renders the exact outgoing notice from the approved fields only. Nothing is sent; the preview is what the approver confirms. */
admin.post('/material-interests/:ref/notification-draft', requireRole(...sellerWorkRoles), async (c) => {
  const parsed = notificationDraftSchema.safeParse(await readJson(c));
  if (!parsed.success) return jsonError(c, 422, 'VALIDATION_ERROR', 'Provide your title (and optionally a telephone number).');
  const ref = c.req.param('ref') ?? '';
  if (!INTEREST_REF.test(ref)) return jsonError(c, 404, 'NOT_FOUND', 'Record not found.');
  const interest = await findInterest(c.env.DB, ref, sellerScopeOf(c));
  if (!interest) return jsonError(c, 404, 'NOT_FOUND', 'Record not found.');
  if (interest.stage !== 'APPROVED') return jsonError(c, 409, 'GATE_NOT_MET', 'The interest must be approved for seller notification first.');
  if (!interest.sellerSourceEnquiryId) return jsonError(c, 409, 'GATE_NOT_MET', 'This seller has no source enquiry to record the communication against.');
  const mail = renderSellerMaterialInterest({
    contactName: interest.sellerContactName, assetReference: interest.opportunityTitle, interestType: interest.interestType, interestStage: interest.stageLabel,
    approvedSummary: interest.approvedSummary, proposedNextStep: interest.proposedNextStep, broker: brokerFrom(c, parsed.data.brokerTitle, parsed.data.brokerTelephone),
  });
  const messageId = id();
  const ok = await insertDraft(c.env.DB, {
    id: c.get('staff').id, requestId: c.get('requestId'), ts: now(), messageId, auditId: id(), kind: 'MATERIAL_INTEREST', enquiryId: interest.sellerSourceEnquiryId, enquiryReference: interest.reference,
    sellerId: interest.sellerId, opportunityId: interest.opportunityId, interestId: interest.id, interestVersion: interest.version, templateId: TEMPLATE_MATERIAL_INTEREST,
    recipient: interest.sellerEmail, subject: mail.subject, text: mail.text, html: mail.html, requireOpenEnquiry: false,
  });
  if (!ok) return jsonError(c, 409, 'INVALID_STATE', 'A notice has already been queued or sent for this interest, or the source enquiry is unavailable.');
  return c.json({ data: { id: messageId, recipient: interest.sellerEmail, subject: mail.subject, text: mail.text, version: 1 } }, 201);
});

export default admin;
