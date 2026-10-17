import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  archivedListings, casinoHotelListings, findPageOverride, findPublicListing, findPublicListingImage,
  latestListings, listingsByCountry, loadSitemapData, OPPORTUNITY_CARD_SELECT, PUBLIC_FILTER, searchCatalogue,
} from '../../src/web/public-listings-repo';

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

const ts = '2026-10-01T10:00:00.000Z';
const base = { country: '', type: '', query: '', sort: 'newest' as const, page: 1 };
async function make(id: string, over: Record<string, unknown> = {}) {
  const v = { slug: `pl-${id}`, title: `Listing ${id}`, country: 'Malta', opportunity_type: 'casino', classification: 'public', lifecycle: 'published', content_review_status: 'approved', public_visibility: 1, price_text: '', price_visibility: 0, summary: '', ...over };
  await env.DB.prepare(
    'INSERT INTO opportunities (id, slug, title, country, opportunity_type, classification, lifecycle, content_review_status, public_visibility, price_text, price_visibility, summary, published_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
  ).bind(id, v.slug, v.title, v.country, v.opportunity_type, v.classification, v.lifecycle, v.content_review_status, v.public_visibility, v.price_text, v.price_visibility, v.summary, ts, ts, ts).run();
}
const slugs = (rows: Array<{ slug: string }>) => rows.map((r) => r.slug);

describe('public listings repo', () => {
  it('runs its steps in order', async () => {
    await step('public listings repo > never returns a listing unless published, approved, visible AND public', async () => {
      await env.DB.prepare('DELETE FROM opportunities').run();
      await make('ok1');
      await make('draft', { lifecycle: 'draft' });
      await make('pending', { content_review_status: 'pending' });
      await make('hidden', { public_visibility: 0 });
      await make('conf', { classification: 'confidential' });
      const cat = await searchCatalogue(env.DB, base);
      expect(slugs(cat.rows)).toEqual(['pl-ok1']);
      expect(cat.total).toBe(1);
      expect(slugs(await latestListings(env.DB, 3))).toEqual(['pl-ok1']);
      expect(await findPublicListing(env.DB, 'pl-ok1')).toMatchObject({ id: 'ok1' });
      for (const s of ['pl-draft', 'pl-pending', 'pl-hidden', 'pl-conf', 'nope']) expect(await findPublicListing(env.DB, s)).toBeNull();
      expect(PUBLIC_FILTER).toContain("classification = 'public'");
      expect(OPPORTUNITY_CARD_SELECT).toContain('cover_media_id');
    });

    await step('public listings repo > filters by country (exact), type (whitelisted), and ignores unknown types', async () => {
      await make('mt', { country: 'Malta', opportunity_type: 'casino' });
      await make('uk', { country: 'UK', opportunity_type: 'hotel', slug: 'pl-uk' });
      expect(slugs((await searchCatalogue(env.DB, { ...base, country: 'UK' })).rows)).toEqual(['pl-uk']);
      expect(slugs((await searchCatalogue(env.DB, { ...base, type: 'hotel' })).rows)).toEqual(['pl-uk']);
      expect((await searchCatalogue(env.DB, { ...base, type: 'bogus' })).total).toBeGreaterThanOrEqual(3);
      expect(slugs(await listingsByCountry(env.DB, 'uk'))).toEqual(['pl-uk']); // case-insensitive
      const countries = (await searchCatalogue(env.DB, base)).countries.map((c) => c.country);
      expect(countries).toEqual([...countries].sort());
      expect(countries).toContain('UK');
    });

    await step('public listings repo > price-oriented searches cannot reveal a hidden price (confidential price text)', async () => {
      await make('secret', { slug: 'pl-secret', title: 'Quiet Resort', price_text: 'EUR 12,500,000', price_visibility: 0 });
      await make('shown', { slug: 'pl-shown', title: 'Open Resort', price_text: 'EUR 9,000,000', price_visibility: 1, summary: 'asking 9 million' });
      // Searching the hidden price must not find the hidden-price listing...
      expect(slugs((await searchCatalogue(env.DB, { ...base, query: '12,500,000' })).rows)).toEqual([]);
      // ...and a title match that is price-flavoured (digit) still excludes hidden-price rows that match raw text.
      await make('digits', { slug: 'pl-digits', title: 'Hotel 5 Stars', price_text: '', price_visibility: 0 });
      expect(slugs((await searchCatalogue(env.DB, { ...base, query: '5 Stars' })).rows)).toEqual([]);
      // Ordinary words still search normally.
      expect(slugs((await searchCatalogue(env.DB, { ...base, query: 'Quiet' })).rows)).toEqual(['pl-secret']);
      // A visible price is searchable.
      expect(slugs((await searchCatalogue(env.DB, { ...base, query: 'asking 9' })).rows)).toEqual(['pl-shown']);
    });

    await step('public listings repo > treats search text as data, never as SQL, and escapes nothing into the query', async () => {
      const r = await searchCatalogue(env.DB, { ...base, query: "x%' OR 1=1 --" });
      expect(r.rows).toEqual([]);
      expect((await searchCatalogue(env.DB, { ...base, country: "UK' OR '1'='1" })).rows).toEqual([]);
    });

    await step('public listings repo > pages in fixed steps and orders', async () => {
      for (let i = 0; i < 14; i++) await make(`pg${String(i).padStart(2, '0')}`, { title: `Z page ${String(i).padStart(2, '0')}` });
      const p1 = await searchCatalogue(env.DB, { ...base, sort: 'title' });
      const p2 = await searchCatalogue(env.DB, { ...base, sort: 'title', page: 2 });
      expect(p1.rows.length).toBe(12);
      expect(p2.rows.length).toBe(p1.total - 12);
      const t1 = p1.rows.map((r) => r.title);
      expect([...t1].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))).toEqual(t1);
      const byCountry = await searchCatalogue(env.DB, { ...base, sort: 'country' });
      const cs = byCountry.rows.map((r) => String(r.country).toLowerCase());
      expect([...cs].sort()).toEqual(cs);
    });

    await step('public listings repo > casino-hotel and archive lists apply their own rules and still require approval + visibility', async () => {
      await make('ch1', { slug: 'pl-ch1', opportunity_type: 'casino-hotel' });
      await make('ch2', { slug: 'pl-ch2', opportunity_type: 'casino-hotel', public_visibility: 0 });
      await make('ar1', { slug: 'pl-ar1', lifecycle: 'sold' });
      await make('ar2', { slug: 'pl-ar2', lifecycle: 'off_market', content_review_status: 'pending' });
      await make('ar3', { slug: 'pl-ar3', lifecycle: 'sold', classification: 'confidential' });
      expect(slugs(await casinoHotelListings(env.DB))).toEqual(['pl-ch1']);
      expect(slugs(await archivedListings(env.DB))).toEqual(['pl-ar1']);
      expect(await findPublicListing(env.DB, 'pl-ar1')).toBeNull(); // archived items are not live detail pages
    });

    await step('public listings repo > listing images are served only for publicly listed opportunities and only JPEG/PNG', async () => {
      const m = (id: string, opp: string, type: string) =>
        env.DB.prepare("INSERT INTO opportunity_media (id, opportunity_id, r2_key, alt_text, sort_order, created_at, content_type, byte_size, sha256) VALUES (?, ?, ?, 'a', 0, ?, ?, 5, 'h')").bind(id, opp, `img/${id}`, ts, type).run();
      await m('im1', 'ok1', 'image/png'); await m('im2', 'ok1', 'image/webp'); await m('im3', 'hidden', 'image/png'); await m('im4', 'ch2', 'image/jpeg');
      await make('hidden', { slug: 'pl-hidden2', public_visibility: 0 }).catch(() => {});
      expect(await findPublicListingImage(env.DB, 'im1', 'ok1')).toMatchObject({ r2Key: 'img/im1', contentType: 'image/png' });
      expect(await findPublicListingImage(env.DB, 'im2', 'ok1')).toBeNull(); // webp not served publicly
      expect(await findPublicListingImage(env.DB, 'im4', 'ch2')).toBeNull(); // not visible
      expect(await findPublicListingImage(env.DB, 'im1', 'someone-else')).toBeNull(); // id must match listing
    });

    await step('public listings repo > page overrides: published only; sitemap data covers live listings, countries, pages and archive', async () => {
      await env.DB.prepare("INSERT INTO managed_pages (id, slug, title, body_markdown, status, created_at, updated_at) VALUES ('pov1','about','T','b','published',?,?),('pov2','faq','T','b','draft',?,?)").bind(ts, ts, ts, ts).run();
      expect((await findPageOverride(env.DB, 'about'))?.title).toBe('T');
      expect(await findPageOverride(env.DB, 'faq')).toBeNull();
      const sm = await loadSitemapData(env.DB);
      expect(sm.listings.map((l) => l.slug)).not.toContain('pl-draft');
      expect(sm.listings.map((l) => l.slug)).toContain('pl-ok1');
      expect(sm.countries.map((c) => c.country)).toContain('Malta');
      expect(sm.pages.map((p) => p.slug)).toEqual(['about']);
      expect(sm.archivedUpdatedAt).toBe(ts);
    });
  });
});
