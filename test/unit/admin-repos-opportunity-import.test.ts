import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  applyImport, findOpportunityRow, IMPORTABLE_COLUMNS, nextVersionNumber, slugInUseByOther, type StagedImport,
} from '../../src/admin/repos/opportunity-import-repo';

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

const ts = '2026-05-01T10:00:00.000Z';
const n = async (sql: string, ...a: string[]) => (await env.DB.prepare(sql).bind(...a).first<{ n: number }>())!.n;
const item = (oppId: string, k: string, over: Partial<StagedImport> = {}): StagedImport => ({
  id: oppId, values: { title: `Imported ${k}`, country: 'Malta' }, slug: `imported-${k}`, snapshotJson: '{}',
  version: 1, updatedAt: ts, versionId: `ver-${k}`, auditId: `aud-${k}`, ...over,
});

describe('opportunity import repo', () => {
  it('runs its steps in order', async () => {
    await step('reads rows, next version number and slug collisions', async () => {
      await env.DB.prepare(
        "INSERT INTO users (id, email, display_name, role, user_type, status, created_at, updated_at) VALUES ('imp-staff', 'imp@example.com', 'I', 'admin', 'staff', 'active', ?, ?)",
      ).bind(ts, ts).run();
      const rows = (await env.DB.prepare('SELECT id, slug FROM opportunities ORDER BY id LIMIT 2').all<{ id: string; slug: string }>()).results!;
      const [a, b] = rows as [{ id: string; slug: string }, { id: string; slug: string }];
      expect((await findOpportunityRow(env.DB, a.id))?.['slug']).toBe(a.slug);
      expect(await findOpportunityRow(env.DB, 'missing')).toBeNull();
      expect(await nextVersionNumber(env.DB, a.id)).toBeGreaterThanOrEqual(1);
      expect(await slugInUseByOther(env.DB, b.slug, a.id)).toBe(true);
      expect(await slugInUseByOther(env.DB, a.slug, a.id)).toBe(false);
      expect(await slugInUseByOther(env.DB, 'no-such-slug', a.id)).toBe(false);
    });

    await step('import updates, versions and audits each record and forces it back to private draft', async () => {
      const [a, b] = (await env.DB.prepare('SELECT id FROM opportunities ORDER BY id LIMIT 2').all<{ id: string }>()).results! as [{ id: string }, { id: string }];
      await env.DB.prepare("UPDATE opportunities SET public_visibility = 1, content_review_status = 'approved', lifecycle = 'published' WHERE id IN (?, ?)").bind(a.id, b.id).run();
      const v = await nextVersionNumber(env.DB, a.id);
      await applyImport(env.DB, [item(a.id, 'a', { version: v }), item(b.id, 'b', { version: await nextVersionNumber(env.DB, b.id) })], { staffId: 'imp-staff', requestId: 'rq' });
      for (const [oid, k] of [[a.id, 'a'], [b.id, 'b']] as const) {
        const row = await env.DB.prepare('SELECT title, slug, country, lifecycle, content_review_status AS s, public_visibility AS pv FROM opportunities WHERE id = ?').bind(oid).first<Record<string, unknown>>();
        expect(row).toMatchObject({ title: `Imported ${k}`, slug: `imported-${k}`, country: 'Malta', lifecycle: 'draft', s: 'pending', pv: 0 });
        expect(await n('SELECT COUNT(*) AS n FROM opportunity_versions WHERE id = ?', `ver-${k}`)).toBe(1);
        expect(await n("SELECT COUNT(*) AS n FROM audit_logs WHERE id = ? AND action = 'opportunity.imported'", `aud-${k}`)).toBe(1);
      }
    });

    await step('is all-or-nothing: a failing record rolls back every earlier record in the file', async () => {
      const [a, b] = (await env.DB.prepare('SELECT id FROM opportunities ORDER BY id DESC LIMIT 2').all<{ id: string }>()).results! as [{ id: string }, { id: string }];
      const before = await env.DB.prepare('SELECT title FROM opportunities WHERE id = ?').bind(a.id).first<{ title: string }>();
      await expect(
        applyImport(env.DB, [item(a.id, 'c', { version: 900 }), item(b.id, 'd', { version: 900, auditId: 'aud-c' })], { staffId: 'imp-staff', requestId: 'rq' }),
      ).rejects.toThrow(); // duplicate audit id in the second record
      const after = await env.DB.prepare('SELECT title FROM opportunities WHERE id = ?').bind(a.id).first<{ title: string }>();
      expect(after!.title).toBe(before!.title);
      expect(await n("SELECT COUNT(*) AS n FROM opportunity_versions WHERE id = 'ver-c'")).toBe(0);
    });

    await step('refuses a column that is not on the importable list (no SQL built from CSV headers)', async () => {
      const a = (await env.DB.prepare('SELECT id FROM opportunities LIMIT 1').first<{ id: string }>())!;
      await expect(
        applyImport(env.DB, [item(a.id, 'e', { values: { 'title = title, public_visibility': 1 } })], { staffId: 'imp-staff', requestId: 'rq' }),
      ).rejects.toThrow(/not importable/);
      expect(IMPORTABLE_COLUMNS).not.toContain('public_visibility');
      expect(IMPORTABLE_COLUMNS).not.toContain('lifecycle');
      expect(IMPORTABLE_COLUMNS).not.toContain('slug');
    });
  });
});
