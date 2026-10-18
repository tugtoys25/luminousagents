import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

describe('seller migrations and public surface (static checks)', () => {
  const m32 = read('migrations/0032_seller_enquiries.sql');
  it('enforces a unique public reference, idempotency hash and explicit status constraint', () => {
    expect(m32).toMatch(/reference TEXT NOT NULL UNIQUE/);
    expect(m32).toMatch(/idempotency_hash TEXT NOT NULL UNIQUE/);
    expect(m32).toMatch(/status IN \('NEW','ASSIGNED','CONTACT_ATTEMPTED','AWAITING_SELLER','QUALIFICATION','AUTHORITY_REVIEW','QUALIFIED','CONVERTED','DECLINED','CLOSED'\)/);
  });
  it('is forward-only: no DROP or DELETE', () => {
    expect(m32).not.toMatch(/\bDROP\s+(TABLE|COLUMN)|\bDELETE\s+FROM/i);
  });
  it('makes audit_logs append-only', () => {
    const m33 = read('migrations/0033_audit_append_only.sql');
    expect(m33).toMatch(/BEFORE UPDATE ON audit_logs/);
    expect(m33).toMatch(/BEFORE DELETE ON audit_logs/);
  });
  it('seller route has no direct SQL and the submit path is Turnstile protected', () => {
    expect(read('src/seller/routes.ts')).not.toMatch(/\.prepare\(/);
    expect(read('src/security/turnstile.ts')).toContain("'/api/sell-a-casino'");
  });
  it('public page offers no file upload and links the real privacy route', () => {
    const page = read('src/web/pages/public-sell.tsx');
    expect(page).not.toMatch(/type="file"/);
    expect(page).toContain('href="/legal/privacy"');
  });
  it('seller code never logs request bodies', () => {
    expect(read('src/seller/routes.ts')).not.toMatch(/console\.\w+\([^)]*(body|parsed|raw)\b/);
  });
});

describe('seller staff workflow (static checks)', () => {
  it('seller history tables are append-only', () => {
    const m = read('migrations/0035_seller_history_append_only.sql');
    for (const table of ['seller_enquiry_notes', 'seller_communications', 'seller_enquiry_status_history', 'seller_enquiry_qualifications']) {
      expect(m).toContain(`BEFORE UPDATE ON ${table}`);
      expect(m).toContain(`BEFORE DELETE ON ${table}`);
    }
  });
  it('every seller staff route is role-guarded and every mutating handler loads the enquiry through the scoped loader', () => {
    for (const file of ['src/admin/routes/seller-enquiries.ts', 'src/admin/routes/seller-enquiry-actions.ts']) {
      const src = read(file);
      const routes = src.match(/admin\.(get|post)\(/g) ?? [];
      expect(src.match(/requireRole\(/g)?.length).toBe(routes.length);
    }
    const actions = read('src/admin/routes/seller-enquiry-actions.ts');
    expect(actions.match(/loadEnquiry\(c\)/g)?.length).toBe(5);
  });
  it('staff UI renders data with textContent, never innerHTML', () => {
    expect(read('public/static/js/dashboard-seller-enquiries.js')).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write|eval\(/);
  });
  it('detail responses strip the internal id, idempotency hash and IP hash', () => {
    const repo = read('src/seller/staff-repo.ts');
    expect(repo).not.toMatch(/idempotency_hash AS|source_ip_hash AS|original_submission_json AS/);
    expect(read('src/admin/routes/seller-enquiries.ts')).toContain('const { id: enquiryId, ...data }');
  });
  it('closure and assignment are manager-only', () => {
    const shared = read('src/admin/shared.ts');
    expect(shared).toMatch(/sellerAssignRoles = \['admin', 'super_admin'\]/);
  });
});
