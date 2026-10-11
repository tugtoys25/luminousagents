import { describe, expect, it } from 'vitest';
import {
  AMOUNT_WITHHELD,
  containsMoneyLike,
  parseAmount,
  redactConfidentialText,
  redactMoneyAmounts,
} from '../../src/domain/opportunities/redaction';
import { serializeOpportunity, type OpportunityRow } from '../../src/domain/opportunities/serialize';

const base: OpportunityRow = {
  id: 'op-1',
  slug: 'fixture',
  title: 'Fixture casino',
  country: 'Malta',
  opportunity_type: 'casino',
  price_text: '$360m',
  price_visibility: 0,
  lifecycle: 'published',
  summary: 'Sale at $360,000,000 US with turnover of £5m and debt of 26.000.000 Eur.',
  availability: '',
  points_json: '["Asking price 500000", "75% funding, 330 rooms, 5-star"]',
  seo_title: '',
  seo_description: '',
  published_at: null,
};

describe('Sprint 32 money redaction', () => {
  it('redacts the stored asking price even when the text spells the same amount differently', () => {
    const out = redactConfidentialText('Now $360,000,000 US and also $360m.', '$360m');
    expect(out).not.toMatch(/360/);
  });

  it.each([
    ['£3,000 per month rent', 'rent'],
    ['26.000.000 Eur debt', 'debt'],
    ['turnover + $5 M', 'turnover'],
    ['valuation: 1.2bn', 'valuation'],
    ['priced at 12 million', 'priced'],
    ['250m euros', 'euros'],
    ['75000 Euros key money', 'key money'],
  ])('redacts %s', (text) => {
    const out = redactConfidentialText(text, '');
    expect(out).not.toMatch(/\d/);
    expect(containsMoneyLike(out)).toBe(false);
  });

  it.each([
    '5-star hotel with 330 rooms',
    '75% funding available',
    'VIP club over 600 2m to place 10 gaming tables',
    'the price of the 1 remaining hotel',
    'Price on Request',
    '20 slot machines and 20 gaming tables',
  ])('leaves non-money text unchanged: %s', (text) => {
    expect(redactConfidentialText(text, '')).toBe(text);
  });

  it('is idempotent', () => {
    const once = redactMoneyAmounts('Price $5m and £3,000');
    expect(redactMoneyAmounts(once)).toBe(once);
    expect(once).toContain(AMOUNT_WITHHELD);
  });

  it('parses amounts written in different formats to the same number', () => {
    expect(parseAmount('$360m')).toBe(360_000_000);
    expect(parseAmount('£450 Million')).toBe(450_000_000);
    expect(parseAmount('42,000,000 Pounds')).toBe(42_000_000);
    expect(parseAmount('$15.000.000')).toBe(15_000_000);
    expect(parseAmount('Price on Request')).toBeNull();
  });
});

describe('Sprint 32 serializer redaction', () => {
  it('hides the price and every amount from an anonymous viewer of a confidential listing', () => {
    const out = serializeOpportunity(base, 0);
    const everything = JSON.stringify(out);
    expect(out.price).toBeNull();
    expect(everything).not.toMatch(/360/);
    expect(everything).not.toMatch(/£5m|5m\b/);
    expect(everything).not.toMatch(/26\.000\.000/);
    expect(everything).not.toMatch(/500000/);
    expect(out.points[1]).toBe('75% funding, 330 rooms, 5-star');
  });

  it('still shows the price to a signed-in tier 1 viewer and when price visibility is public', () => {
    expect(serializeOpportunity(base, 1).price).toBe('$360m');
    expect(serializeOpportunity({ ...base, price_visibility: 1 }, 0).price).toBe('$360m');
    expect(serializeOpportunity({ ...base, price_visibility: 1 }, 0).summary).toContain('$360,000,000');
  });

  it('treats a missing price_visibility as confidential', () => {
    const withoutVisibility: OpportunityRow = { ...base };
    delete withoutVisibility.price_visibility;
    expect(serializeOpportunity(withoutVisibility, 0).price).toBeNull();
    expect(JSON.stringify(serializeOpportunity(withoutVisibility, 0))).not.toMatch(/360/);
  });
});
