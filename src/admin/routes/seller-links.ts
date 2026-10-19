import { Hono } from 'hono';
import { requireRole } from '../../auth/staff-session';
import { slugify } from '../../domain/opportunities/slug';
import { generateRef } from '../../seller/reference';
import { createSellerFromEnquiry, endLink, findLink, findSellerById, findSellerRef, insertLink, linkEnquiryToSeller, reviewLink, sellersWithEmail } from '../../seller/seller-repo';
import { convertSchema, linkReviewSchema, linkSchema, sellerFromEnquirySchema } from '../../seller/seller-schemas';
import { loadSeller } from '../../seller/seller-access';
import { jsonError, loadEnquiry, readJson } from '../../seller/staff-access';
import { isUniqueViolation } from '../../seller/repo';
import { getEnquiry } from '../../seller/staff-repo';
import { convertEnquiry } from '../../seller/publication-repo';
import { activeBrokerExists, slugExists } from '../repos/opportunities-repo';
import { type AdminApp, id, now, sellerAssignRoles, sellerWorkRoles } from '../shared';

const admin = new Hono<AdminApp>();
const SELLER_STAGES = ['QUALIFICATION', 'AUTHORITY_REVIEW', 'QUALIFIED'];

/** Create a seller from a qualified-stage enquiry, or explicitly link it to an existing seller. Never merges automatically. */
admin.post('/seller-enquiries/:ref/seller', requireRole(...sellerWorkRoles), async (c) => {
  const parsed = sellerFromEnquirySchema.safeParse(await readJson(c));
  if (!parsed.success) return jsonError(c, 422, 'VALIDATION_ERROR', 'Choose create or link, confirm, and provide the enquiry version.');
  const enquiry = await loadEnquiry(c);
  if (enquiry instanceof Response) return enquiry;
  if (enquiry.sellerId) return jsonError(c, 409, 'ALREADY_LINKED', 'This enquiry already has a seller.');
  if (!SELLER_STAGES.includes(enquiry.status)) return jsonError(c, 409, 'INVALID_STATE', 'A seller can be created once the enquiry reaches qualification.');
  if (!enquiry.assignedTo) return jsonError(c, 409, 'GATE_NOT_MET', 'Assign an owner before creating a seller.');
  if (parsed.data.expectedVersion !== enquiry.version) return jsonError(c, 409, 'VERSION_CONFLICT', 'This enquiry changed. Reload and try again.');
  const actor = { id: c.get('staff').id, requestId: c.get('requestId'), ts: now() };
  if (parsed.data.mode === 'link') {
    if (!sellerAssignRoles.includes(c.get('staff').role)) return jsonError(c, 403, 'FORBIDDEN', 'Only a manager can link an enquiry to an existing seller.');
    const seller = await findSellerRef(c.env.DB, parsed.data.sellerReference, { brokerOnly: 0, staffId: actor.id });
    if (!seller) return jsonError(c, 404, 'NOT_FOUND', 'Seller not found.');
    const ok = await linkEnquiryToSeller(c.env.DB, { ...actor, enquiryId: enquiry.id, expectedVersion: enquiry.version, seller, auditId: id(), enquiryReference: enquiry.reference });
    if (!ok) return jsonError(c, 409, 'VERSION_CONFLICT', 'This enquiry changed. Reload and try again.');
    return c.json({ data: { sellerReference: seller.reference } });
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const reference = generateRef('CM-C');
    try {
      const ok = await createSellerFromEnquiry(c.env.DB, { ...actor, enquiryId: enquiry.id, expectedVersion: enquiry.version, sellerId: id(), reference, ownerId: enquiry.assignedTo, auditId: id(), enquiryReference: enquiry.reference });
      if (!ok) return jsonError(c, 409, 'VERSION_CONFLICT', 'This enquiry changed. Reload and try again.');
      return c.json({ data: { sellerReference: reference } }, 201);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }
  return jsonError(c, 409, 'CONFLICT', 'Could not allocate a seller reference. Try again.');
});

/** Managers only: other sellers sharing the contact email. A hint for a deliberate decision; nothing is merged. */
admin.get('/seller-enquiries/:ref/seller-candidates', requireRole(...sellerAssignRoles), async (c) => {
  const enquiry = await loadEnquiry(c);
  if (enquiry instanceof Response) return enquiry;
  const full = await getEnquiry(c.env.DB, enquiry.reference, { brokerOnly: 0, staffId: c.get('staff').id });
  return c.json({ data: full ? await sellersWithEmail(c.env.DB, String(full.email)) : [] });
});

/**
 * Explicit conversion of a QUALIFIED enquiry (with a linked seller) into a private draft opportunity. The title is supplied by staff:
 * nothing from the enquiry is copied into public fields. The enquiry becomes CONVERTED in the same transaction.
 */
admin.post('/seller-enquiries/:ref/convert', requireRole(...sellerWorkRoles), async (c) => {
  const parsed = convertSchema.safeParse(await readJson(c));
  if (!parsed.success) return jsonError(c, 422, 'VALIDATION_ERROR', 'Provide a neutral title, the seller role, the enquiry version and confirmation.');
  const enquiry = await loadEnquiry(c);
  if (enquiry instanceof Response) return enquiry;
  if (enquiry.status !== 'QUALIFIED') return jsonError(c, 409, 'INVALID_STATE', 'Only a qualified enquiry can be converted.');
  if (!enquiry.sellerId) return jsonError(c, 409, 'GATE_NOT_MET', 'Create or link a seller first.');
  if (parsed.data.expectedVersion !== enquiry.version) return jsonError(c, 409, 'VERSION_CONFLICT', 'This enquiry changed. Reload and try again.');
  const sellerRow = await findSellerById(c.env.DB, enquiry.sellerId);
  if (!sellerRow) return jsonError(c, 404, 'NOT_FOUND', 'Seller not found.');
  const opportunityId = id();
  let slug = slugify(parsed.data.title);
  if (await slugExists(c.env.DB, slug)) slug = `${slug}-${opportunityId.slice(0, 8)}`;
  const assignedBrokerId = enquiry.assignedTo && (await activeBrokerExists(c.env.DB, enquiry.assignedTo)) ? enquiry.assignedTo : null;
  const ts = now();
  const snapshot = { id: opportunityId, slug, title: parsed.data.title, country: parsed.data.country ?? '', opportunityType: parsed.data.opportunityType, classification: 'confidential', lifecycle: 'draft', contentReviewStatus: 'pending', publicVisibility: 0, assignedBrokerId };
  try {
    const ok = await convertEnquiry(c.env.DB, {
      id: c.get('staff').id, requestId: c.get('requestId'), ts, enquiryId: enquiry.id, enquiryReference: enquiry.reference, expectedVersion: enquiry.version, sellerId: sellerRow.id,
      sellerReference: sellerRow.reference, role: parsed.data.role, assignedBrokerId, opportunityId, slug, title: parsed.data.title, country: parsed.data.country ?? '', opportunityType: parsed.data.opportunityType,
      snapshotJson: JSON.stringify(snapshot), linkId: id(), versionId: id(), historyId: id(), auditEnquiryId: id(), auditOpportunityId: id(),
    });
    if (!ok) return jsonError(c, 409, 'VERSION_CONFLICT', 'This enquiry changed. Reload and try again.');
  } catch (error) {
    if (isUniqueViolation(error)) return jsonError(c, 409, 'CONFLICT', 'That title is already in use. Choose a different title.');
    throw error;
  }
  return c.json({ data: { opportunityId, slug, lifecycle: 'draft', publicVisibility: false, enquiryStatus: 'CONVERTED' } }, 201);
});

admin.post('/sellers/:ref/links', requireRole(...sellerWorkRoles), async (c) => {
  const parsed = linkSchema.safeParse(await readJson(c));
  if (!parsed.success) return jsonError(c, 422, 'VALIDATION_ERROR', 'Provide an opportunity, the seller role and confirmation.');
  const seller = await loadSeller(c);
  if (seller instanceof Response) return seller;
  const ok = await insertLink(c.env.DB, { id: c.get('staff').id, requestId: c.get('requestId'), ts: now(), linkId: id(), sellerId: seller.id, sellerReference: seller.reference, opportunityId: parsed.data.opportunityId, role: parsed.data.role, restrictions: parsed.data.confidentialityRestrictions ?? '', auditId: id() });
  if (!ok) return jsonError(c, 409, 'CANNOT_LINK', 'The opportunity was not found, is already linked, or is live. Only private opportunities can be linked.');
  return c.json({ data: { linked: true } }, 201);
});

admin.post('/sellers/:ref/links/:linkId/review', requireRole(...sellerAssignRoles), async (c) => {
  if (!linkReviewSchema.safeParse(await readJson(c)).success) return jsonError(c, 422, 'CONFIRMATION_REQUIRED', 'Confirm that you reviewed the seller confidentiality restrictions.');
  const seller = await loadSeller(c);
  if (seller instanceof Response) return seller;
  const link = await findLink(c.env.DB, seller.id, c.req.param('linkId') ?? '');
  if (!link) return jsonError(c, 404, 'NOT_FOUND', 'Link not found.');
  if (!(await reviewLink(c.env.DB, { id: c.get('staff').id, requestId: c.get('requestId'), ts: now(), link, sellerReference: seller.reference, auditId: id() }))) return jsonError(c, 409, 'INVALID_STATE', 'This relationship has ended.');
  return c.json({ data: { reviewStatus: 'REVIEWED' } });
});

admin.post('/sellers/:ref/links/:linkId/end', requireRole(...sellerAssignRoles), async (c) => {
  if (!linkReviewSchema.safeParse(await readJson(c)).success) return jsonError(c, 422, 'CONFIRMATION_REQUIRED', 'Confirm that you want to end this relationship.');
  const seller = await loadSeller(c);
  if (seller instanceof Response) return seller;
  const link = await findLink(c.env.DB, seller.id, c.req.param('linkId') ?? '');
  if (!link) return jsonError(c, 404, 'NOT_FOUND', 'Link not found.');
  if (!(await endLink(c.env.DB, { id: c.get('staff').id, requestId: c.get('requestId'), ts: now(), link, sellerReference: seller.reference, auditId: id() })))
    return jsonError(c, 409, 'INVALID_STATE', 'The relationship is already ended, or the opportunity is live. Withdraw it first.');
  return c.json({ data: { relationshipStatus: 'ENDED' } });
});

export default admin;
