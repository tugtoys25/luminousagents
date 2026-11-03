import { requireRole } from '../../auth/staff-session';
import { z } from 'zod';
import { Hono } from 'hono';
import { enquiryVisible, findEnquiryRef, getEnquiry, insertNote, listAssignees, listEnquiries, listNotes, updateEnquiry } from '../repos/enquiries-repo';
import { isActiveStaff } from '../repos/staff-repo';
import { type AdminApp, audit, id, now } from '../shared';

const admin = new Hono<AdminApp>();

const enquiryStatuses = ['new', 'assigned', 'in_progress', 'waiting', 'closed', 'spam'] as const;

admin.get(
  '/enquiries/ui',
  requireRole('admin', 'editor', 'broker', 'publisher', 'auditor', 'super_admin'),
  (c) =>
    c.html(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Enquiries · Luminous Agents</title><link rel="stylesheet" href="/static/css/site.css"><link rel="stylesheet" href="/static/css/dashboard.css"></head><body><main class="admin"><p class="eyebrow">STAFF WORKSPACE</p><h1>Enquiries</h1><nav class="admin-nav"><a href="/dashboard">Overview</a><a href="/dashboard/enquiries/ui">Enquiries</a><a href="/dashboard/tasks/ui">Tasks</a><a href="/dashboard/forms/ui">Forms</a><a href="/dashboard/nda-requests/ui">NDA requests</a><a href="/admin/logout">Sign out</a></nav><p class="muted">Website contact enquiries and listing requests. Contact details are confidential; use them only to respond to the request.</p><div class="enq-bar"><label>Status <select id="enq-status"><option value="">All</option><option value="new">New</option><option value="assigned">Assigned</option><option value="in_progress">In progress</option><option value="waiting">Waiting</option><option value="closed">Closed</option><option value="spam">Spam</option></select></label><label>Search <input id="enq-q" type="search" maxlength="100" placeholder="Name, email or company" autocomplete="off"></label></div><p id="enq-notice" role="status"></p><div class="enq-layout"><section id="enq-list" aria-live="polite">Loading enquiries…</section><aside id="enq-detail" aria-live="polite"><p class="muted">Select an enquiry to see the full message, notes and actions.</p></aside></div></main><script src="/static/js/dashboard-enquiries.js" defer></script></body></html>`,
    ),
);

admin.get('/assignees', requireRole('admin', 'editor', 'super_admin'), async (c) => {
  return c.json({ data: await listAssignees(c.env.DB) });
});

admin.get(
  '/enquiries',
  requireRole('admin', 'editor', 'broker', 'publisher', 'auditor', 'super_admin'),
  async (c) => {
    const status = c.req.query('status') ?? '';
    const q = (c.req.query('q') ?? '').trim().slice(0, 100);
    const safeStatus = (enquiryStatuses as readonly string[]).includes(status) ? status : '';
    const staff = c.get('staff');
    const brokerOnly = staff.role === 'broker' ? 1 : 0;
    const data = await listEnquiries(c.env.DB, { status: safeStatus, q, brokerOnly, staffId: staff.id });
    return c.json({ data, limit: 100 });
  },
);

admin.get(
  '/enquiries/:id',
  requireRole('admin', 'editor', 'broker', 'publisher', 'auditor', 'super_admin'),
  async (c) => {
    const staff = c.get('staff');
    const brokerOnly = staff.role === 'broker' ? 1 : 0;
    const row = await getEnquiry(c.env.DB, c.req.param('id'), brokerOnly, staff.id);
    if (!row) return c.json({ error: { code: 'NOT_FOUND', message: 'Enquiry not found.' } }, 404);
    const notes = await listNotes(c.env.DB, c.req.param('id'));
    return c.json({ data: row, notes });
  },
);

admin.patch(
  '/enquiries/:id',
  requireRole('admin', 'editor', 'broker', 'super_admin'),
  async (c) => {
    const schema = z
      .object({
        status: z.enum(enquiryStatuses).optional(),
        assignedTo: z.string().uuid().nullable().optional(),
      })
      .refine((v) => Object.keys(v).length > 0);
    const parsed = schema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'Provide a valid status or assignee.' } },
        422,
      );
    const staff = c.get('staff');
    const brokerOnly = staff.role === 'broker' ? 1 : 0;
    const existing = await findEnquiryRef(c.env.DB, c.req.param('id'), brokerOnly, staff.id);
    if (!existing)
      return c.json({ error: { code: 'NOT_FOUND', message: 'Enquiry not found.' } }, 404);
    if (staff.role === 'broker' && Object.prototype.hasOwnProperty.call(parsed.data, 'assignedTo'))
      return c.json(
        { error: { code: 'FORBIDDEN', message: 'Brokers cannot reassign enquiries.' } },
        403,
      );
    if (parsed.data.assignedTo) {
      if (!(await isActiveStaff(c.env.DB, parsed.data.assignedTo)))
        return c.json(
          {
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Assignee must be an active staff member.',
            },
          },
          422,
        );
    }
    await updateEnquiry(
      c.env.DB,
      existing.id,
      parsed.data,
      Object.prototype.hasOwnProperty.call(parsed.data, 'assignedTo'),
      now(),
    );
    await audit(c, 'enquiry.updated', 'enquiry', existing.id, {
      status: parsed.data.status,
      assignedTo: parsed.data.assignedTo,
    });
    return c.json({
      data: {
        id: existing.id,
        status: parsed.data.status ?? existing.status,
        assignedTo: Object.prototype.hasOwnProperty.call(parsed.data, 'assignedTo')
          ? (parsed.data.assignedTo ?? null)
          : existing.assignedTo,
      },
    });
  },
);

admin.post(
  '/enquiries/:id/notes',
  requireRole('admin', 'editor', 'broker', 'super_admin'),
  async (c) => {
    const parsed = z
      .object({ note: z.string().trim().min(2).max(3000) })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'Provide a note of 2 to 3000 characters.' } },
        422,
      );
    const staff = c.get('staff');
    const brokerOnly = staff.role === 'broker' ? 1 : 0;
    if (!(await enquiryVisible(c.env.DB, c.req.param('id'), brokerOnly, staff.id))) return c.json({ error: { code: 'NOT_FOUND', message: 'Enquiry not found.' } }, 404);
    const noteId = id();
    const timestamp = now();
    await insertNote(c.env.DB, {
      id: noteId,
      enquiryId: c.req.param('id'),
      authorId: c.get('staff').id,
      note: parsed.data.note,
      timestamp,
    });
    await audit(c, 'enquiry.note_added', 'enquiry', c.req.param('id'), { noteId });
    return c.json({ data: { id: noteId, createdAt: timestamp } }, 201);
  },
);

export default admin;
