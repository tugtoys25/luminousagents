import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  findPublicOpportunityId, findPublishedForm, findPublishedFormForSubmit, findPublishedPage, insertSubmission,
} from '../../src/web/managed-content-repo';

// These steps share database state and must run in order. The Workers test pool undoes storage after
// every test, so they run as steps inside one test instead of as separate `it` blocks.
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof Error) error.message = `[${name}] ${error.message}`;
    throw error;
  }
}

const ts = '2026-09-20T10:00:00.000Z';
const n = async (sql: string, ...a: string[]) => (await env.DB.prepare(sql).bind(...a).first<{ n: number }>())!.n;
const page = (id: string, slug: string, status: string) =>
  env.DB.prepare("INSERT INTO managed_pages (id, slug, title, body_markdown, status, created_at, updated_at) VALUES (?, ?, ?, 'body', ?, ?, ?)").bind(id, slug, `T-${slug}`, status, ts, ts).run();
const form = (id: string, slug: string, status: string, notify = 1) =>
  env.DB.prepare("INSERT INTO managed_forms (id, slug, title, fields_json, notification_enabled, status, created_at, updated_at) VALUES (?, ?, ?, '[]', ?, ?, ?, ?)").bind(id, slug, `F-${slug}`, notify, status, ts, ts).run();
const sub = (id: string, formId: string, over: Record<string, unknown> = {}) => ({
  id, formId, opportunityId: null, dataJson: '{"a":1}', ipHash: null, timestamp: ts, requestId: 'rq', auditId: `aud-${id}`, notificationJobId: `job-${id}`, ...over,
});

describe('managed content repo', () => {
  it('runs its steps in order', async () => {
    await step('managed content repo > serves only published pages and forms', async () => {
      await page('mp1', 'live', 'published'); await page('mp2', 'draft', 'draft'); await page('mp3', 'old', 'archived');
      expect((await findPublishedPage(env.DB, 'live'))?.title).toBe('T-live');
      expect(await findPublishedPage(env.DB, 'draft')).toBeNull();
      expect(await findPublishedPage(env.DB, 'old')).toBeNull();
      expect(await findPublishedPage(env.DB, 'missing')).toBeNull();
      await form('mf1', 'contact', 'published'); await form('mf2', 'hidden', 'draft');
      expect((await findPublishedForm(env.DB, 'contact'))?.id).toBe('mf1');
      expect(await findPublishedForm(env.DB, 'hidden')).toBeNull();
      expect((await findPublishedFormForSubmit(env.DB, 'contact'))?.notificationEnabled).toBe(1);
      expect(await findPublishedFormForSubmit(env.DB, 'hidden')).toBeNull();
    });

    await step('managed content repo > links a submission only to a genuinely public listing', async () => {
      const o = (await env.DB.prepare('SELECT id, slug FROM opportunities ORDER BY id LIMIT 2').all<{ id: string; slug: string }>()).results! as [{ id: string; slug: string }, { id: string; slug: string }];
      await env.DB.prepare("UPDATE opportunities SET lifecycle='published', content_review_status='approved', public_visibility=1 WHERE id = ?").bind(o[0].id).run();
      await env.DB.prepare("UPDATE opportunities SET lifecycle='published', content_review_status='approved', public_visibility=0 WHERE id = ?").bind(o[1].id).run();
      expect(await findPublicOpportunityId(env.DB, o[0].slug)).toBe(o[0].id);
      expect(await findPublicOpportunityId(env.DB, o[1].slug)).toBeNull(); // not visible
      await env.DB.prepare("UPDATE opportunities SET content_review_status='pending' WHERE id = ?").bind(o[0].id).run();
      expect(await findPublicOpportunityId(env.DB, o[0].slug)).toBeNull(); // not approved
      expect(await findPublicOpportunityId(env.DB, 'nope')).toBeNull();
    });

    await step('managed content repo > stores the submission, its public audit row and the notification job together', async () => {
      await insertSubmission(env.DB, sub('s1', 'mf1'));
      expect(await n("SELECT COUNT(*) AS n FROM managed_form_submissions WHERE id='s1' AND consent_at = ? AND data_json = '{\"a\":1}'", ts)).toBe(1);
      expect(await env.DB.prepare("SELECT actor_user_id AS a, actor_type AS t, entity_id AS e FROM audit_logs WHERE id = 'aud-s1'").first()).toMatchObject({ a: null, t: 'public', e: 's1' });
      expect(await n("SELECT COUNT(*) AS n FROM notification_jobs WHERE id='job-s1' AND job_type='managed_form.submitted' AND status='queued' AND payload_json = '{\"submissionId\":\"s1\"}'")).toBe(1);
    });

    await step('managed content repo > queues no job when the form does not notify', async () => {
      await insertSubmission(env.DB, sub('s2', 'mf1', { notificationJobId: null }));
      expect(await n("SELECT COUNT(*) AS n FROM managed_form_submissions WHERE id='s2'")).toBe(1);
      expect(await n("SELECT COUNT(*) AS n FROM notification_jobs WHERE payload_json LIKE '%s2%'")).toBe(0);
    });

    await step('managed content repo > is all-or-nothing: a failure queueing the job leaves no submission or audit row behind', async () => {
      await expect(insertSubmission(env.DB, sub('s3', 'mf1', { notificationJobId: 'job-s1' }))).rejects.toThrow(); // duplicate job id
      expect(await n("SELECT COUNT(*) AS n FROM managed_form_submissions WHERE id='s3'")).toBe(0);
      expect(await n("SELECT COUNT(*) AS n FROM audit_logs WHERE id='aud-s3'")).toBe(0);
    });

    await step('managed content repo > rejects a submission for a form that does not exist (foreign key)', async () => {
      await expect(insertSubmission(env.DB, sub('s4', 'no-such-form'))).rejects.toThrow();
    });
  });
});
