import { requireRole } from '../../auth/staff-session';
import { z } from 'zod';
import { Hono } from 'hono';
import { findTaskFor, insertTask, isActiveStaff, listTasks, updateTask } from '../repos/tasks-repo';
import { type AdminApp, audit, id, now } from '../shared';

const admin = new Hono<AdminApp>();

admin.get(
  '/tasks/ui',
  requireRole('admin', 'editor', 'broker', 'publisher', 'super_admin'),
  async (c) => {
    return c.html(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Staff tasks · Casinos of Mayfair</title><link rel="stylesheet" href="/static/css/site.css"><link rel="stylesheet" href="/static/css/dashboard.css"></head><body><main class="admin"><p class="eyebrow">STAFF WORKSPACE</p><h1>Task management</h1><nav class="admin-nav"><a href="/dashboard">Overview</a><a href="/dashboard/opportunities/ui">Opportunity CMS</a><a href="/dashboard/buyers/ui">Buyer access</a><a href="/dashboard/enquiries/ui">Enquiries</a><a href="/dashboard/nda-requests/ui">NDA requests</a><a href="/dashboard/notifications/ui">Notifications</a><a href="/dashboard/audit/ui">Audit log</a><a href="/admin/logout">Sign out</a></nav><p class="muted">Create and assign operational follow-ups. Avoid putting sensitive buyer or deal information in task descriptions.</p><form id="task-create" class="task-form"><label>Task title<input name="title" minlength="3" maxlength="180" required></label><label>Priority<select name="priority"><option value="normal">Normal</option><option value="low">Low</option><option value="high">High</option><option value="urgent">Urgent</option></select></label><label>Due date<input name="dueAt" type="datetime-local"></label><label>Assignee user ID (optional)<input name="assignedTo" placeholder="Staff user UUID"></label><label class="full-row">Description<textarea name="description" maxlength="4000"></textarea></label><button type="submit">Create task</button></form><p id="task-notice" class="notice" role="status"></p><section id="task-list" class="task-list" aria-live="polite"><p>Loading tasks…</p></section></main><script src="/static/js/dashboard-tasks.js" defer></script></body></html>`,
    );
  },
);

admin.get(
  '/tasks',
  requireRole('admin', 'editor', 'broker', 'publisher', 'auditor', 'super_admin'),
  async (c) => {
    const status = c.req.query('status') ?? '';
    const assignedTo = c.req.query('assignedTo') ?? '';
    const validStatus = ['open', 'in_progress', 'blocked', 'done', 'cancelled'].includes(status)
      ? status
      : '';
    const staff = c.get('staff');
    const brokerOnly = staff.role === 'broker' ? 1 : 0;
    const data = await listTasks(c.env.DB, { status: validStatus, assignedTo, brokerOnly, staffId: staff.id });
    return c.json({ data, limit: 200 });
  },
);

admin.post(
  '/tasks',
  requireRole('admin', 'editor', 'broker', 'publisher', 'super_admin'),
  async (c) => {
    const parsed = z
      .object({
        title: z.string().trim().min(3).max(180),
        description: z.string().trim().max(4000).optional().default(''),
        priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
        dueAt: z.string().datetime().optional(),
        assignedTo: z.string().uuid().optional(),
        relatedEntityType: z
          .enum(['opportunity', 'enquiry', 'nda_request', 'access_grant'])
          .optional(),
        relatedEntityId: z.string().max(100).optional(),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'Check the task fields.' } },
        422,
      );
    const input = parsed.data;
    const staff = c.get('staff');
    if (staff.role === 'broker' && input.assignedTo && input.assignedTo !== staff.id)
      return c.json(
        { error: { code: 'FORBIDDEN', message: 'Brokers can only assign tasks to themselves.' } },
        403,
      );
    const taskAssignee = staff.role === 'broker' ? staff.id : (input.assignedTo ?? null);
    if (taskAssignee) {
      if (!(await isActiveStaff(c.env.DB, taskAssignee)))
        return c.json(
          { error: { code: 'INVALID_ASSIGNEE', message: 'Choose an active staff member.' } },
          422,
        );
    }
    if (input.relatedEntityType && !input.relatedEntityId)
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'Related entity ID is required.' } },
        422,
      );
    const taskId = id();
    const timestamp = now();
    await insertTask(c.env.DB, {
      id: taskId,
      title: input.title,
      description: input.description,
      priority: input.priority,
      dueAt: input.dueAt ?? null,
      assignedTo: taskAssignee,
      relatedEntityType: input.relatedEntityType ?? null,
      relatedEntityId: input.relatedEntityId ?? null,
      createdBy: staff.id,
      timestamp,
    });
    await audit(c, 'task.created', 'staff_task', taskId, {
      priority: input.priority,
      assignedTo: taskAssignee,
    });
    return c.json(
      {
        data: {
          id: taskId,
          status: 'open',
          ...input,
          assignedTo: taskAssignee,
          createdAt: timestamp,
        },
      },
      201,
    );
  },
);

admin.patch(
  '/tasks/:id',
  requireRole('admin', 'editor', 'broker', 'publisher', 'super_admin'),
  async (c) => {
    const parsed = z
      .object({
        title: z.string().trim().min(3).max(180).optional(),
        description: z.string().trim().max(4000).optional(),
        status: z.enum(['open', 'in_progress', 'blocked', 'done', 'cancelled']).optional(),
        priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
        dueAt: z.string().datetime().nullable().optional(),
        assignedTo: z.string().uuid().nullable().optional(),
      })
      .refine((value) => Object.keys(value).length > 0)
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'Provide at least one valid task field.' } },
        422,
      );
    const staff = c.get('staff');
    const brokerOnly = staff.role === 'broker' ? 1 : 0;
    const current = await findTaskFor(c.env.DB, c.req.param('id'), brokerOnly, staff.id);
    if (!current) return c.json({ error: { code: 'NOT_FOUND', message: 'Task not found.' } }, 404);
    const input = parsed.data;
    if (staff.role === 'broker' && input.assignedTo !== undefined && input.assignedTo !== staff.id)
      return c.json(
        { error: { code: 'FORBIDDEN', message: 'Brokers cannot reassign tasks.' } },
        403,
      );
    if (input.assignedTo) {
      if (!(await isActiveStaff(c.env.DB, input.assignedTo)))
        return c.json(
          { error: { code: 'INVALID_ASSIGNEE', message: 'Choose an active staff member.' } },
          422,
        );
    }
    const timestamp = now();
    await updateTask(c.env.DB, c.req.param('id'), input, timestamp);
    await audit(c, 'task.updated', 'staff_task', current.id, { fields: Object.keys(input) });
    return c.json({ data: { id: current.id, updatedAt: timestamp } });
  },
);

export default admin;
