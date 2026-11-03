import { Hono } from 'hono';
import { requireRole } from '../../auth/staff-session';
import { requireRecentMfa } from '../../auth/step-up';
import { listMessagesForExport } from '../../seller/message-repo';
import {
  anonymiseEnquiry, anonymiseSeller, findPrivacyEnquiry, findPrivacySeller, setSellerLegalHold, findPrivacyRequest, insertPrivacyRequest, listPrivacyRequests, recordExport, retentionCandidates, setLegalHold, updatePrivacyRequest, withdrawMarketingConsent,
} from '../../seller/privacy-repo';
import { generateRef, REFERENCE_PATTERN, SELLER_REF_PATTERN } from '../../seller/reference';
import { anonymiseSchema, legalHoldSchema, privacyRequestSchema, privacyUpdateSchema, sellerAnonymiseSchema } from '../../seller/seller-schemas';
import { runEvidencePurge } from '../../seller/evidence-purge';
import { loadSellerPolicy } from '../../seller/policy-load';
import { isUniqueViolation } from '../../seller/repo';
import { jsonError, loadEnquiry, readJson } from '../../seller/staff-access';
import { getEnquiry, listAuditFor, listCommunications, listFollowups, listHistory, listNotes, latestQualification } from '../../seller/staff-repo';
import { type AdminApp, id, now, sellerExportRoles, sellerRetentionRoles, sellerWorkRoles } from '../shared';

const admin = new Hono<AdminApp>();
const ADMIN_SCOPE = (staffId: string) => ({ brokerOnly: 0 as const, staffId });

admin.get('/seller-privacy/ui', requireRole(...sellerRetentionRoles), async (c) =>
  c.html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Seller privacy · Luminous Agents</title><link rel="stylesheet" href="/static/css/site.css"><link rel="stylesheet" href="/static/css/dashboard.css"></head><body><main class="admin"><p class="eyebrow">STAFF WORKSPACE</p><h1>Seller privacy and retention</h1><nav class="admin-nav"><a href="/dashboard">Overview</a><a href="/dashboard/seller-enquiries/ui">Seller enquiries</a><a href="/dashboard/seller-privacy/ui">Privacy</a><a href="/admin/logout">Sign out</a></nav><p class="muted">Anonymisation is irreversible. Retention periods are set by the business, not by this tool.</p><p id="sp-notice" role="status"></p><section id="sp-candidates" aria-live="polite">Loading…</section><section id="sp-requests" aria-live="polite"></section></main><dialog id="sp-confirm"><form method="dialog"><p id="sp-confirm-text"></p><label id="sp-input-wrap" hidden><span id="sp-input-label"></span> <input id="sp-input" autocomplete="off"></label><menu><button value="cancel">Cancel</button><button value="ok" class="button button-primary">Confirm</button></menu></form></dialog><script src="/static/js/dashboard-seller-privacy.js" defer></script></body></html>`,
  ),
);

/** Lists enquiries due for retention REVIEW. Only works once the business has configured an approved period; the system assumes none. */
admin.get('/seller-retention/candidates', requireRole(...sellerRetentionRoles), async (c) => {
  const days = (await loadSellerPolicy(c.env)).retentionReviewDays;
  if (days === null) return c.json({ policyConfigured: false, data: [], note: 'No approved retention period is configured (Seller settings, or SELLER_RETENTION_REVIEW_DAYS), so nothing is listed.' });
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  return c.json({ policyConfigured: true, reviewAfterDays: days, data: await retentionCandidates(c.env.DB, cutoff, 100) });
});

/** Irreversible. Typed reference confirmation, a reason, recent MFA, no legal hold, no seller link, closed or declined only. */
admin.post('/seller-enquiries/:ref/anonymise', requireRole(...sellerRetentionRoles), requireRecentMfa('/dashboard/seller-privacy/ui'), async (c) => {
  const parsed = anonymiseSchema.safeParse(await readJson(c));
  const ref = c.req.param('ref') ?? '';
  if (!parsed.success || parsed.data.confirmReference !== ref) return jsonError(c, 422, 'CONFIRMATION_REQUIRED', 'Type the enquiry reference exactly, give a reason, and confirm.');
  if (!REFERENCE_PATTERN.test(ref)) return jsonError(c, 404, 'NOT_FOUND', 'Enquiry not found.');
  const enquiry = await findPrivacyEnquiry(c.env.DB, ref);
  if (!enquiry) return jsonError(c, 404, 'NOT_FOUND', 'Enquiry not found.');
  if (enquiry.anonymisedAt) return jsonError(c, 409, 'INVALID_STATE', 'Already anonymised.');
  if (enquiry.legalHold) return jsonError(c, 409, 'LEGAL_HOLD', 'This enquiry is under a legal hold.');
  if (enquiry.sellerId) return jsonError(c, 409, 'INVALID_STATE', 'This enquiry is linked to a seller record. Seller records are not anonymised by this tool.');
  if (!['DECLINED', 'CLOSED'].includes(enquiry.status)) return jsonError(c, 409, 'INVALID_STATE', 'Only declined or closed enquiries can be anonymised.');
  const ok = await anonymiseEnquiry(c.env.DB, { id: c.get('staff').id, requestId: c.get('requestId'), ts: now(), enquiry, reason: parsed.data.reason, auditId: id() });
  if (!ok) return jsonError(c, 409, 'INVALID_STATE', 'The enquiry changed and was not anonymised.');
  return c.json({ data: { reference: ref, anonymised: true } });
});

admin.post('/seller-enquiries/:ref/legal-hold', requireRole(...sellerRetentionRoles), async (c) => {
  const parsed = legalHoldSchema.safeParse(await readJson(c));
  if (!parsed.success) return jsonError(c, 422, 'VALIDATION_ERROR', 'Provide hold true/false, a reason and confirmation.');
  const ref = c.req.param('ref') ?? '';
  const enquiry = REFERENCE_PATTERN.test(ref) ? await findPrivacyEnquiry(c.env.DB, ref) : null;
  if (!enquiry) return jsonError(c, 404, 'NOT_FOUND', 'Enquiry not found.');
  if (!(await setLegalHold(c.env.DB, { id: c.get('staff').id, requestId: c.get('requestId'), ts: now(), enquiry, hold: parsed.data.hold, reason: parsed.data.reason, auditId: id() }))) return jsonError(c, 409, 'NO_CHANGE', 'Nothing to change (already in that state, or anonymised).');
  return c.json({ data: { reference: ref, legalHold: parsed.data.hold } });
});

/** Withdrawal of optional marketing consent. It never affects how the enquiry itself is handled. */
admin.post('/seller-enquiries/:ref/marketing-withdrawal', requireRole(...sellerWorkRoles), async (c) => {
  const enquiry = await loadEnquiry(c);
  if (enquiry instanceof Response) return enquiry;
  const full = await findPrivacyEnquiry(c.env.DB, enquiry.reference);
  if (!full || !(await withdrawMarketingConsent(c.env.DB, { id: c.get('staff').id, requestId: c.get('requestId'), ts: now(), enquiry: full, auditId: id() }))) return jsonError(c, 409, 'NO_CHANGE', 'No active marketing consent to withdraw.');
  return c.json({ data: { reference: enquiry.reference, marketingConsentWithdrawn: true } });
});

admin.get('/seller-privacy-requests', requireRole(...sellerRetentionRoles), async (c) => {
  const status = new URL(c.req.url).searchParams.get('status') ?? '';
  return c.json({ data: await listPrivacyRequests(c.env.DB, ['OPEN', 'IN_PROGRESS', 'COMPLETED', 'REFUSED'].includes(status) ? status : '') });
});
admin.post('/seller-privacy-requests', requireRole(...sellerRetentionRoles), async (c) => {
  const parsed = privacyRequestSchema.safeParse(await readJson(c));
  if (!parsed.success) return jsonError(c, 422, 'VALIDATION_ERROR', 'Check the request type and dates.');
  const d = parsed.data;
  let enquiryId: string | null = null;
  if (d.enquiryReference) {
    const e = await findPrivacyEnquiry(c.env.DB, d.enquiryReference);
    if (!e) return jsonError(c, 404, 'NOT_FOUND', 'Enquiry not found.');
    enquiryId = e.id;
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const reference = generateRef('CM-P');
    try {
      await insertPrivacyRequest(c.env.DB, { id: c.get('staff').id, requestId: c.get('requestId'), ts: now(), privacyId: id(), reference, enquiryId, requestType: d.requestType, receivedAt: d.receivedAt ? new Date(d.receivedAt).toISOString() : now(), dueAt: d.dueAt ? new Date(d.dueAt).toISOString() : null, auditId: id() });
      return c.json({ data: { reference, status: 'OPEN' } }, 201);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }
  return jsonError(c, 409, 'CONFLICT', 'Could not allocate a reference. Try again.');
});
admin.post('/seller-privacy-requests/:ref/update', requireRole(...sellerRetentionRoles), async (c) => {
  const parsed = privacyUpdateSchema.safeParse(await readJson(c));
  if (!parsed.success) return jsonError(c, 422, 'VALIDATION_ERROR', 'Provide the status, an outcome note (5+ characters) and confirmation.');
  const request = await findPrivacyRequest(c.env.DB, c.req.param('ref') ?? '');
  if (!request) return jsonError(c, 404, 'NOT_FOUND', 'Request not found.');
  if (parsed.data.expectedVersion !== request.version) return jsonError(c, 409, 'VERSION_CONFLICT', 'This request changed. Reload and try again.');
  if (!(await updatePrivacyRequest(c.env.DB, { id: c.get('staff').id, requestId: c.get('requestId'), ts: now(), request, status: parsed.data.status, outcomeNote: parsed.data.outcomeNote, auditId: id() }))) return jsonError(c, 409, 'INVALID_STATE', 'This request is already closed.');
  return c.json({ data: { reference: request.reference, status: parsed.data.status } });
});

/** Subject-data export for one enquiry, including the text of emails sent about it. Super admin only, recent MFA, audited (without content), never cached. */
admin.get('/seller-enquiries/:ref/export', requireRole(...sellerExportRoles), requireRecentMfa('/dashboard/seller-privacy/ui'), async (c) => {
  const ref = c.req.param('ref') ?? '';
  if (!REFERENCE_PATTERN.test(ref)) return jsonError(c, 404, 'NOT_FOUND', 'Enquiry not found.');
  const row = await getEnquiry(c.env.DB, ref, ADMIN_SCOPE(c.get('staff').id));
  if (!row) return jsonError(c, 404, 'NOT_FOUND', 'Enquiry not found.');
  const { id: enquiryId, ...enquiry } = row as Record<string, unknown> & { id: string };
  const [notes, communications, followups, history, qualification, messages, auditTrail] = await Promise.all([
    listNotes(c.env.DB, enquiryId), listCommunications(c.env.DB, enquiryId), listFollowups(c.env.DB, enquiryId), listHistory(c.env.DB, enquiryId),
    latestQualification(c.env.DB, enquiryId), listMessagesForExport(c.env.DB, enquiryId), listAuditFor(c.env.DB, enquiryId),
  ]);
  await recordExport(c.env.DB, { id: c.get('staff').id, requestId: c.get('requestId'), ts: now(), enquiryId, reference: ref, auditId: id() });
  c.header('Cache-Control', 'no-store');
  c.header('Content-Disposition', `attachment; filename="seller-enquiry-${ref}.json"`);
  return c.json({ exportedAt: now(), enquiry, notes, communications, followups, statusHistory: history, qualification, messages, audit: auditTrail });
});

/** Seller erasure. The seller must already be INACTIVE; the database refuses it while any relationship, enquiry, interest or listing is still live or held. */
admin.post('/sellers/:ref/anonymise', requireRole(...sellerRetentionRoles), requireRecentMfa('/dashboard/seller-privacy/ui'), async (c) => {
  const parsed = sellerAnonymiseSchema.safeParse(await readJson(c));
  const ref = c.req.param('ref') ?? '';
  if (!parsed.success || parsed.data.confirmReference !== ref) return jsonError(c, 422, 'CONFIRMATION_REQUIRED', 'Type the seller reference exactly, give a reason, and confirm.');
  const seller = SELLER_REF_PATTERN.test(ref) ? await findPrivacySeller(c.env.DB, ref) : null;
  if (!seller) return jsonError(c, 404, 'NOT_FOUND', 'Seller not found.');
  if (seller.anonymisedAt) return jsonError(c, 409, 'INVALID_STATE', 'Already anonymised.');
  if (seller.legalHold) return jsonError(c, 409, 'LEGAL_HOLD', 'This seller is under a legal hold.');
  if (seller.status !== 'INACTIVE') return jsonError(c, 409, 'INVALID_STATE', 'Set the seller to INACTIVE first (after ending relationships and closing enquiries).');
  const ok = await anonymiseSeller(c.env.DB, { id: c.get('staff').id, requestId: c.get('requestId'), ts: now(), seller, reason: parsed.data.reason, auditId: id() });
  if (!ok) return jsonError(c, 409, 'GATE_NOT_MET', 'Not anonymised: an active relationship, live listing, open or held enquiry, or open material interest still exists.');
  await runEvidencePurge(c.env).catch(() => undefined); // best effort now; the scheduled purge retries anything left
  return c.json({ data: { reference: ref, anonymised: true } });
});

admin.post('/sellers/:ref/legal-hold', requireRole(...sellerRetentionRoles), async (c) => {
  const parsed = legalHoldSchema.safeParse(await readJson(c));
  if (!parsed.success) return jsonError(c, 422, 'VALIDATION_ERROR', 'Provide hold true/false, a reason and confirmation.');
  const ref = c.req.param('ref') ?? '';
  const seller = SELLER_REF_PATTERN.test(ref) ? await findPrivacySeller(c.env.DB, ref) : null;
  if (!seller) return jsonError(c, 404, 'NOT_FOUND', 'Seller not found.');
  if (!(await setSellerLegalHold(c.env.DB, { id: c.get('staff').id, requestId: c.get('requestId'), ts: now(), seller, hold: parsed.data.hold, reason: parsed.data.reason, auditId: id() }))) return jsonError(c, 409, 'NO_CHANGE', 'Nothing to change.');
  return c.json({ data: { reference: ref, legalHold: parsed.data.hold } });
});

export default admin;
