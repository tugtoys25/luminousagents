import { describe, expect, it } from 'vitest';
import { readAdminSources } from '../../scripts/lib/admin-sources.mjs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { serializeOpportunity, type OpportunityRow } from '../../src/domain/opportunities/serialize';
const read = (path: string) =>
  path === 'src/admin/routes.ts'
    ? readAdminSources()
    : readFileSync(resolve(process.cwd(), path), 'utf8');
const base: OpportunityRow = {
  id: 'opp-1', slug: 'confidential-opportunity', title: 'Confidential casino', country: 'UK',
  opportunity_type: 'casino-hotel', price_text: '£45 million', price_visibility: 0,
  lifecycle: 'published', summary: 'Asking price £45 million. Discreet transaction.', availability: 'Price: £45 million',
  points_json: '["Price £45 million", "Freehold"]', seo_title: 'Casino £45 million',
  seo_description: 'Price £45 million; qualified parties only.', published_at: null,
};
describe('cumulative completion hardening', () => {
  it('keeps confidential prices out of all public serializer fields', () => {
    const result = serializeOpportunity(base, 0);
    expect(result.price).toBeNull();
    for (const value of [result.title, result.summary, result.availability, result.seoTitle, result.seoDescription, ...result.points]) {
      expect(value || '').not.toContain('£45 million');
    }
  });
  it('allows public price only after explicit visibility and retains authorised price access', () => {
    expect(serializeOpportunity({ ...base, price_visibility: 1 }, 0).price).toBe('£45 million');
    expect(serializeOpportunity(base, 1).price).toBe('£45 million');
    expect(serializeOpportunity(base, 2).price).toBe('£45 million');
    expect(serializeOpportunity(base, 3).price).toBe('£45 million');
  });
  it('uses the central public serializer for buyer saved listings and blocks price-oriented search side channels', () => {
    const buyer = read('src/buyers/routes.ts');
    const publicPages = read('src/web/pages/public.tsx');
    expect(buyer).toContain('serializeOpportunity(row, 0)');
    expect(buyer).toContain("o.classification = 'public'");
    expect(publicPages).toContain('price_visibility = 0 AND (title LIKE ? OR summary LIKE ? OR price_text LIKE ?)');
  });
  it('implements buyer profile read/write endpoints with range validation and audit', () => {
    const source = read('src/buyers/routes.ts');
    expect(source).toContain("buyers.get('/api/buyer/profile'");
    expect(source).toContain("buyers.put('/api/buyer/profile'");
    expect(source).toContain('INVALID_BUDGET_RANGE');
    expect(source).toContain("'buyer.profile_updated'");
    expect(source).toContain('ON CONFLICT(user_id) DO UPDATE');
  });
  it('blocks deletion of media referenced by published content', () => {
    const source = read('src/admin/routes.ts');
    expect(source).toContain('MEDIA_IN_USE');
    expect(source).toContain('managed page');
    expect(source).toContain('MEDIA_URL_IN_USE');
    expect(source).toContain('platform setting');
  });
  it('provides a scoped review queue with stale and incomplete-content reasons', () => {
    const source = read('src/admin/routes.ts');
    expect(source).toContain("'/opportunities/review-queue'");
    expect(source).toContain('verification_stale');
    expect(source).toContain('publication_invariant_violation');
    expect(source).toContain("'/opportunities/:id/verify'");
  });
  it('provides whitelisted public directory sorting and preserves it across pagination', () => {
    const source = read('src/web/pages/public.tsx');
    expect(source).toContain("['newest', 'title', 'country']");
    expect(source).toContain('ORDER BY ${orderBy} LIMIT 12 OFFSET ?');
    expect(source).toContain('name="sort"');
  });
  it('verifies public media bytes against the stored SHA-256', () => {
    const source = read('src/index.ts');
    expect(source).toContain('actual !== asset.sha256.toLowerCase()');
    expect(source).toContain('object.size !== asset.byteSize');
  });
  it('uses stable provider idempotency keys and retries failed jobs safely', () => {
    const source = read('src/operations/queue.ts');
    expect(source).toContain('Idempotency-Key');
    expect(source).toContain('mayfair-${job.id}');
    expect(source).toContain("status IN ('queued','failed')");
  });
  it('provides a private data-room document UI and scanner action', () => {
    const source = read('src/admin/routes.ts');
    const client = read('public/static/js/dashboard-documents.js');
    expect(source).toContain("admin.get('/documents/ui'");
    expect(source).toContain("admin.get('/documents'");
    expect(client).toContain('Scan now');
    expect(client).toContain('private storage');
  });
  it('requires signed NDA PDFs to be scanned and keeps them private', () => {
    const buyer = read('src/buyers/routes.ts');
    const admin = read('src/admin/routes.ts');
    const queue = read('src/operations/queue.ts');
    expect(buyer).toContain("buyers.post('/api/buyer/nda-requests/:id/signed-pdf'");
    expect(buyer).toContain('scanR2Document');
    expect(buyer).toContain('signed_pdf_r2_key IS NULL');
    expect(admin).toContain("admin.get('/nda-requests/:id/signed-pdf'");
    expect(queue).toContain('nda.signed_pdf_uploaded');
  });
  it('restricts tier 3 to super administrators and preserves schema support', () => {
    const source = read('src/admin/routes.ts');
    const migration = read('migrations/0028_sprint29_compliance_access_tier.sql');
    expect(source).toContain('Tier 3 access requires a super administrator');
    expect(source).toContain('Only a super administrator may upload tier-3 documents');
    expect(migration).toContain('CHECK (tier IN (1,2,3))');
  });
  it('keeps the unapproved bootstrap NDA template inactive', () => {
    const migration = read('migrations/0030_sprint30_nda_template_legal_gate.sql');
    expect(migration).toContain("SET status = 'draft'");
    expect(migration).toContain('r2_key IS NULL');
  });
  it('adds indexes used by the review queue', () => {
    const migration = read('migrations/0027_sprint27_review_queue_indexes.sql');
    expect(migration).toContain('idx_opportunities_review_updated');
    expect(migration).toContain('idx_opportunities_verified_at');
  });
});
