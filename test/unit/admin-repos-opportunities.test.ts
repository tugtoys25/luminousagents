import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  activeBrokerExists, deleteOpportunityRow, EDIT_COLUMNS, findForDelete, hasLinkedRecords, insertOpportunity,
  slugExists, updateOpportunity, type NewOpportunity,
} from '../../src/admin/repos/opportunities-repo';

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

const ts = '2026-07-01T10:00:00.000Z';
const row = (id: string) =>
  env.DB.prepare('SELECT * FROM opportunities WHERE id = ?').bind(id).first<Record<string, unknown>>();
const fresh = (id: string, over: Partial<NewOpportunity> = {}): NewOpportunity => ({
  id, slug: `slug-${id}`, title: `Title ${id}`, country: 'Malta', opportunityType: 'casino', classification: 'public',
  labels: ['a', 'b'], priceText: 'EUR 1', priceVisibility: true, summary: 's', bodyHtml: '<p>b</p>', availability: 'now',
  seoTitle: 't', seoDescription: 'd', assignedBrokerId: null, timestamp: ts, ...over,
});

describe('opportunities repo', () => {
  it('runs its steps in order', async () => {
    await step('brokers must be active staff with the broker role', async () => {
      const mk = (id: string, role: string, type: string, status: string) =>
        env.DB.prepare('INSERT INTO users (id, email, display_name, role, user_type, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(id, `${id}@example.com`, id, role, type, status, ts, ts).run();
      await mk('br-ok', 'broker', 'staff', 'active');
      await mk('br-off', 'broker', 'staff', 'suspended');
      await mk('br-admin', 'admin', 'staff', 'active');
      expect(await activeBrokerExists(env.DB, 'br-ok')).toBe(true);
      expect(await activeBrokerExists(env.DB, 'br-off')).toBe(false);
      expect(await activeBrokerExists(env.DB, 'br-admin')).toBe(false);
      expect(await activeBrokerExists(env.DB, 'nobody')).toBe(false);
    });

    await step('inserts every new opportunity as a private draft pending review, even if marked public/visible', async () => {
      expect(await slugExists(env.DB, 'slug-n1')).toBe(false);
      await insertOpportunity(env.DB, fresh('n1', { assignedBrokerId: 'br-ok' }));
      expect(await slugExists(env.DB, 'slug-n1')).toBe(true);
      expect(await row('n1')).toMatchObject({
        lifecycle: 'draft', content_review_status: 'pending', public_visibility: 0, price_visibility: 1,
        labels_json: '["a","b"]', assigned_broker_id: 'br-ok', created_at: ts, updated_at: ts,
      });
    });

    await step('rejects a duplicate slug at the database level', async () => {
      await expect(insertOpportunity(env.DB, fresh('n2', { slug: 'slug-n1' }))).rejects.toThrow();
    });

    await step('an edit changes only the named fields and sends a live listing back to private review', async () => {
      await env.DB.prepare("UPDATE opportunities SET lifecycle='published', content_review_status='approved', public_visibility=1 WHERE id='n1'").run();
      await updateOpportunity(env.DB, 'n1', { summary: 'new', labels: ['x'], priceVisibility: false }, null, '2026-07-02T00:00:00.000Z');
      expect(await row('n1')).toMatchObject({
        summary: 'new', labels_json: '["x"]', price_visibility: 0, title: 'Title n1', slug: 'slug-n1',
        content_review_status: 'pending', public_visibility: 0, updated_at: '2026-07-02T00:00:00.000Z',
        lifecycle: 'published', // lifecycle itself is untouched; only review/visibility reset
      });
    });

    await step('a slug is only written when one is supplied; null broker can be set', async () => {
      await updateOpportunity(env.DB, 'n1', { title: 'Renamed', assignedBrokerId: null }, 'renamed', ts);
      expect(await row('n1')).toMatchObject({ title: 'Renamed', slug: 'renamed', assigned_broker_id: null });
    });

    await step('refuses fields outside the edit whitelist (no SQL built from unknown keys)', async () => {
      await expect(updateOpportunity(env.DB, 'n1', { 'title = 1, public_visibility': 1 }, null, ts)).rejects.toThrow(/not editable/);
      await expect(updateOpportunity(env.DB, 'n1', { publicVisibility: true }, null, ts)).rejects.toThrow(/not editable/);
      expect(Object.values(EDIT_COLUMNS)).not.toContain('public_visibility');
      expect(Object.values(EDIT_COLUMNS)).not.toContain('lifecycle');
      expect(Object.values(EDIT_COLUMNS)).not.toContain('slug');
    });

    await step('delete is blocked while NDA requests, documents, grants or forms reference the listing', async () => {
      await insertOpportunity(env.DB, fresh('n3'));
      expect(await findForDelete(env.DB, 'n3')).toMatchObject({ id: 'n3', title: 'Title n3' });
      expect(await findForDelete(env.DB, 'nope')).toBeNull();
      expect(await hasLinkedRecords(env.DB, 'n3')).toBe(false);
      await env.DB.prepare(
        "INSERT INTO documents (id, opportunity_id, r2_key, filename, content_type, byte_size, created_at) VALUES ('opd-1', 'n3', 'opk/1', 'f.pdf', 'application/pdf', 1, ?)",
      ).bind(ts).run();
      expect(await hasLinkedRecords(env.DB, 'n3')).toBe(true);
      await env.DB.prepare("DELETE FROM documents WHERE id = 'opd-1'").run();
      expect(await hasLinkedRecords(env.DB, 'n3')).toBe(false);
      await deleteOpportunityRow(env.DB, 'n3');
      expect(await findForDelete(env.DB, 'n3')).toBeNull();
    });
  });
});
