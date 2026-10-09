import { describe, expect, it } from 'vitest';
import {
  serializeOpportunity,
  type OpportunityRow,
} from '../../src/domain/opportunities/serialize';

const row: OpportunityRow = {
  id: 'op-1',
  slug: 'sample-opportunity',
  title: 'Sample Opportunity',
  country: 'United Kingdom',
  opportunity_type: 'casino-hotel',
  price_text: '£10 million',
  lifecycle: 'published',
  summary: 'A sample summary.',
  availability: '',
  points_json: '["First point", 3, "Second point"]',
  seo_title: '',
  seo_description: '',
  published_at: '2026-10-09T00:00:00.000Z',
};

describe('serializeOpportunity', () => {
  it('returns only the explicit public projection and parses safe highlight strings', () => {
    const result = serializeOpportunity(row, 1);
    expect(result).toEqual({
      slug: 'sample-opportunity',
      title: 'Sample Opportunity',
      country: 'United Kingdom',
      type: 'casino-hotel',
      price: '£10 million',
      summary: 'A sample summary.',
      availability: null,
      points: ['First point', 'Second point'],
      seoTitle: 'Sample Opportunity',
      seoDescription: 'A sample summary.',
    });
    expect(result).not.toHaveProperty('id');
    expect(result).not.toHaveProperty('body_html');
    expect(result).not.toHaveProperty('legacy_status');
  });

  it('fails closed when legacy points JSON is malformed', () => {
    expect(serializeOpportunity({ ...row, points_json: '{invalid' }).points).toEqual([]);
  });
});
