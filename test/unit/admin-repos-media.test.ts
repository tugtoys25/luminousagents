import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  deleteMedia, findMedia, findMediaFile, findMediaForDelete, findPathReferences, insertMedia, listMedia,
  slugTaken, updateMedia,
} from '../../src/admin/repos/media-repo';

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

const ts = '2026-03-01T10:00:00.000Z';
const m = (id: string, over: Partial<Parameters<typeof insertMedia>[1]> = {}) => ({
  id, r2Key: `media/${id}.png`, filename: `${id}.png`, contentType: 'image/png', byteSize: 5,
  sha256: `sha-${id}`, visibility: 'public', uploadedBy: 'm-staff', timestamp: ts, ...over,
});
const none = { q: '', kind: 'all', visibility: '', limit: 60 };

describe('media repo', () => {
  it('runs its steps in order', async () => {
    await step('inserts, lists with filters and escapes LIKE wildcards in search', async () => {
      await env.DB.prepare(
        "INSERT INTO users (id, email, display_name, role, user_type, status, created_at, updated_at) VALUES ('m-staff', 'm@example.com', 'M', 'admin', 'staff', 'active', ?, ?)",
      ).bind(ts, ts).run();
      await insertMedia(env.DB, m('m1', { filename: 'logo_100%.png' }));
      await insertMedia(env.DB, m('m2', { filename: 'plan.pdf', contentType: 'application/pdf', visibility: 'private', r2Key: 'media/m2.pdf' }));
      expect((await listMedia(env.DB, none)).length).toBe(2);
      expect((await listMedia(env.DB, { ...none, kind: 'image' })).map((r) => r['id'])).toEqual(['m1']);
      expect((await listMedia(env.DB, { ...none, kind: 'document' })).map((r) => r['id'])).toEqual(['m2']);
      expect((await listMedia(env.DB, { ...none, visibility: 'private' })).map((r) => r['id'])).toEqual(['m2']);
      expect((await listMedia(env.DB, { ...none, visibility: 'bogus' })).length).toBe(2); // unknown values are ignored
      expect((await listMedia(env.DB, { ...none, q: '100%' })).map((r) => r['id'])).toEqual(['m1']);
      expect((await listMedia(env.DB, { ...none, q: '%' })).map((r) => r['id'])).toEqual(['m1']); // % is literal, not "match all"
      expect((await listMedia(env.DB, { ...none, limit: 1 })).length).toBe(1);
    });

    await step('applies partial updates, clears with empty string and enforces slug uniqueness', async () => {
      expect(await updateMedia(env.DB, 'm1', {}, ts)).toBe(false);
      expect(await updateMedia(env.DB, 'm1', { altText: 'Logo', publicSlug: 'brand-logo' }, '2026-05-01T00:00:00.000Z')).toBe(true);
      expect((await findMedia(env.DB, 'm1'))?.publicSlug).toBe('brand-logo');
      expect(await slugTaken(env.DB, 'brand-logo', 'm2')).toBe(true);
      expect(await slugTaken(env.DB, 'brand-logo', 'm1')).toBe(false);
      expect(await slugTaken(env.DB, 'm1', 'm2')).toBe(true); // an id counts as a taken slug
      await updateMedia(env.DB, 'm1', { publicSlug: '' }, '2026-05-02T00:00:00.000Z');
      expect((await findMedia(env.DB, 'm1'))?.publicSlug).toBeNull();
      const row = await env.DB.prepare("SELECT alt_text AS a, updated_at AS u FROM media_assets WHERE id='m1'").first<{ a: string; u: string }>();
      expect(row).toMatchObject({ a: 'Logo', u: '2026-05-02T00:00:00.000Z' });
    });

    await step('finds references in managed content and then deletes', async () => {
      await env.DB.prepare(
        "INSERT INTO platform_settings (setting_key, value_json, updated_by, updated_at) VALUES ('hero', ?, 'm-staff', ?)",
      ).bind(JSON.stringify('/media/m1'), ts).run();
      const refs = await findPathReferences(env.DB, '/media/m1');
      expect(refs.settings).toEqual(['hero']);
      expect(refs.pages).toEqual([]);
      expect((await findPathReferences(env.DB, '/media/nothing-here')).settings).toEqual([]);
  
      expect((await findMediaFile(env.DB, 'm2'))?.r2Key).toBe('media/m2.pdf');
      expect((await findMediaForDelete(env.DB, 'm2'))?.filename).toBe('plan.pdf');
      await deleteMedia(env.DB, 'm2');
      expect(await findMedia(env.DB, 'm2')).toBeNull();
    });
  });
});
