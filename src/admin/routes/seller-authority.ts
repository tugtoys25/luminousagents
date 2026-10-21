import { Hono } from 'hono';
import { requireRecentMfa } from '../../auth/step-up';
import { requireRole } from '../../auth/staff-session';
import { APPROVAL_STATUSES, canAuthorityTransition, isAuthorityStatus, WITHDRAWING_STATUSES } from '../../seller/authority';
import { changeAuthority, findAuthority, insertAuthority, opportunityForLink } from '../../seller/authority-repo';
import { usableEvidenceCount } from '../../seller/evidence-repo';
import { generateRef, AUTHORITY_REF_PATTERN } from '../../seller/reference';
import { findLink } from '../../seller/seller-repo';
import { loadSellerPolicy } from '../../seller/policy-load';
import { loadSeller, sellerScopeOf } from '../../seller/seller-access';
import { authorityCreateSchema, authorityTransitionSchema } from '../../seller/seller-schemas';
import { isUniqueViolation } from '../../seller/repo';
import { jsonError, readJson } from '../../seller/staff-access';
import { type AdminApp, authorityReviewRoles, id, now, purgeOpportunityPublicCache, sellerWorkRoles } from '../shared';

const admin = new Hono<AdminApp>();
const iso = (v: string | undefined): string | null => (v ? new Date(v).toISOString() : null);

/** Records an authority or mandate claim with an evidence REFERENCE. It starts NOT_REVIEWED and proves nothing. */
admin.post('/sellers/:ref/links/:linkId/authority', requireRole(...sellerWorkRoles), async (c) => {
  const parsed = authorityCreateSchema.safeParse(await readJson(c));
  if (!parsed.success) return jsonError(c, 422, 'VALIDATION_ERROR', 'Check the authority type, evidence reference and dates.');
  const seller = await loadSeller(c);
  if (seller instanceof Response) return seller;
  const link = await findLink(c.env.DB, seller.id, c.req.param('linkId') ?? '');
  if (!link) return jsonError(c, 404, 'NOT_FOUND', 'Link not found.');
  const d = parsed.data;
  if (d.evidenceType !== 'NONE' && !d.evidenceRef) return jsonError(c, 422, 'VALIDATION_ERROR', 'Provide the evidence reference.');
  const validFrom = iso(d.validFrom);
  const validUntil = iso(d.validUntil);
  if (validFrom && validUntil && validUntil <= validFrom) return jsonError(c, 422, 'VALIDATION_ERROR', 'The end date must be after the start date.');
  for (let attempt = 0; attempt < 5; attempt++) {
    const reference = generateRef('CM-A');
    try {
      const ok = await insertAuthority(c.env.DB, {
        id: c.get('staff').id, requestId: c.get('requestId'), ts: now(), recordId: id(), reference, eventId: id(), auditId: id(), sellerId: seller.id, sellerReference: seller.reference,
        linkId: link.id, authorityType: d.authorityType, evidenceType: d.evidenceType, evidenceRef: d.evidenceRef ?? null, scope: d.scope ?? '', limitations: d.limitations ?? '', exclusive: d.exclusive, validFrom, validUntil,
      });
      if (!ok) return jsonError(c, 409, 'INVALID_STATE', 'Records can only be added to an active relationship.');
      return c.json({ data: { reference, status: 'NOT_REVIEWED' } }, 201);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }
  return jsonError(c, 409, 'CONFLICT', 'Could not allocate a reference. Try again.');
});

/** Review and approval. Brokers cannot call this; verification also needs a different person from the preparer when separation is enforced. */
admin.post('/authority/:ref/transition', requireRole(...authorityReviewRoles), requireRecentMfa('/dashboard/sellers/ui'), async (c) => {
  const parsed = authorityTransitionSchema.safeParse(await readJson(c));
  if (!parsed.success) return jsonError(c, 422, 'VALIDATION_ERROR', 'Provide the new status, a note of at least 3 characters and the record version.');
  const ref = c.req.param('ref') ?? '';
  if (!AUTHORITY_REF_PATTERN.test(ref)) return jsonError(c, 404, 'NOT_FOUND', 'Record not found.');
  const record = await findAuthority(c.env.DB, ref, sellerScopeOf(c));
  if (!record) return jsonError(c, 404, 'NOT_FOUND', 'Record not found.');
  const d = parsed.data;
  if (!isAuthorityStatus(record.status) || !canAuthorityTransition(record.status, d.to)) return jsonError(c, 409, 'INVALID_TRANSITION', `${record.status} cannot move to ${d.to}.`);
  if (d.expectedVersion !== record.version) return jsonError(c, 409, 'VERSION_CONFLICT', 'This record changed. Reload and try again.');
  const staff = c.get('staff');
  if (APPROVAL_STATUSES.includes(d.to) && d.confirm !== true) return jsonError(c, 422, 'CONFIRMATION_REQUIRED', 'Confirm this decision to continue.');
  const policy = await loadSellerPolicy(c.env);
  if ((d.to === 'VERIFIED' || d.to === 'NOT_REQUIRED_WITH_RECORDED_REASON') && policy.separationOfDuties && staff.id === record.createdBy)
    return jsonError(c, 403, 'SEPARATION_OF_DUTIES', 'The person who recorded this authority cannot verify it.');
  const validFrom = iso(d.validFrom) ?? record.validFrom;
  const validUntil = iso(d.validUntil) ?? record.validUntil;
  const ts = now();
  if (d.to === 'VERIFIED') {
    if ((d.evidenceType ?? record.evidenceType) === 'NONE') return jsonError(c, 422, 'GATE_NOT_MET', 'Record the type and reference of the evidence reviewed.');
    if ((d.scope ?? record.scope).length < 5) return jsonError(c, 422, 'GATE_NOT_MET', 'Record the scope of the authority.');
    // Evidence must actually exist: a recorded reference, or at least one uploaded file that has been scanned clean.
    if (!(d.evidenceRef ?? record.evidenceRef) && (await usableEvidenceCount(c.env.DB, record.id)) === 0) return jsonError(c, 422, 'GATE_NOT_MET', 'Attach a scanned evidence file or record an evidence reference before verifying.');
    if (validUntil && validUntil <= ts) return jsonError(c, 422, 'GATE_NOT_MET', 'The validity period has already ended.');
    if (validFrom && validUntil && validUntil <= validFrom) return jsonError(c, 422, 'VALIDATION_ERROR', 'The end date must be after the start date.');
  }
  if (d.to === 'NOT_REQUIRED_WITH_RECORDED_REASON' && d.note.length < 10) return jsonError(c, 422, 'GATE_NOT_MET', 'Record why this authority is not required (at least 10 characters).');
  const before = WITHDRAWING_STATUSES.includes(d.to) ? await opportunityForLink(c.env.DB, record.linkId) : null;
  const ok = await changeAuthority(c.env.DB, {
    id: staff.id, requestId: c.get('requestId'), ts, record, to: d.to, note: d.note, reviewerId: staff.id, eventId: id(), auditId: id(), withdrawAuditAction: `authority.${d.to.toLowerCase()}_withdrew_listing`,
    evidenceType: d.evidenceType ?? null, evidenceRef: d.evidenceRef ?? null, scope: d.scope ?? null, limitations: d.limitations ?? null, validFrom: iso(d.validFrom), validUntil: iso(d.validUntil),
  });
  if (!ok) return jsonError(c, 409, 'VERSION_CONFLICT', 'This record changed. Reload and try again.');
  let withdrewListing = false;
  if (before?.live) {
    const after = await opportunityForLink(c.env.DB, record.linkId);
    withdrewListing = Boolean(after && !after.live);
    if (withdrewListing) await purgeOpportunityPublicCache(c.env, before.slug, before.country);
  }
  return c.json({ data: { reference: record.reference, status: d.to, version: record.version + 1, withdrewListing } });
});

export default admin;
