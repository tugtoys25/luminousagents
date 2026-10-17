import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  applyReviewDecision, exportOpportunityRows, findOpportunityRef, listOpportunities, loadReconciliation,
  reviewQueueRows,
} from '../../src/admin/repos/opportunity-queue-repo';

const filter = { q: '', review: '', stage: '', brokerOnly: 0 as 0 | 1, staffId: 'x', pageSize: 25, page: 1 };

describe('opportunity queue repo', () => {
  it('lists the imported records with stage counts that add up', async () => {
    const { rows, stageCounts } = await listOpportunities(env.DB, filter);
    expect(rows.length).toBe(25);
    const total = stageCounts.reduce((sum, r) => sum + r.n, 0);
    expect(total).toBe(198);
    const page2 = await listOpportunities(env.DB, { ...filter, page: 2 });
    expect(page2.rows[0]!['id']).not.toBe(rows[0]!['id']);
  });

  it('filters by review status, stage and text, and scopes brokers to assigned records', async () => {
    const pending = await listOpportunities(env.DB, { ...filter, review: 'pending', pageSize: 100 });
    expect(pending.rows.every((r) => r['reviewStatus'] === 'pending')).toBe(true);
    const draft = await listOpportunities(env.DB, { ...filter, stage: 'draft', pageSize: 100 });
    expect(draft.rows.every((r) => r['stage'] === 'draft')).toBe(true);
    const text = await listOpportunities(env.DB, { ...filter, q: 'London', pageSize: 100 });
    expect(text.rows.length).toBeGreaterThan(0);
    const broker = await listOpportunities(env.DB, { ...filter, brokerOnly: 1, staffId: 'nobody' });
    expect(broker.rows.length).toBe(0);
  });

  it('builds the review queue (bounded, pending first) and applies decisions privately', async () => {
    const queue = await reviewQueueRows(env.DB, { brokerOnly: 0, staffId: 'x', staleBeforeIso: '2000-01-01T00:00:00.000Z' });
    expect(queue.length).toBeGreaterThan(0);
    expect(queue.length).toBeLessThanOrEqual(250);
    expect(queue[0]!.reviewStatus).toBe('pending');
    expect((await reviewQueueRows(env.DB, { brokerOnly: 1, staffId: 'nobody', staleBeforeIso: '2000-01-01T00:00:00.000Z' })).length).toBe(0);

    const target = queue[0]!;
    const ref = await findOpportunityRef(env.DB, target.id);
    expect(ref?.slug).toBeTruthy();
    expect(await findOpportunityRef(env.DB, 'missing')).toBeNull();
    // Force it public, then approve: the decision must force it private again and stamp verification.
    await env.DB.prepare('UPDATE opportunities SET public_visibility = 1 WHERE id = ?').bind(target.id).run();
    await applyReviewDecision(env.DB, target.id, 'approved', '2026-06-01T00:00:00.000Z');
    let row = await env.DB.prepare('SELECT content_review_status AS s, public_visibility AS v, last_verified_at AS l FROM opportunities WHERE id = ?').bind(target.id).first<{ s: string; v: number; l: string }>();
    expect(row).toMatchObject({ s: 'approved', v: 0, l: '2026-06-01T00:00:00.000Z' });
    // Rejection must not touch last_verified_at.
    await applyReviewDecision(env.DB, target.id, 'rejected', '2026-07-01T00:00:00.000Z');
    row = await env.DB.prepare('SELECT content_review_status AS s, public_visibility AS v, last_verified_at AS l FROM opportunities WHERE id = ?').bind(target.id).first<{ s: string; v: number; l: string }>();
    expect(row).toMatchObject({ s: 'rejected', v: 0, l: '2026-06-01T00:00:00.000Z' });
  });

  it('exports every record with the expected columns and reports reconciliation', async () => {
    const rows = await exportOpportunityRows(env.DB);
    expect(rows.length).toBe(198);
    expect(Object.keys(rows[0]!)).toContain('price_visibility');
    const rec = await loadReconciliation(env.DB);
    expect(Number(rec.counts['total'])).toBe(198);
    expect(rec.duplicateLegacyIds).toBe(0);
    expect(rec.duplicateSlugs).toBe(0);
    expect(Object.keys(rec.groups).length).toBeGreaterThan(0);
  });
});
