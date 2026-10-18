/** Scheduled follow-up reminders. Idempotent: one reminder per task per reminder window, one escalation per task. */
import type { Env } from '../env';
import { JOB_FOLLOWUP_DUE } from './repo';
import { enqueueReminderJob, listDueFollowups } from './staff-repo';

export interface ReminderPolicy { enabled: boolean; intervalMs: number; escalateAfterMs: number; hasEscalationRecipients: boolean }

export function reminderPolicy(env: Env): ReminderPolicy {
  const hours = (v: string | undefined, fallback: number, min: number, max: number) => {
    const n = Number.parseInt(v ?? '', 10);
    return Number.isFinite(n) && n >= min ? Math.min(n, max) : fallback;
  };
  return {
    enabled: env.SELLER_REMINDERS_ENABLED !== 'false',
    intervalMs: hours(env.SELLER_REMINDER_INTERVAL_HOURS, 24, 1, 168) * 3_600_000,
    // 0 / unset disables escalation. Not a service-level commitment to sellers.
    escalateAfterMs: hours(env.SELLER_ESCALATION_AFTER_HOURS, 0, 1, 720) * 3_600_000,
    hasEscalationRecipients: Boolean(env.SELLER_ESCALATION_RECIPIENTS?.trim()),
  };
}

/** Index of the reminder window containing `nowMs`, counted from the due time. Stable within a window. */
export const reminderWindow = (dueMs: number, nowMs: number, intervalMs: number): number => Math.max(0, Math.floor((nowMs - dueMs) / intervalMs));

export async function runSellerReminders(env: Env, nowIso = new Date().toISOString()): Promise<{ reminders: number; escalations: number }> {
  const policy = reminderPolicy(env);
  if (!policy.enabled) return { reminders: 0, escalations: 0 };
  const nowMs = Date.parse(nowIso);
  const created: string[] = [];
  let reminders = 0;
  let escalations = 0;
  for (const task of await listDueFollowups(env.DB, nowIso, 100)) {
    const dueMs = Date.parse(task.dueAt);
    const window = reminderWindow(dueMs, nowMs, policy.intervalMs);
    if (task.assignedTo) {
      const jobId = crypto.randomUUID();
      if (await enqueueReminderJob(env.DB, { jobId, taskId: task.taskId, enquiryId: task.enquiryId, dedupeKey: `seller_followup_due:${task.taskId}:${window}`, escalate: false, ts: nowIso })) {
        created.push(jobId);
        reminders++;
      }
    }
    if (policy.escalateAfterMs > 0 && policy.hasEscalationRecipients && !task.escalatedAt && nowMs - dueMs >= policy.escalateAfterMs) {
      const jobId = crypto.randomUUID();
      if (await enqueueReminderJob(env.DB, { jobId, taskId: task.taskId, enquiryId: task.enquiryId, dedupeKey: `seller_followup_escalation:${task.taskId}`, escalate: true, ts: nowIso })) {
        created.push(jobId);
        escalations++;
      }
    }
  }
  for (const jobId of created) {
    try { await env.NOTIFICATIONS_QUEUE.send({ jobId, type: JOB_FOLLOWUP_DUE }); } catch { /* the recovery cron re-enqueues queued jobs */ }
  }
  return { reminders, escalations };
}
