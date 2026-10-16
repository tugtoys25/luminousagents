import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { countAudit, exportAuditRows, pageAudit } from '../../src/admin/repos/audit-repo';
import { listActiveBrokers, loadOverview } from '../../src/admin/repos/overview-repo';
import { listSettings, settingsAuditStatement, upsertSettingStatement } from '../../src/admin/repos/settings-repo';
import { findGrant, listGrants, revokeGrant } from '../../src/admin/repos/access-grants-repo';
import { findTaskFor, insertTask, isActiveStaff, listTasks, updateTask } from '../../src/admin/repos/tasks-repo';
import { findActiveBuyerSession, findActiveStaffSession, listActiveBuyerSessions, listActiveStaffSessions, revokeBuyerSession, revokeStaffSession } from '../../src/admin/repos/sessions-repo';
import { deletePage, findPage, findPageSlugById, listPages, setPageStatus, upsertPage } from '../../src/admin/repos/pages-repo';
import { findSubmission, listForms, querySubmissions, updateSubmission, upsertForm } from '../../src/admin/repos/forms-repo';
import { findJob, listRecentJobs, requeueJob } from '../../src/admin/repos/notifications-repo';

const ts = '2026-03-01T10:00:00.000Z';
async function seedJob(id: string, status: string) {
  await env.DB.prepare(
    "INSERT INTO notification_jobs (id, job_type, payload_json, status, attempts, available_at, created_at, updated_at) VALUES (?, 'enquiry.received', '{}', ?, 1, ?, ?, ?)",
  ).bind(id, status, ts, ts, ts).run();
}
async function seedAudit(id: string, action: string, at: string) {
  await env.DB.prepare(
    "INSERT INTO audit_logs (id, actor_user_id, actor_type, action, entity_type, entity_id, request_id, details_json, created_at) VALUES (?, NULL, 'public', ?, 'x', 'e', 'r', '{}', ?)",
  ).bind(id, action, at).run();
}

describe('notifications repo', () => {
  it('lists jobs without payloads, finds one and requeues it', async () => {
    await seedJob('job-repo-1', 'failed');
    const rows = (await listRecentJobs(env.DB, 100)) as Array<Record<string, unknown>>;
    const row = rows.find((r) => r.id === 'job-repo-1');
    expect(row).toBeDefined();
    expect(Object.keys(row!)).not.toContain('payload_json');
    expect((await findJob(env.DB, 'job-repo-1'))?.status).toBe('failed');
    expect(await findJob(env.DB, 'missing')).toBeNull();
    await requeueJob(env.DB, 'job-repo-1', '2026-03-02T00:00:00.000Z');
    const after = await findJob(env.DB, 'job-repo-1');
    expect(after?.status).toBe('queued');
  });
});

describe('audit repo', () => {
  it('counts, pages and exports with a bound filter', async () => {
    await seedAudit('aud-r1', 'repo.test.alpha', '2026-03-01T10:00:00.000Z');
    await seedAudit('aud-r2', 'repo.test.alpha', '2026-03-02T10:00:00.000Z');
    await seedAudit('aud-r3', 'repo.test.beta', '2026-03-03T10:00:00.000Z');
    const f = { filterSql: ' WHERE a.action = ?', binds: ['repo.test.alpha'] };
    expect(await countAudit(env.DB, f)).toBe(2);
    const page = (await pageAudit(env.DB, f, 1, 0)) as Array<{ id: string }>;
    expect(page).toHaveLength(1);
    expect(page[0]!.id).toBe('aud-r2');
    const exported = await exportAuditRows(env.DB, f);
    expect(exported.map((r) => r.id)).toEqual(['aud-r2', 'aud-r1']);
  });
  it('treats hostile filter values as data, not SQL', async () => {
    const f = { filterSql: ' WHERE a.action = ?', binds: ["x' OR '1'='1"] };
    expect(await countAudit(env.DB, f)).toBe(0);
  });
});

describe('settings repo', () => {
  it('upserts a setting and its audit row in one batch, then lists it', async () => {
    const u = await env.DB.prepare("SELECT id FROM users LIMIT 1").first<{ id: string }>();
    let staffId = u?.id;
    if (!staffId) {
      staffId = 'repo-staff';
      await env.DB.prepare(
        "INSERT INTO users (id, email, display_name, role, user_type, status, created_at, updated_at) VALUES (?, 'repo@example.com', 'Repo', 'admin', 'staff', 'active', ?, ?)",
      ).bind(staffId, ts, ts).run();
    }
    const stamp = '2026-04-01T00:00:00.000Z';
    await env.DB.batch([
      upsertSettingStatement(env.DB, 'site_name', 'First', staffId, stamp),
      upsertSettingStatement(env.DB, 'site_name', 'Second', staffId, stamp),
      settingsAuditStatement(env.DB, { auditId: 'aud-set-1', staffId, requestId: 'r', keys: ['site_name'], timestamp: stamp }),
    ]);
    const row = (await listSettings(env.DB)).find((r) => r.key === 'site_name');
    expect(JSON.parse(row!.value)).toBe('Second');
    const a = await env.DB.prepare("SELECT action FROM audit_logs WHERE id = 'aud-set-1'").first<{ action: string }>();
    expect(a?.action).toBe('platform.settings_updated');
  });
});

describe('overview repo', () => {
  it('returns counts and bounded lists; brokers are scoped to their own records', async () => {
    const all = await loadOverview(env.DB, 'nobody', 0);
    expect(all.counts?.total).toBeGreaterThanOrEqual(198);
    expect(all.pending.length).toBeLessThanOrEqual(8);
    expect(all.recent.length).toBeLessThanOrEqual(10);
    const scoped = await loadOverview(env.DB, 'nobody', 1);
    expect(scoped.counts?.total ?? 0).toBe(0);
    expect(scoped.recent).toHaveLength(0);
  });
  it('lists only active staff brokers', async () => {
    const rows = (await listActiveBrokers(env.DB)) as Array<{ email: string }>;
    expect(Array.isArray(rows)).toBe(true);
  });
});

describe('access grants repo', () => {
  it('lists, finds and revokes a grant exactly once, with an audit row', async () => {
    await env.DB.prepare(
      "INSERT INTO users (id, email, display_name, role, user_type, status, created_at, updated_at) VALUES ('g-buyer', 'g-buyer@example.com', 'G Buyer', 'buyer', 'buyer', 'active', ?, ?)",
    ).bind(ts, ts).run();
    const opp = await env.DB.prepare('SELECT id FROM opportunities LIMIT 1').first<{ id: string }>();
    await env.DB.prepare(
      "INSERT INTO nda_requests (id, user_id, opportunity_id, status, created_at, updated_at) VALUES ('g-nda', 'g-buyer', ?, 'approved', ?, ?)",
    ).bind(opp!.id, ts, ts).run();
    await env.DB.prepare(
      "INSERT INTO access_grants (id, user_id, opportunity_id, nda_request_id, tier, granted_at, expires_at) VALUES ('g-grant', 'g-buyer', ?, 'g-nda', 2, ?, '2099-01-01T00:00:00.000Z')",
    ).bind(opp!.id, ts).run();

    const listed = (await listGrants(env.DB, '2026-06-01T00:00:00.000Z')) as Array<{ id: string; buyerEmail: string }>;
    expect(listed.find((g) => g.id === 'g-grant')?.buyerEmail).toBe('g-buyer@example.com');

    const grant = await findGrant(env.DB, 'g-grant');
    expect(grant?.revokedAt).toBeNull();
    expect(await findGrant(env.DB, 'nope')).toBeNull();

    await revokeGrant(env.DB, { grant: grant!, staffId: 'g-buyer', requestId: 'rq', reason: 'test reason', auditId: 'aud-g1', timestamp: '2026-06-02T00:00:00.000Z' });
    expect((await findGrant(env.DB, 'g-grant'))?.revokedAt).toBe('2026-06-02T00:00:00.000Z');
    // A second revoke must not move the original revocation time.
    await revokeGrant(env.DB, { grant: grant!, staffId: 'g-buyer', requestId: 'rq', reason: 'again', auditId: 'aud-g2', timestamp: '2026-07-01T00:00:00.000Z' });
    expect((await findGrant(env.DB, 'g-grant'))?.revokedAt).toBe('2026-06-02T00:00:00.000Z');
    const a = await env.DB.prepare("SELECT action FROM audit_logs WHERE id = 'aud-g1'").first<{ action: string }>();
    expect(a?.action).toBe('access_grant.revoked');
  });
});

describe('tasks repo', () => {
  const base = { description: '', priority: 'normal', dueAt: null, assignedTo: null, relatedEntityType: null, relatedEntityId: null, createdBy: 't-staff' };
  it('creates, scopes, filters and partially updates tasks', async () => {
    await env.DB.prepare(
      "INSERT INTO users (id, email, display_name, role, user_type, status, created_at, updated_at) VALUES ('t-staff', 't-staff@example.com', 'T Staff', 'broker', 'staff', 'active', ?, ?)",
    ).bind(ts, ts).run();
    expect(await isActiveStaff(env.DB, 't-staff')).toBe(true);
    expect(await isActiveStaff(env.DB, 'g-buyer')).toBe(false);
    await insertTask(env.DB, { ...base, id: 'task-mine', title: 'Mine', assignedTo: 't-staff', timestamp: ts });
    await insertTask(env.DB, { ...base, id: 'task-other', title: 'Other', priority: 'urgent', timestamp: ts });

    const brokerView = (await listTasks(env.DB, { status: '', assignedTo: '', brokerOnly: 1, staffId: 't-staff' })) as Array<{ id: string }>;
    expect(brokerView.map((t) => t.id)).toEqual(['task-mine']);
    const adminView = (await listTasks(env.DB, { status: '', assignedTo: '', brokerOnly: 0, staffId: 'x' })) as Array<{ id: string }>;
    const ids = adminView.map((t) => t.id);
    expect(ids.includes('task-mine') && ids.includes('task-other')).toBe(true);
    expect(adminView[0]!.id).toBe('task-other'); // urgent sorts first

    expect(await findTaskFor(env.DB, 'task-other', 1, 't-staff')).toBeNull();
    expect((await findTaskFor(env.DB, 'task-mine', 1, 't-staff'))?.status).toBe('open');

    await updateTask(env.DB, 'task-mine', { status: 'done' }, '2026-05-01T00:00:00.000Z');
    let row = await env.DB.prepare("SELECT title, status, completed_at AS c FROM staff_tasks WHERE id='task-mine'").first<{ title: string; status: string; c: string | null }>();
    expect(row).toMatchObject({ title: 'Mine', status: 'done', c: '2026-05-01T00:00:00.000Z' });
    await updateTask(env.DB, 'task-mine', { status: 'open', title: 'Renamed' }, '2026-05-02T00:00:00.000Z');
    row = await env.DB.prepare("SELECT title, status, completed_at AS c FROM staff_tasks WHERE id='task-mine'").first<{ title: string; status: string; c: string | null }>();
    expect(row).toMatchObject({ title: 'Renamed', status: 'open', c: null });
  });
});

describe('sessions repo', () => {
  const future = '2099-01-01T00:00:00.000Z';
  async function user(id: string, type: 'staff' | 'buyer', role: string) {
    await env.DB.prepare(
      "INSERT INTO users (id, email, display_name, role, user_type, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)",
    ).bind(id, `${id}@example.com`, id, role, type, ts, ts).run();
  }
  async function session(id: string, userId: string, type: string, hash: string) {
    await env.DB.prepare(
      'INSERT INTO sessions (id, user_id, token_hash, created_at, last_seen_at, expires_at, session_type) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).bind(id, userId, hash, ts, ts, future, type).run();
  }
  it('lists, flags the current staff session and revokes exactly once', async () => {
    await user('s-staff', 'staff', 'admin');
    await session('11111111-1111-1111-1111-111111111111', 's-staff', 'staff', 'hash-a');
    await session('22222222-2222-2222-2222-222222222222', 's-staff', 'staff', 'hash-b');
    const rows = await listActiveStaffSessions(env.DB, 'hash-a', '2026-06-01T00:00:00.000Z');
    const mine = rows.filter((r) => r['userId'] === 's-staff');
    expect(mine).toHaveLength(2);
    expect(mine.find((r) => r['id'] === '11111111-1111-1111-1111-111111111111')?.['isCurrent']).toBe(1);
    expect(mine.find((r) => r['id'] === '22222222-2222-2222-2222-222222222222')?.['isCurrent']).toBe(0);
    const target = await findActiveStaffSession(env.DB, '22222222-2222-2222-2222-222222222222');
    expect(target?.tokenHash).toBe('hash-b');
    expect(await revokeStaffSession(env.DB, target!.id, '2026-06-02T00:00:00.000Z')).toBe(true);
    expect(await revokeStaffSession(env.DB, target!.id, '2026-06-03T00:00:00.000Z')).toBe(false);
    expect(await findActiveStaffSession(env.DB, target!.id)).toBeNull();
  });
  it('keeps staff and buyer sessions separate', async () => {
    await user('s-buyer', 'buyer', 'buyer');
    await session('33333333-3333-3333-3333-333333333333', 's-buyer', 'buyer', 'hash-c');
    expect(await findActiveStaffSession(env.DB, '33333333-3333-3333-3333-333333333333')).toBeNull();
    expect(await revokeStaffSession(env.DB, '33333333-3333-3333-3333-333333333333', ts)).toBe(false);
    const listed = await listActiveBuyerSessions(env.DB, '2026-06-01T00:00:00.000Z');
    expect(listed.some((r) => r['id'] === '33333333-3333-3333-3333-333333333333')).toBe(true);
    expect((await findActiveBuyerSession(env.DB, '33333333-3333-3333-3333-333333333333'))?.email).toBe('s-buyer@example.com');
    expect(await revokeBuyerSession(env.DB, '33333333-3333-3333-3333-333333333333', ts)).toBe(true);
    expect(await revokeBuyerSession(env.DB, '33333333-3333-3333-3333-333333333333', ts)).toBe(false);
  });
});

describe('pages repo', () => {
  const page = { slug: 'repo-page', title: 'T', description: 'd', bodyMarkdown: '# hi', status: 'draft', seoTitle: '', seoDescription: '' };
  it('upserts by id, changes status, rejects duplicate slugs and deletes', async () => {
    await env.DB.prepare(
      "INSERT INTO users (id, email, display_name, role, user_type, status, created_at, updated_at) VALUES ('p-staff', 'p-staff@example.com', 'P', 'editor', 'staff', 'active', ?, ?)",
    ).bind(ts, ts).run();
    await upsertPage(env.DB, 'page-1', page, 'p-staff', ts);
    await upsertPage(env.DB, 'page-1', { ...page, title: 'Changed' }, 'p-staff', '2026-05-01T00:00:00.000Z');
    expect(await findPageSlugById(env.DB, 'page-1')).toBe('repo-page');
    const listed = await listPages(env.DB);
    expect(listed.filter((p) => p.slug === 'repo-page')).toHaveLength(1);
    expect(listed.find((p) => p.slug === 'repo-page')?.['title']).toBe('Changed');
    await setPageStatus(env.DB, 'page-1', 'published', 'p-staff', '2026-05-02T00:00:00.000Z');
    expect(listed.length).toBeGreaterThan(0);
    let threw = false;
    try {
      await upsertPage(env.DB, 'page-2', page, 'p-staff', ts);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(await findPage(env.DB, 'missing')).toBeNull();
    await deletePage(env.DB, 'page-1');
    expect(await findPage(env.DB, 'page-1')).toBeNull();
  });
});

describe('forms repo', () => {
  it('upserts a form and filters, searches and updates submissions', async () => {
    await env.DB.prepare(
      "INSERT INTO users (id, email, display_name, role, user_type, status, created_at, updated_at) VALUES ('f-staff', 'f-staff@example.com', 'F', 'editor', 'staff', 'active', ?, ?)",
    ).bind(ts, ts).run();
    const form = { slug: 'repo-form', title: 'Repo form', description: '', fieldsJson: '[]', notificationEnabled: true, status: 'published' };
    await upsertForm(env.DB, 'form-1', form, 'f-staff', ts);
    await upsertForm(env.DB, 'form-1', { ...form, title: 'Renamed' }, 'f-staff', ts);
    const forms = await listForms(env.DB);
    expect(forms.filter((f) => f['slug'] === 'repo-form')).toHaveLength(1);
    expect(forms.find((f) => f['slug'] === 'repo-form')?.['title']).toBe('Renamed');

    for (const [id, text] of [['sub-1', 'alpha 100% sure'], ['sub-2', 'beta']] as const)
      await env.DB.prepare(
        "INSERT INTO managed_form_submissions (id, form_id, data_json, created_at) VALUES (?, 'form-1', ?, ?)",
      ).bind(id, JSON.stringify({ message: text }), ts).run();

    const none: [string, string, string, string, string, string] = ['', '', '', '', '', '%%'];
    expect((await querySubmissions(env.DB, none, 200)).length).toBeGreaterThanOrEqual(2);
    // Search treats % as a literal character, not a wildcard.
    const literal = await querySubmissions(env.DB, ['', '', '', '', '100%', '%100\\%%'], 200);
    expect(literal.map((r) => r['id'])).toEqual(['sub-1']);
    const bySlug = await querySubmissions(env.DB, ['', '', 'repo-form', 'repo-form', '', '%%'], 200);
    expect(bySlug).toHaveLength(2);

    expect((await findSubmission(env.DB, 'sub-2'))?.status).toBe('new');
    await updateSubmission(env.DB, 'sub-2', { status: 'closed' }, '2026-05-01T00:00:00.000Z');
    await updateSubmission(env.DB, 'sub-2', { internalNote: 'called back' }, '2026-05-02T00:00:00.000Z');
    const row = await env.DB.prepare("SELECT status, internal_note AS n, updated_at AS u FROM managed_form_submissions WHERE id='sub-2'").first<{ status: string; n: string; u: string }>();
    expect(row).toMatchObject({ status: 'closed', n: 'called back', u: '2026-05-02T00:00:00.000Z' });
  });
});
