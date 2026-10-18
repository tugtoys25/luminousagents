import { Hono } from 'hono';
import { requireRole } from '../../auth/staff-session';
import { isStatus, isTerminal } from '../../seller/lifecycle';
import { completeFollowupSchema, communicationSchema, followupSchema, noteSchema, qualificationSchema } from '../../seller/staff-schemas';
import { jsonError, loadEnquiry, readJson } from '../../seller/staff-access';
import { completeFollowup, insertCommunication, insertFollowup, insertNote, insertQualification, isAssignableOwner } from '../../seller/staff-repo';
import { type AdminApp, id, now, sellerWorkRoles } from '../shared';

const admin = new Hono<AdminApp>();
const bad = 'Check the highlighted fields and try again.';

admin.post('/seller-enquiries/:ref/notes', requireRole(...sellerWorkRoles), async (c) => {
  const parsed = noteSchema.safeParse(await readJson(c));
  if (!parsed.success) return jsonError(c, 422, 'VALIDATION_ERROR', 'Provide a note of 2 to 3000 characters.');
  const enquiry = await loadEnquiry(c);
  if (enquiry instanceof Response) return enquiry;
  const noteId = id();
  await insertNote(c.env.DB, { id: c.get('staff').id, requestId: c.get('requestId'), ts: now(), enquiry, noteId, auditId: id(), ...parsed.data });
  return c.json({ data: { id: noteId } }, 201);
});

admin.post('/seller-enquiries/:ref/communications', requireRole(...sellerWorkRoles), async (c) => {
  const parsed = communicationSchema.safeParse(await readJson(c));
  if (!parsed.success) return jsonError(c, 422, 'VALIDATION_ERROR', bad);
  const enquiry = await loadEnquiry(c);
  if (enquiry instanceof Response) return enquiry;
  const ts = now();
  const occurredAt = parsed.data.occurredAt ?? ts;
  if (Date.parse(occurredAt) > Date.now() + 5 * 60_000) return jsonError(c, 422, 'VALIDATION_ERROR', 'A communication cannot be dated in the future.');
  const commId = id();
  await insertCommunication(c.env.DB, { id: c.get('staff').id, requestId: c.get('requestId'), ts, enquiry, commId, auditId: id(), ...parsed.data, occurredAt: new Date(occurredAt).toISOString() });
  return c.json({ data: { id: commId } }, 201);
});

admin.post('/seller-enquiries/:ref/followups', requireRole(...sellerWorkRoles), async (c) => {
  const parsed = followupSchema.safeParse(await readJson(c));
  if (!parsed.success) return jsonError(c, 422, 'VALIDATION_ERROR', bad);
  const enquiry = await loadEnquiry(c);
  if (enquiry instanceof Response) return enquiry;
  if (!isStatus(enquiry.status) || isTerminal(enquiry.status)) return jsonError(c, 409, 'INVALID_STATE', 'Follow-ups cannot be added to a closed enquiry.');
  const staff = c.get('staff');
  const assignedTo = parsed.data.assignedTo ?? enquiry.assignedTo ?? staff.id;
  // A broker can only schedule work for themselves; managers may schedule for any eligible owner.
  if (staff.role === 'broker' && assignedTo !== staff.id) return jsonError(c, 403, 'FORBIDDEN', 'Brokers can only create follow-ups for themselves.');
  if (!(await isAssignableOwner(c.env.DB, assignedTo))) return jsonError(c, 422, 'VALIDATION_ERROR', 'Assignee must be an active broker or manager.');
  const taskId = id();
  await insertFollowup(c.env.DB, { id: staff.id, requestId: c.get('requestId'), ts: now(), enquiry, taskId, auditId: id(), ...parsed.data, dueAt: new Date(parsed.data.dueAt).toISOString(), assignedTo });
  return c.json({ data: { id: taskId } }, 201);
});

admin.post('/seller-enquiries/:ref/followups/:taskId/complete', requireRole(...sellerWorkRoles), async (c) => {
  const parsed = completeFollowupSchema.safeParse(await readJson(c));
  if (!parsed.success) return jsonError(c, 422, 'VALIDATION_ERROR', 'Record the outcome (2 to 1000 characters).');
  const enquiry = await loadEnquiry(c);
  if (enquiry instanceof Response) return enquiry;
  const taskId = c.req.param('taskId') ?? '';
  if (!/^[0-9a-f-]{36}$/.test(taskId)) return jsonError(c, 404, 'NOT_FOUND', 'Follow-up not found.');
  const ok = await completeFollowup(c.env.DB, { id: c.get('staff').id, requestId: c.get('requestId'), ts: now(), enquiry, taskId, auditId: id(), outcome: parsed.data.outcome });
  if (!ok) return jsonError(c, 404, 'NOT_FOUND', 'Follow-up not found or already completed.');
  return c.json({ data: { id: taskId, status: 'done' } });
});

admin.post('/seller-enquiries/:ref/qualification', requireRole(...sellerWorkRoles), async (c) => {
  const parsed = qualificationSchema.safeParse(await readJson(c));
  if (!parsed.success) return jsonError(c, 422, 'VALIDATION_ERROR', 'Answer every checklist item and choose an outcome and next action.');
  const enquiry = await loadEnquiry(c);
  if (enquiry instanceof Response) return enquiry;
  if (!isStatus(enquiry.status) || isTerminal(enquiry.status)) return jsonError(c, 409, 'INVALID_STATE', 'A closed enquiry cannot be re-qualified.');
  const qualId = id();
  await insertQualification(c.env.DB, {
    id: c.get('staff').id, requestId: c.get('requestId'), ts: now(), enquiry, qualId, auditId: id(),
    checklistJson: JSON.stringify(parsed.data.items), outcome: parsed.data.outcome, nextAction: parsed.data.nextAction, complianceRouted: parsed.data.complianceRouted,
  });
  return c.json({ data: { id: qualId } }, 201);
});

export default admin;
