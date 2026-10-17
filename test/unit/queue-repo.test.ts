import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  buryExhaustedJobs, claimJob, findFormSubmission, findJob, findNdaDecision, findPendingBuyer, listDueJobs,
  markRetryOrDead, markSent, readNotificationEmailSetting, requeueStaleProcessing,
} from '../../src/operations/queue-repo';

const t0 = '2026-08-01T10:00:00.000Z';
const t1 = '2026-08-01T10:30:00.000Z';
async function job(id: string, status = 'queued', attempts = 0, availableAt = t0) {
  await env.DB.prepare(
    "INSERT INTO notification_jobs (id,job_type,payload_json,status,attempts,available_at,created_at,updated_at) VALUES (?,'x','{}',?,?,?,?,?)",
  ).bind(id, status, attempts, availableAt, t0, t0).run();
}
const state = (id: string) =>
  env.DB.prepare('SELECT status, attempts, available_at AS av, updated_at AS upd FROM notification_jobs WHERE id = ?').bind(id).first<Record<string, unknown>>();

describe('notification queue repo', () => {
  it('claims a queued job exactly once (compare-and-set)', async () => {
    await job('q1');
    expect(await claimJob(env.DB, 'q1', t1)).toBe(true);
    expect(await state('q1')).toMatchObject({ status: 'processing', attempts: 1, upd: t1 });
    expect(await claimJob(env.DB, 'q1', t1)).toBe(false); // second consumer loses
    expect((await findJob(env.DB, 'q1'))?.status).toBe('processing');
    expect(await findJob(env.DB, 'nope')).toBeNull();
  });

  it('never claims sent or dead jobs, but does re-claim failed ones', async () => {
    await job('q2', 'sent'); await job('q3', 'dead'); await job('q4', 'failed', 2);
    expect(await claimJob(env.DB, 'q2', t1)).toBe(false);
    expect(await claimJob(env.DB, 'q3', t1)).toBe(false);
    expect(await claimJob(env.DB, 'q4', t1)).toBe(true);
    expect((await state('q4'))?.['attempts']).toBe(3);
  });

  it('marks sent, and retry/dead with the supplied availability', async () => {
    await job('q5', 'processing', 1);
    await markSent(env.DB, 'q5', t1);
    expect(await state('q5')).toMatchObject({ status: 'sent', upd: t1 });
    await job('q6', 'processing', 1);
    await markRetryOrDead(env.DB, { jobId: 'q6', dead: false, availableAt: '2026-08-02T00:00:00.000Z', timestamp: t1 });
    expect(await state('q6')).toMatchObject({ status: 'queued', av: '2026-08-02T00:00:00.000Z' });
    await markRetryOrDead(env.DB, { jobId: 'q6', dead: true, availableAt: t1, timestamp: t1 });
    expect((await state('q6'))?.['status']).toBe('dead');
  });

  it('recovery requeues only STALE processing jobs and buries exhausted failures', async () => {
    await env.DB.prepare("UPDATE notification_jobs SET status = 'sent'").run();
    await job('r1', 'processing', 1); // updated_at = t0 (stale)
    await job('r2', 'processing', 1);
    await env.DB.prepare('UPDATE notification_jobs SET updated_at = ? WHERE id = ?').bind('2026-08-01T10:29:00.000Z', 'r2').run();
    await requeueStaleProcessing(env.DB, '2026-08-01T10:20:00.000Z', t1);
    expect((await state('r1'))?.['status']).toBe('queued');
    expect((await state('r2'))?.['status']).toBe('processing'); // fresh: leave it alone
    await job('r3', 'failed', 5); await job('r4', 'failed', 2);
    await buryExhaustedJobs(env.DB, t1);
    expect((await state('r3'))?.['status']).toBe('dead');
    expect((await state('r4'))?.['status']).toBe('failed');
  });

  it('lists only due, retryable jobs in creation order, capped', async () => {
    await env.DB.prepare("UPDATE notification_jobs SET status = 'sent'").run();
    await job('d1', 'queued', 0, t0); await job('d2', 'failed', 4, t0);
    await job('d3', 'queued', 0, '2030-01-01T00:00:00.000Z'); // not yet due
    await job('d4', 'queued', 5, t0);                          // out of attempts
    const due = (await listDueJobs(env.DB, t1)).map((j) => j.id);
    expect(due).toContain('d1'); expect(due).toContain('d2');
    expect(due).not.toContain('d3'); expect(due).not.toContain('d4');
  });

  it('reads the notification email setting, tolerating junk', async () => {
    expect(await readNotificationEmailSetting(env.DB)).toBe('');
    await env.DB.prepare("INSERT OR REPLACE INTO platform_settings (setting_key, value_json, updated_at) VALUES ('notification_email', ?, ?)").bind(JSON.stringify('ops@example.com'), t0).run();
    expect(await readNotificationEmailSetting(env.DB)).toBe('ops@example.com');
    await env.DB.prepare("UPDATE platform_settings SET value_json = '{bad' WHERE setting_key = 'notification_email'").run();
    expect(await readNotificationEmailSetting(env.DB)).toBe('');
    await env.DB.prepare("UPDATE platform_settings SET value_json = '42' WHERE setting_key = 'notification_email'").run();
    expect(await readNotificationEmailSetting(env.DB)).toBe('');
  });

  it('only reports pending (invited) buyers and undecided NDA data safely', async () => {
    await env.DB.prepare("INSERT INTO users (id, email, display_name, role, user_type, status, created_at, updated_at) VALUES ('qb1', 'qb1@example.com', 'QB', 'buyer', 'buyer', 'invited', ?, ?)").bind(t0, t0).run();
    await env.DB.prepare("INSERT INTO users (id, email, display_name, role, user_type, status, created_at, updated_at) VALUES ('qb2', 'qb2@example.com', 'QB2', 'buyer', 'buyer', 'active', ?, ?)").bind(t0, t0).run();
    expect((await findPendingBuyer(env.DB, 'qb1'))?.email).toBe('qb1@example.com');
    expect(await findPendingBuyer(env.DB, 'qb2')).toBeNull();
    expect(await findNdaDecision(env.DB, 'missing')).toBeNull();
    expect(await findFormSubmission(env.DB, 'missing')).toBeNull();
  });
});
