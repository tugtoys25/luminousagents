import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { listSettings, listSettingsByKeys, readSettingRaw } from '../../src/admin/repos/settings-repo';
import { findPublicMediaAsset } from '../../src/admin/repos/media-repo';

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

const ts = '2026-09-01T10:00:00.000Z';
const put = (k: string, v: string) =>
  env.DB.prepare('INSERT OR REPLACE INTO platform_settings (setting_key, value_json, updated_at) VALUES (?, ?, ?)').bind(k, v, ts).run();

describe('settings read helpers', () => {
  it('runs its steps in order', async () => {
    await step('settings read helpers > reads only the requested keys and returns raw JSON', async () => {
      await put('zz_a', JSON.stringify('A')); await put('zz_b', JSON.stringify('B')); await put('zz_c', '{not json');
      const got = await listSettingsByKeys(env.DB, ['zz_a', 'zz_c', 'zz_missing']);
      expect(got.map((r) => r.key).sort()).toEqual(['zz_a', 'zz_c']);
      expect(got.find((r) => r.key === 'zz_c')?.value).toBe('{not json'); // caller decides how to treat junk
      expect(await listSettingsByKeys(env.DB, [])).toEqual([]);
    });

    await step('settings read helpers > treats keys as data, never as SQL', async () => {
      const got = await listSettingsByKeys(env.DB, ["zz_a' OR '1'='1"]);
      expect(got).toEqual([]);
    });

    await step('settings read helpers > readSettingRaw returns the stored text or null', async () => {
      expect(await readSettingRaw(env.DB, 'zz_a')).toBe('"A"');
      expect(await readSettingRaw(env.DB, 'nope')).toBeNull();
    });

    await step('settings read helpers > listSettings returns every setting ordered by key', async () => {
      const keys = (await listSettings(env.DB)).map((r) => r.key);
      expect([...keys].sort()).toEqual(keys);
      expect(keys).toContain('zz_b');
    });

    await step('public media lookup > serves only PUBLIC assets, by id or slug', async () => {
      const mk = (id: string, vis: string, slug: string) =>
        env.DB.prepare("INSERT INTO media_assets (id, r2_key, filename, content_type, byte_size, sha256, visibility, public_slug, created_at, updated_at) VALUES (?, ?, ?, 'image/png', 5, ?, ?, ?, ?, ?)")
          .bind(id, `pm/${id}`, `${id}.png`, `h-${id}`, vis, slug, ts, ts).run();
      await mk('pm-pub', 'public', 'pm-pub-slug');
      await mk('pm-priv', 'private', 'pm-priv-slug');
      expect(await findPublicMediaAsset(env.DB, 'pm-pub')).toMatchObject({ r2Key: 'pm/pm-pub', sha256: 'h-pm-pub', filename: 'pm-pub.png' });
      expect((await findPublicMediaAsset(env.DB, 'pm-pub-slug'))?.r2Key).toBe('pm/pm-pub');
      expect(await findPublicMediaAsset(env.DB, 'pm-priv')).toBeNull();
      expect(await findPublicMediaAsset(env.DB, 'pm-priv-slug')).toBeNull();
      expect(await findPublicMediaAsset(env.DB, 'nope')).toBeNull();
    });
  });
});


