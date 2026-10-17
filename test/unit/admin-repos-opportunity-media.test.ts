import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  attachImage, backfillAssetAltText, deleteImage, findMediaForDelete, findOpportunityForMedia,
  findPublicLibraryAsset, listOpportunityMedia, nextSortOrder,
} from '../../src/admin/repos/opportunity-media-repo';

const ts = '2026-04-01T10:00:00.000Z';
const base = (opp: string, n: number, over: Record<string, unknown> = {}) => ({
  mediaId: `om-${n}`, opportunityId: opp, r2Key: `opportunities/${opp}/media/om-${n}.png`, altText: `Image ${n}`,
  sortOrder: n, contentType: 'image/png', byteSize: 10, sha256: `sha${n}`, timestamp: ts, actorId: 'om-staff',
  requestId: 'req-1', reviewAuditId: `ra-${n}`, uploadAudit: { id: `ua-${n}`, detailsJson: '{}' }, ...over,
});
const count = async (sql: string, ...args: string[]) =>
  (await env.DB.prepare(sql).bind(...args).first<{ n: number }>())!.n;

async function seedOpp(): Promise<string> {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO users (id, email, display_name, role, user_type, status, created_at, updated_at) VALUES ('om-staff', 'om@example.com', 'OM', 'admin', 'staff', 'active', ?, ?)",
  ).bind(ts, ts).run();
  const row = await env.DB.prepare('SELECT id FROM opportunities LIMIT 1').first<{ id: string }>();
  return row!.id;
}

describe('opportunity media repo', () => {
  it('finds opportunities and computes the next sort order', async () => {
    const opp = await seedOpp();
    const found = await findOpportunityForMedia(env.DB, opp);
    expect(found?.id).toBe(opp);
    expect(await findOpportunityForMedia(env.DB, 'missing')).toBeNull();
    expect(await nextSortOrder(env.DB, opp)).toBe(0);
    await attachImage(env.DB, base(opp, 1, { sortOrder: 4 }));
    expect(await nextSortOrder(env.DB, opp)).toBe(5);
  });

  it('upload on a LIVE listing sends it back for review and audits it', async () => {
    const opp = await seedOpp();
    await env.DB.prepare("UPDATE opportunities SET public_visibility = 1, content_review_status = 'approved' WHERE id = ?").bind(opp).run();
    await attachImage(env.DB, base(opp, 2));
    const row = await env.DB.prepare('SELECT content_review_status AS s, public_visibility AS v FROM opportunities WHERE id = ?').bind(opp).first<{ s: string; v: number }>();
    expect(row).toMatchObject({ s: 'pending', v: 0 });
    expect(await count("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'opportunity.media_change_requires_review' AND entity_id = ?", opp)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'opportunity.media_uploaded' AND entity_id = 'om-2'")).toBe(1);
  });

  it('upload on a NON-live listing writes no review audit row (changes() guard)', async () => {
    const opp = await seedOpp();
    await env.DB.prepare('UPDATE opportunities SET public_visibility = 0 WHERE id = ?').bind(opp).run();
    const before = await count("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'opportunity.media_change_requires_review' AND entity_id = ?", opp);
    await attachImage(env.DB, base(opp, 3));
    expect(await count("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'opportunity.media_change_requires_review' AND entity_id = ?", opp)).toBe(before);
    expect(await count("SELECT COUNT(*) AS n FROM opportunity_media WHERE id = 'om-3'")).toBe(1);
  });

  it('library attach (no uploadAudit) still resets a live listing but adds no batch audit rows', async () => {
    const opp = await seedOpp();
    await env.DB.prepare("UPDATE opportunities SET public_visibility = 1, content_review_status = 'approved' WHERE id = ?").bind(opp).run();
    const before = await count('SELECT COUNT(*) AS n FROM audit_logs');
    await attachImage(env.DB, base(opp, 4, { uploadAudit: null }));
    expect(await count('SELECT COUNT(*) AS n FROM audit_logs')).toBe(before);
    const v = await env.DB.prepare('SELECT public_visibility AS v FROM opportunities WHERE id = ?').bind(opp).first<{ v: number }>();
    expect(v!.v).toBe(0);
  });

  it('rolls the whole batch back when the insert fails (duplicate r2 key)', async () => {
    const opp = await seedOpp();
    await attachImage(env.DB, base(opp, 5));
    await env.DB.prepare("UPDATE opportunities SET public_visibility = 1, content_review_status = 'approved' WHERE id = ?").bind(opp).run();
    await expect(attachImage(env.DB, base(opp, 6, { r2Key: base(opp, 5).r2Key }))).rejects.toThrow();
    const v = await env.DB.prepare('SELECT public_visibility AS v FROM opportunities WHERE id = ?').bind(opp).first<{ v: number }>();
    expect(v!.v).toBe(1); // the review reset was rolled back too
    expect(await count("SELECT COUNT(*) AS n FROM opportunity_media WHERE id = 'om-6'")).toBe(0);
  });

  it('lists in order and scopes brokers to their own listings', async () => {
    const opp = await seedOpp();
    const rows = await listOpportunityMedia(env.DB, opp, false, 'x');
    const orders = rows.map((r) => Number(r['sortOrder']));
    expect([...orders].sort((a, b) => a - b)).toEqual(orders);
    expect((await listOpportunityMedia(env.DB, opp, true, 'nobody')).length).toBe(0);
  });

  it('library asset lookup only returns PUBLIC assets, by id or slug; alt text backfills but never overwrites', async () => {
    const mk = (id: string, vis: string, slug: string | null, alt: string | null) =>
      env.DB.prepare(
        "INSERT INTO media_assets (id, r2_key, filename, content_type, byte_size, sha256, visibility, public_slug, alt_text, uploaded_by, created_at, updated_at) VALUES (?, ?, ?, 'image/png', 5, ?, ?, ?, ?, NULL, ?, ?)",
      ).bind(id, `media/${id}.png`, `${id}.png`, `h-${id}`, vis, slug, alt, ts, ts).run();
    await mk('ma-pub', 'public', 'pub-slug', '');
    await mk('ma-priv', 'private', 'priv-slug', '');
    expect((await findPublicLibraryAsset(env.DB, 'ma-pub'))?.id).toBe('ma-pub');
    expect((await findPublicLibraryAsset(env.DB, 'pub-slug'))?.id).toBe('ma-pub');
    expect(await findPublicLibraryAsset(env.DB, 'ma-priv')).toBeNull();
    expect(await findPublicLibraryAsset(env.DB, 'priv-slug')).toBeNull();
    await backfillAssetAltText(env.DB, 'ma-pub', 'First', ts);
    await backfillAssetAltText(env.DB, 'ma-pub', 'Second', ts);
    expect((await findPublicLibraryAsset(env.DB, 'ma-pub'))?.altText).toBe('First');
  });

  it('delete is atomic, resets a live listing, and is scoped to the opportunity', async () => {
    const opp = await seedOpp();
    await attachImage(env.DB, base(opp, 7));
    expect(await findMediaForDelete(env.DB, 'om-7', 'other-opp')).toBeNull();
    const media = await findMediaForDelete(env.DB, 'om-7', opp);
    expect(media?.r2Key).toBe(base(opp, 7).r2Key);
    await env.DB.prepare("UPDATE opportunities SET public_visibility = 1, content_review_status = 'approved' WHERE id = ?").bind(opp).run();
    await deleteImage(env.DB, { mediaId: 'om-7', opportunityId: opp, timestamp: ts, actorId: 'om-staff', requestId: 'r', reviewAuditId: 'dra-7', deleteAuditId: 'dda-7' });
    expect(await count("SELECT COUNT(*) AS n FROM opportunity_media WHERE id = 'om-7'")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM audit_logs WHERE id IN ('dra-7','dda-7')")).toBe(2);
    const v = await env.DB.prepare('SELECT public_visibility AS v FROM opportunities WHERE id = ?').bind(opp).first<{ v: number }>();
    expect(v!.v).toBe(0);
  });
});
