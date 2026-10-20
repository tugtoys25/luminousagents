import { Hono } from 'hono';
import { requireRole } from '../../auth/staff-session';
import { REFERENCE_PATTERN } from '../../seller/reference';
import {
  CONFIRM_REQUIRED, GENERIC_ENDPOINT_BLOCKED, QUALIFICATION_ITEMS, REASON_REQUIRED, canTransition, genericTransitions, isStatus, isTerminal,
} from '../../seller/lifecycle';
import { assignSchema, listQuerySchema, statusSchema } from '../../seller/staff-schemas';
import { listMessages } from '../../seller/message-repo';
import { jsonError, loadEnquiry, readJson, scopeOf } from '../../seller/staff-access';
import {
  applyStatusOrAssignment, getEnquiry, hasPassingQualification, isAssignableOwner, latestQualification, listAuditFor, listCommunications,
  listEnquiries, listFollowups, listHistory, listNotes,
} from '../../seller/staff-repo';
import { type AdminApp, id, now, sellerAssignRoles, sellerReadRoles, sellerWorkRoles } from '../shared';

const admin = new Hono<AdminApp>();
const MANAGER_ONLY_STATUSES = ['DECLINED', 'CLOSED'];

admin.get('/seller-enquiries/ui', requireRole(...sellerReadRoles), async (c) =>
  c.html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Seller enquiries · Casinos of Mayfair</title><link rel="stylesheet" href="/static/css/site.css"><link rel="stylesheet" href="/static/css/dashboard.css"></head><body><main class="admin"><p class="eyebrow">STAFF WORKSPACE</p><h1>Seller enquiries</h1><nav class="admin-nav"><a href="/dashboard">Overview</a><a href="/dashboard/enquiries/ui">Enquiries</a><a href="/dashboard/seller-enquiries/ui">Seller enquiries</a><a href="/dashboard/tasks/ui">Tasks</a><a href="/admin/logout">Sign out</a></nav><p class="muted">Confidential. Submissions are unqualified leads: not proof of ownership, authority to sell, a mandate or permission to publish.</p><form id="se-filters" class="enq-bar" role="search"></form><p id="se-notice" role="status"></p><div class="enq-layout"><section id="se-list" aria-live="polite">Loading…</section><aside id="se-detail" aria-live="polite"><p class="muted">Select an enquiry.</p></aside></div></main><dialog id="se-confirm"><form method="dialog"><p id="se-confirm-text"></p><label id="se-reason-wrap" hidden>Reason (required) <textarea id="se-confirm-reason" maxlength="1000" rows="3"></textarea></label><menu><button value="cancel">Cancel</button><button value="ok" class="button button-primary">Confirm</button></menu></form></dialog><script src="/static/js/dashboard-seller-enquiries.js" defer></script></body></html>`,
  ),
);

admin.get('/seller-enquiries', requireRole(...sellerReadRoles), async (c) => {
  const q = listQuerySchema.parse(Object.fromEntries(new URL(c.req.url).searchParams));
  const { rows, total } = await listEnquiries(c.env.DB, q, scopeOf(c), now());
  return c.json({ data: rows, page: q.page, pageSize: 25, total });
});

admin.get('/seller-enquiries/:ref', requireRole(...sellerReadRoles), async (c) => {
  const ref = c.req.param('ref');
  if (!REFERENCE_PATTERN.test(ref)) return jsonError(c, 404, 'NOT_FOUND', 'Enquiry not found.');
  const row = await getEnquiry(c.env.DB, ref, scopeOf(c));
  if (!row) return jsonError(c, 404, 'NOT_FOUND', 'Enquiry not found.');
  const { id: enquiryId, ...data } = row as Record<string, unknown> & { id: string };
  const [notes, communications, followups, history, auditTrail, qualification, messages] = await Promise.all([
    listNotes(c.env.DB, enquiryId), listCommunications(c.env.DB, enquiryId), listFollowups(c.env.DB, enquiryId),
    listHistory(c.env.DB, enquiryId), listAuditFor(c.env.DB, enquiryId), latestQualification(c.env.DB, enquiryId), listMessages(c.env.DB, enquiryId),
  ]);
  const role = c.get('staff').role;
  const status = String(data.status);
  const transitions = isStatus(status)
    ? genericTransitions(status).filter((t) => t !== 'ASSIGNED' && (!MANAGER_ONLY_STATUSES.includes(t) || sellerAssignRoles.includes(role)))
    : [];
  return c.json({
    data, notes, communications, followups, history, audit: auditTrail, messages,
    qualification: qualification ? { ...qualification, checklist: JSON.parse(String(qualification.checklistJson)), checklistJson: undefined } : null,
    allowedTransitions: transitions,
    qualificationItems: QUALIFICATION_ITEMS,
    canAssign: sellerAssignRoles.includes(role),
  });
});

admin.post('/seller-enquiries/:ref/assign', requireRole(...sellerAssignRoles), async (c) => {
  const parsed = assignSchema.safeParse(await readJson(c));
  if (!parsed.success) return jsonError(c, 422, 'VALIDATION_ERROR', 'Choose an assignee and confirm the assignment.');
  const enquiry = await loadEnquiry(c);
  if (enquiry instanceof Response) return enquiry;
  if (!isStatus(enquiry.status) || isTerminal(enquiry.status)) return jsonError(c, 409, 'INVALID_STATE', 'A closed enquiry cannot be reassigned.');
  if (enquiry.assignedTo === parsed.data.assigneeId) return jsonError(c, 409, 'NO_CHANGE', 'That broker already owns this enquiry.');
  if (!(await isAssignableOwner(c.env.DB, parsed.data.assigneeId))) return jsonError(c, 422, 'VALIDATION_ERROR', 'Assignee must be an active broker or manager.');
  if (parsed.data.expectedVersion !== enquiry.version) return jsonError(c, 409, 'VERSION_CONFLICT', 'This enquiry changed. Reload and try again.');
  const toStatus = enquiry.status === 'NEW' ? 'ASSIGNED' : enquiry.status;
  const ok = await applyStatusOrAssignment(c.env.DB, {
    id: c.get('staff').id, requestId: c.get('requestId'), ts: now(), enquiry, toStatus, toAssignee: parsed.data.assigneeId, reason: null, closing: false,
    ids: [id(), id()], action: enquiry.assignedTo ? 'seller_enquiry.reassigned' : 'seller_enquiry.assigned',
  });
  if (!ok) return jsonError(c, 409, 'VERSION_CONFLICT', 'This enquiry changed. Reload and try again.');
  return c.json({ data: { reference: enquiry.reference, status: toStatus, version: enquiry.version + 1 } });
});

admin.post('/seller-enquiries/:ref/status', requireRole(...sellerWorkRoles), async (c) => {
  const parsed = statusSchema.safeParse(await readJson(c));
  if (!parsed.success) return jsonError(c, 422, 'VALIDATION_ERROR', 'Provide a valid status and, where required, a reason of at least 5 characters.');
  const enquiry = await loadEnquiry(c);
  if (enquiry instanceof Response) return enquiry;
  const { to, reason, confirm, expectedVersion } = parsed.data;
  const from = enquiry.status;
  if (!isStatus(from) || !canTransition(from, to)) return jsonError(c, 409, 'INVALID_TRANSITION', `${from} cannot move to ${to}.`);
  if (GENERIC_ENDPOINT_BLOCKED.includes(to)) return jsonError(c, 409, 'INVALID_TRANSITION', 'Conversion is only possible through the explicit conversion action.');
  if (to === 'ASSIGNED') return jsonError(c, 409, 'INVALID_TRANSITION', 'Use the assign action to assign an owner.');
  const role = c.get('staff').role;
  if (MANAGER_ONLY_STATUSES.includes(to) && !sellerAssignRoles.includes(role)) return jsonError(c, 403, 'FORBIDDEN', 'Only a manager can decline or close an enquiry.');
  if (REASON_REQUIRED.includes(to) && !reason) return jsonError(c, 422, 'REASON_REQUIRED', 'A reason is required to decline or close an enquiry.');
  if (CONFIRM_REQUIRED.includes(to) && confirm !== true) return jsonError(c, 422, 'CONFIRMATION_REQUIRED', 'Confirm this action to continue.');
  if (!enquiry.assignedTo && !MANAGER_ONLY_STATUSES.includes(to)) return jsonError(c, 409, 'GATE_NOT_MET', 'Assign an owner before progressing this enquiry.');
  if (to === 'QUALIFIED' && !(await hasPassingQualification(c.env.DB, enquiry.id))) return jsonError(c, 409, 'GATE_NOT_MET', 'Record a passing qualification review first.');
  if (expectedVersion !== enquiry.version) return jsonError(c, 409, 'VERSION_CONFLICT', 'This enquiry changed. Reload and try again.');
  const ok = await applyStatusOrAssignment(c.env.DB, {
    id: c.get('staff').id, requestId: c.get('requestId'), ts: now(), enquiry, toStatus: to, toAssignee: enquiry.assignedTo,
    reason: reason ?? null, closing: REASON_REQUIRED.includes(to), ids: [id(), id()], action: 'seller_enquiry.status_changed',
  });
  if (!ok) return jsonError(c, 409, 'VERSION_CONFLICT', 'This enquiry changed. Reload and try again.');
  return c.json({ data: { reference: enquiry.reference, status: to, version: enquiry.version + 1 } });
});

export default admin;
