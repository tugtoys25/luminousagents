import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { containsMoneyLike } from '../../src/domain/opportunities/redaction';
import { serializeOpportunity, type OpportunityRow } from '../../src/domain/opportunities/serialize';

describe('Sprint 32 public output over the real seed', () => {
  it('shows an anonymous visitor no price and no money amount for any of the 198 legacy listings', async () => {
    const result = await env.DB.prepare('SELECT * FROM opportunities').all<OpportunityRow>();
    const rows = result.results ?? [];
    expect(rows.length).toBe(198);
    const offenders: string[] = [];
    for (const row of rows) {
      const out = serializeOpportunity(row, 0);
      if (out.price) offenders.push(`${row.slug}: price field`);
      const fields = [out.title, out.summary, out.availability ?? '', out.seoTitle, out.seoDescription, out.coverMediaAlt, ...out.points, ...out.labels];
      if (fields.some((value) => containsMoneyLike(value))) offenders.push(`${row.slug}: money-like text`);
    }
    expect(offenders).toEqual([]);
  });
});

describe('Sprint 32 rendered public pages', () => {
  it('does not leak a confidential price or other amounts through HTML, directory, search or sitemap', async () => {
    // Letters only, so a random id can never contain one of the secret digit strings by chance.
    const id = 'fixture-sprint-redaction';
    const slug = 'sprint-redaction-fixture';
    await env.DB.prepare('DELETE FROM opportunities WHERE id=?').bind(id).run();
    const timestamp = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO opportunities (id,slug,title,country,opportunity_type,classification,price_text,price_visibility,lifecycle,content_review_status,summary,points_json,public_visibility,last_verified_at,published_at,created_at,updated_at)
       VALUES (?,?,?,?,?,'public',?,0,'published','approved',?,?,1,?,?,?,?)`,
    )
      .bind(
        id,
        slug,
        'Sprint 32 redaction fixture',
        'Malta',
        'casino',
        '$987m',
        'Asking $987,654,321 with turnover of £4,321,000 and rent of 76543 euros.',
        JSON.stringify(['Price: 987654321', 'Debt of 8,765,432 Eur']),
        timestamp,
        timestamp,
        timestamp,
        timestamp,
      )
      .run();
    try {
      const pages = [`/opportunities/${slug}`, '/', '/casinos-for-sale', '/casinos-for-sale/malta', '/sitemap.xml'];
      for (const path of pages) {
        const response = await SELF.fetch(`https://mayfair.test${path}`);
        const body = await response.text();
        expect(response.status, path).toBeLessThan(500);
        for (const secret of ['987,654,321', '987654321', '$987m', '4,321,000', '4321000', '76543', '8,765,432']) {
          expect(body, `${path} must not contain ${secret}`).not.toContain(secret);
        }
      }
      const detail = await SELF.fetch(`https://mayfair.test/opportunities/${slug}`);
      expect(detail.status).toBe(200);
      const searched = await SELF.fetch('https://mayfair.test/casinos-for-sale?q=987654321');
      expect(await searched.text()).not.toContain(slug);
    } finally {
      await env.DB.prepare('DELETE FROM opportunities WHERE id=?').bind(id).run();
    }
  });
});
