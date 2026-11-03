import { requireRole } from '../../auth/staff-session';
import { Hono } from 'hono';
import { type AdminApp, audit, now } from '../shared';
import { findJob, listRecentJobs, requeueJob } from '../repos/notifications-repo';

const admin = new Hono<AdminApp>();

admin.get('/notifications/ui', requireRole('admin', 'auditor', 'super_admin'), async (c) => {
  return c.html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Notification operations · Luminous Agents</title><link rel="stylesheet" href="/static/css/site.css"><link rel="stylesheet" href="/static/css/dashboard.css"></head><body><main class="admin"><p class="eyebrow">STAFF WORKSPACE</p><h1>Notification operations</h1><nav class="admin-nav"><a href="/dashboard">Overview</a><a href="/dashboard/tasks/ui">Tasks</a><a href="/dashboard/notifications/jobs">Notification job API</a><a href="/dashboard/audit/ui">Audit log</a><a href="/admin/logout">Sign out</a></nav><p class="muted">Delivery status only. Payloads and one-time sign-in codes are never exposed here.</p><p id="notice" role="status"></p><section id="jobs">Loading notification jobs…</section></main><script src="/static/js/dashboard-notifications.js" defer></script></body></html>`,
  );
});

admin.get('/notifications/jobs', requireRole('admin', 'auditor', 'super_admin'), async (c) => {
  return c.json({ data: await listRecentJobs(c.env.DB, 100), limit: 100 });
});

admin.post('/notifications/jobs/:id/retry', requireRole('admin', 'super_admin'), async (c) => {
  const job = await findJob(c.env.DB, c.req.param('id'));
  if (!job)
    return c.json({ error: { code: 'NOT_FOUND', message: 'Notification job not found.' } }, 404);
  if (job.status === 'sent' || job.status === 'processing')
    return c.json(
      { error: { code: 'CONFLICT', message: 'Only unsent jobs can be retried.' } },
      409,
    );
  const timestamp = now();
  await requeueJob(c.env.DB, job.id, timestamp);
  await audit(c, 'notification.retry_requested', 'notification_job', job.id, {
    previousStatus: job.status,
  });
  try {
    await c.env.NOTIFICATIONS_QUEUE.send({ jobId: job.id, type: job.jobType });
  } catch {
    /* Scheduled recovery will re-enqueue due jobs. */
  }
  return c.json({ data: { id: job.id, status: 'queued' } });
});

export default admin;
