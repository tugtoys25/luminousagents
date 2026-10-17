import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  findForVerify, findOpportunityFull, findOpportunityScoped, findRef, findVersionSnapshot, findWorkflowRow,
  insertVersion, isVisibleToStaff, listVersions, loadStage, nextVersion, RESTORABLE_COLUMNS, restoreContent,
  setPublication, setReview, slugTakenByOther, stampVerified, workflow,
} from '../../src/admin/repos/opportunity-lifecycle-repo';

const ts = '2026-06-01T10:00:00.000Z';
const ts2 = '2026-06-02T10:00:00.000Z';
type R = Record<string, unknown>;
const state = (id: string) =>
  env.DB.prepare('SELECT lifecycle, content_review_status AS review, public_visibility AS vis, classification, published_at AS pub, last_verified_at AS ver, updated_at AS upd FROM opportunities WHERE id = ?').bind(id).first<R>();
async function ids(): Promise<[string, string]> {
  const r = (await env.DB.prepare('SELECT id FROM opportunities ORDER BY id LIMIT 2').all<{ id: string }>()).results!;
  return [r[0]!.id, r[1]!.id];
}
async function reset(id: string, over = '') {
  await env.DB.prepare(`UPDATE opportunities SET lifecycle='draft', content_review_status='pending', public_visibility=0, published_at=NULL, last_verified_at=NULL ${over} WHERE id=?`).bind(id).run();
}

describe('opportunity lifecycle repo: reads and versions', () => {
  it('scopes brokers to assigned listings', async () => {
    const [a] = await ids();
    expect(await isVisibleToStaff(env.DB, a, false, 'x')).toBe(true);
    expect(await isVisibleToStaff(env.DB, a, true, 'nobody')).toBe(false);
    expect(await findOpportunityScoped(env.DB, a, true, 'nobody')).toBeNull();
    expect((await findOpportunityScoped(env.DB, a, false, 'x'))?.['id']).toBe(a);
    expect(await findOpportunityFull(env.DB, 'missing')).toBeNull();
    expect((await findRef(env.DB, a))?.id).toBe(a);
    expect((await findForVerify(env.DB, a))?.id).toBe(a);
    expect((await findWorkflowRow(env.DB, a))?.id).toBe(a);
  });

  it('versions are numbered, listed newest first and retrievable', async () => {
    await env.DB.prepare(
      "INSERT INTO users (id, email, display_name, role, user_type, status, created_at, updated_at) VALUES ('lc-staff', 'lc@example.com', 'L', 'admin', 'staff', 'active', ?, ?)",
    ).bind(ts, ts).run();
    const [, b] = await ids();
    const first = await nextVersion(env.DB, b);
    for (const n of [first, first + 1]) {
      await insertVersion(env.DB, { id: `lcv-${n}`, opportunityId: b, versionNumber: n, snapshotJson: JSON.stringify({ n }), changedBy: 'lc-staff', reason: 'r', timestamp: ts });
    }
    expect(await nextVersion(env.DB, b)).toBe(first + 2);
    const list = await listVersions(env.DB, b);
    expect(Number(list[0]!['versionNumber'])).toBeGreaterThan(Number(list[1]!['versionNumber']));
    expect(await findVersionSnapshot(env.DB, b, first)).toBe(JSON.stringify({ n: first }));
    expect(await findVersionSnapshot(env.DB, b, 99999)).toBeNull();
  });

  it('restore writes content only and forces a private pending draft; slug collisions are detectable', async () => {
    const [a, b] = await ids();
    await env.DB.prepare("UPDATE opportunities SET lifecycle='published', content_review_status='approved', public_visibility=1 WHERE id=?").bind(a).run();
    const other = (await env.DB.prepare('SELECT slug FROM opportunities WHERE id = ?').bind(b).first<{ slug: string }>())!.slug;
    expect(await slugTakenByOther(env.DB, other, a)).toBe(true);
    const values = RESTORABLE_COLUMNS.map((k) => (k === 'price_visibility' ? 0 : k === 'labels_json' ? '[]' : k === 'classification' ? 'confidential' : k === 'opportunity_type' ? 'casino' : `v-${k}`));
    await restoreContent(env.DB, { opportunityId: a, values, slug: 'restored-slug-x', timestamp: ts });
    expect(await state(a)).toMatchObject({ lifecycle: 'draft', review: 'pending', vis: 0 });
    const row = await findOpportunityFull(env.DB, a);
    expect(row).toMatchObject({ title: 'v-title', slug: 'restored-slug-x' });
    expect(RESTORABLE_COLUMNS).not.toContain('public_visibility');
    expect(RESTORABLE_COLUMNS).not.toContain('lifecycle');
  });
});

describe('opportunity lifecycle repo: transitions', () => {
  it('verify stamps only last_verified_at', async () => {
    const [a] = await ids();
    await reset(a);
    await stampVerified(env.DB, a, ts);
    expect(await state(a)).toMatchObject({ ver: ts, upd: ts, lifecycle: 'draft', vis: 0 });
  });

  it('publication sets published_at once and never clears it', async () => {
    const [a] = await ids();
    await reset(a);
    await setPublication(env.DB, { opportunityId: a, lifecycle: 'published', publicVisibility: true, timestamp: ts });
    expect(await state(a)).toMatchObject({ lifecycle: 'published', vis: 1, pub: ts });
    await setPublication(env.DB, { opportunityId: a, lifecycle: 'published', publicVisibility: true, timestamp: ts2 });
    expect((await state(a))?.['pub']).toBe(ts);
    await setPublication(env.DB, { opportunityId: a, lifecycle: 'on_hold', publicVisibility: false, timestamp: ts2 });
    expect(await state(a)).toMatchObject({ lifecycle: 'on_hold', vis: 0, pub: ts });
  });

  it('workflow transitions each do exactly what the route expects', async () => {
    const [a] = await ids();
    await reset(a, ", classification='confidential'");
    await workflow.submit(env.DB, a, ts);
    expect(await state(a)).toMatchObject({ lifecycle: 'in_review', vis: 0 });
    await workflow.approve(env.DB, a, ts);
    expect(await state(a)).toMatchObject({ review: 'approved', ver: ts, vis: 0 });
    expect((await loadStage(env.DB, a))?.['stage']).toBe('ready');
    await workflow.publish(env.DB, a, ts2);
    expect(await state(a)).toMatchObject({ lifecycle: 'published', vis: 1, classification: 'public', pub: ts2, ver: ts });
    expect((await loadStage(env.DB, a))?.['stage']).toBe('live');
    await workflow.unpublish(env.DB, a, ts2);
    expect(await state(a)).toMatchObject({ lifecycle: 'in_review', vis: 0 });
    await workflow.unapprove(env.DB, a, 'in_review', ts2);
    expect(await state(a)).toMatchObject({ review: 'pending', vis: 0 });
    await workflow.archive(env.DB, a, ts2);
    expect(await state(a)).toMatchObject({ lifecycle: 'archived', vis: 0 });
    expect((await loadStage(env.DB, a))?.['stage']).toBe('closed');
    await workflow.restore(env.DB, a, 'draft', ts2);
    expect(await state(a)).toMatchObject({ lifecycle: 'draft', vis: 0 });
  });

  it('unpublish leaves a non-published lifecycle alone', async () => {
    const [a] = await ids();
    await reset(a, ", lifecycle='on_hold'");
    await workflow.unpublish(env.DB, a, ts);
    expect((await state(a))?.['lifecycle']).toBe('on_hold');
  });

  it('review decision always returns to private; only approval stamps verification', async () => {
    const [a] = await ids();
    await reset(a);
    await env.DB.prepare('UPDATE opportunities SET public_visibility = 1 WHERE id = ?').bind(a).run();
    await setReview(env.DB, { opportunityId: a, decision: 'approved', verifiedAt: ts, timestamp: ts });
    expect(await state(a)).toMatchObject({ review: 'approved', vis: 0, ver: ts });
    await setReview(env.DB, { opportunityId: a, decision: 'rejected', verifiedAt: ts2, timestamp: ts2 });
    expect(await state(a)).toMatchObject({ review: 'rejected', vis: 0, ver: ts });
  });
});
