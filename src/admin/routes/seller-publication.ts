import { Hono } from 'hono';
import { requireRole } from '../../auth/staff-session';
import { evaluatePublicationGates } from '../../seller/gates';
import { createReview, decideReview, getReview, listPublicationEvents, loadGateInput, opportunityInScope, saveReview, type ReviewFlags, type ReviewRow } from '../../seller/publication-repo';
import { loadSellerPolicy } from '../../seller/policy-load';
import { sellerScopeOf } from '../../seller/seller-access';
import { publicationReviewSchema } from '../../seller/seller-schemas';
import { jsonError, readJson } from '../../seller/staff-access';
import { type AdminApp, id, now, publisherRoles, purgeOpportunityPublicCache, sellerReadRoles, sellerWorkRoles } from '../shared';

const admin = new Hono<AdminApp>();
const bit = (v: boolean | undefined, fallback: unknown): number => (v === undefined ? (fallback === 1 ? 1 : 0) : v ? 1 : 0);

admin.get('/opportunities/:id/seller-gates', requireRole(...sellerReadRoles, ...publisherRoles), async (c) => {
  const opp = await opportunityInScope(c.env.DB, c.req.param('id') ?? '', sellerScopeOf(c));
  if (!opp) return jsonError(c, 404, 'NOT_FOUND', 'Opportunity not found.');
  const gates = evaluatePublicationGates(await loadGateInput(c.env.DB, opp.id), now());
  c.header('Cache-Control', 'private, no-store');
  return c.json({ data: { opportunityId: opp.id, title: opp.title, live: Boolean(opp.live), ...gates, review: await getReview(c.env.DB, opp.id), events: await listPublicationEvents(c.env.DB, opp.id) } });
});

/** Prepare (save), approve, reject or revoke the publication review. Approval is the human sign-off; it never publishes by itself. */
admin.post('/opportunities/:id/seller-publication-review', requireRole(...sellerWorkRoles, ...publisherRoles), async (c) => {
  const parsed = publicationReviewSchema.safeParse(await readJson(c));
  if (!parsed.success) return jsonError(c, 422, 'VALIDATION_ERROR', 'Check the review fields.');
  const staff = c.get('staff');
  const d = parsed.data;
  const opp = await opportunityInScope(c.env.DB, c.req.param('id') ?? '', sellerScopeOf(c));
  if (!opp) return jsonError(c, 404, 'NOT_FOUND', 'Opportunity not found.');
  const actor = { id: staff.id, requestId: c.get('requestId'), ts: now() };
  const review = await getReview(c.env.DB, opp.id);
  if (d.action === 'save') {
    if (!sellerWorkRoles.includes(staff.role)) return jsonError(c, 403, 'FORBIDDEN', 'Your role cannot prepare this review.');
    const flags: ReviewFlags = {
      scopeText: d.scopeText ?? String(review?.scopeText ?? ''), notes: d.notes ?? String(review?.notes ?? ''),
      scopeConfirmed: bit(d.scopeConfirmed, review?.scopeConfirmed), confidentialityReviewed: bit(d.confidentialityReviewed, review?.confidentialityReviewed),
      publicFieldsApproved: bit(d.publicFieldsApproved, review?.publicFieldsApproved), sensitiveDataReviewed: bit(d.sensitiveDataReviewed, review?.sensitiveDataReviewed),
      imageRightsChecked: bit(d.imageRightsChecked, review?.imageRightsChecked), legalReviewCompleted: bit(d.legalReviewCompleted, review?.legalReviewCompleted),
    };
    if (!review) {
      if (!(await createReview(c.env.DB, { ...actor, reviewId: id(), opportunityId: opp.id, flags, eventId: id(), auditId: id() }))) return jsonError(c, 409, 'NOT_SELLER_OPPORTUNITY', 'This opportunity has no seller relationship, so no seller publication review applies.');
    } else {
      if (review.status === 'APPROVED') return jsonError(c, 409, 'INVALID_STATE', 'An approved review must be revoked before it can be edited.');
      if (d.expectedVersion !== review.version) return jsonError(c, 409, 'VERSION_CONFLICT', 'This review changed. Reload and try again.');
      if (!(await saveReview(c.env.DB, { ...actor, review, opportunityId: opp.id, flags, eventId: id(), auditId: id() }))) return jsonError(c, 409, 'VERSION_CONFLICT', 'This review changed. Reload and try again.');
    }
    return c.json({ data: { saved: true } });
  }
  if (!publisherRoles.includes(staff.role)) return jsonError(c, 403, 'FORBIDDEN', 'Only an authorised publisher can approve, reject or revoke a publication review.');
  if (!review) return jsonError(c, 404, 'NOT_FOUND', 'No review has been prepared.');
  if (d.expectedVersion !== review.version) return jsonError(c, 409, 'VERSION_CONFLICT', 'This review changed. Reload and try again.');
  if (d.confirm !== true) return jsonError(c, 422, 'CONFIRMATION_REQUIRED', 'Confirm this decision to continue.');
  if (d.action !== 'approve' && (d.reason?.length ?? 0) < 5) return jsonError(c, 422, 'REASON_REQUIRED', 'A reason of at least 5 characters is required.');
  if (d.action === 'approve') {
    const problem = approvalProblem(review, (await loadSellerPolicy(c.env)).separationOfDuties ? staff.id : null);
    if (problem) return jsonError(c, 409, 'GATE_NOT_MET', problem);
    const gates = evaluatePublicationGates({ ...(await loadGateInput(c.env.DB, opp.id)) }, actor.ts);
    const blockers = gates.unmet.filter((m) => !m.startsWith('Publication review'));
    if (blockers.length) return c.json({ error: { code: 'GATE_NOT_MET', message: 'Resolve the authority and mandate gates first.', unmet: blockers }, requestId: c.get('requestId') }, 409);
  } else if (review.status !== (d.action === 'revoke' ? 'APPROVED' : 'DRAFT')) return jsonError(c, 409, 'INVALID_STATE', `A ${review.status} review cannot be ${d.action === 'revoke' ? 'revoked' : 'rejected'}.`);
  const ok = await decideReview(c.env.DB, { ...actor, review, opportunityId: opp.id, decision: d.action, note: d.reason ?? '', eventId: id(), auditId: id() });
  if (!ok) return jsonError(c, 409, 'VERSION_CONFLICT', 'This review changed. Reload and try again.');
  if (d.action === 'revoke' && opp.live) await purgeOpportunityPublicCache(c.env, opp.slug, opp.country);
  return c.json({ data: { status: d.action === 'approve' ? 'APPROVED' : d.action === 'reject' ? 'REJECTED' : 'REVOKED', withdrewListing: d.action === 'revoke' && Boolean(opp.live) } });
});

function approvalProblem(review: ReviewRow, separationActorId: string | null): string | null {
  if (review.status !== 'DRAFT') return `A ${review.status} review cannot be approved.`;
  const flags = ['scopeConfirmed', 'confidentialityReviewed', 'publicFieldsApproved', 'sensitiveDataReviewed', 'imageRightsChecked', 'legalReviewCompleted'];
  if (!flags.every((f) => review[f] === 1)) return 'Every confirmation (scope, confidentiality, public fields, sensitive data, image rights, legal review) must be recorded first.';
  if (String(review.scopeText ?? '').length < 10) return 'Describe the publication scope (at least 10 characters).';
  if (separationActorId && separationActorId === review.preparedBy) return 'The person who prepared this review cannot approve it.';
  return null;
}

export default admin;
