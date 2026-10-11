import { expect, test } from '@playwright/test';

// A money-like amount: a currency symbol or code followed by digits, or digits followed by a magnitude word.
const MONEY = /(?:[$£€]\s?\d|\b(?:USD|GBP|EUR)\s?\d|\d\s?(?:million|billion)\b|\d[\d,.]*\s?(?:euros?|dollars?|pounds?)\b)/i;
const PAGES = ['/', '/casinos-for-sale', '/casino-hotels', '/archive', '/sitemap.xml'];

test.describe('public pages never show a confidential price', () => {
  for (const path of PAGES) {
    test(`no money amount on ${path}`, async ({ request }) => {
      const response = await request.get(path);
      expect(response.status(), path).toBeLessThan(500);
      const body = await response.text();
      // Static site copy may mention fees or years; only listing copy must be free of amounts.
      const listingBlocks = body.match(/<article[\s\S]*?<\/article>/gi) ?? [];
      for (const block of listingBlocks) expect(block, `${path} listing card`).not.toMatch(MONEY);
    });
  }

  test('every listing detail page linked from the directory is free of money amounts and price markup', async ({ request }) => {
    const directory = await (await request.get('/casinos-for-sale')).text();
    const links = [...new Set([...directory.matchAll(/href="(\/opportunities\/[a-z0-9-]+)"/g)].map((m) => m[1]!))].slice(0, 25);
    test.skip(links.length === 0, 'No published listings on this environment; nothing to check.');
    for (const link of links) {
      const html = await (await request.get(link)).text();
      const main = html.match(/<main[\s\S]*?<\/main>/i)?.[0] ?? html;
      expect(main, link).not.toMatch(MONEY);
      for (const block of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
        expect(block[1], `${link} JSON-LD`).not.toMatch(/"(?:price|priceCurrency|offers)"/i);
      }
    }
  });

  test('searching for a price returns no confidential listing', async ({ request }) => {
    const body = await (await request.get('/casinos-for-sale?q=%24100m')).text();
    expect(body).not.toMatch(MONEY);
  });
});
