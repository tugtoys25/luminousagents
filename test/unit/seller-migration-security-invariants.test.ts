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

describe('seller phase 3 (static checks)', () => {
  it('publication gate trigger and append-only triggers exist', () => {
    const m = read('migrations/0037_seller_publication_gate_triggers.sql');
    expect(m).toContain('trg_opportunities_seller_publication_gate');
    for (const t of ['seller_changes', 'seller_authority_events', 'seller_publication_events']) {
      expect(m).toContain(`BEFORE UPDATE ON ${t}`);
      expect(m).toContain(`BEFORE DELETE ON ${t}`);
    }
    expect(read('migrations/0036_sellers_authority_publication.sql')).not.toMatch(/\bDROP\s+(TABLE|COLUMN)|\bDELETE\s+FROM/i);
  });
  it('both existing publication endpoints call the seller gate before going live', () => {
    const src = read('src/admin/routes/opportunity-lifecycle.ts');
    expect(src.match(/sellerGateResult\(/g)?.length).toBe(2);
    expect(src).toContain('SELLER_GATES_NOT_MET');
  });
  it('every phase 3 staff route is role-guarded', () => {
    for (const file of ['sellers', 'seller-links', 'seller-authority', 'seller-publication']) {
      const src = read(`src/admin/routes/${file}.ts`);
      expect(src.match(/requireRole\(/g)?.length, file).toBe(src.match(/admin\.(get|post)\(/g)?.length);
    }
  });
  it('seller routes and helpers contain no direct SQL', () => {
    for (const file of ['src/admin/routes/sellers.ts', 'src/admin/routes/seller-links.ts', 'src/admin/routes/seller-authority.ts', 'src/admin/routes/seller-publication.ts', 'src/seller/authority-expiry.ts', 'src/seller/gate-check.ts'])
      expect(read(file), file).not.toMatch(/\.prepare\(/);
  });
  it('the new staff UI renders with textContent only', () => {
    expect(read('public/static/js/dashboard-sellers.js')).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write|eval\(/);
  });
  it('conversion never copies enquiry text into public opportunity fields', () => {
    const repo = read('src/seller/publication-repo.ts');
    const insert = repo.slice(repo.indexOf('INSERT INTO opportunities'), repo.indexOf('INSERT INTO opportunity_versions'));
    expect(insert).not.toMatch(/asset_description|asset_name|additional_information|asking_price/);
    expect(insert).toContain("'confidential'");
    expect(insert).toContain("'draft'");
  });
});

describe('seller phase 4 (static checks)', () => {
  it('every phase 4 staff route is role-guarded', () => {
    for (const file of ['seller-messages', 'seller-interest', 'seller-privacy']) {
      const src = read(`src/admin/routes/${file}.ts`);
      expect(src.match(/requireRole\(/g)?.length, file).toBe(src.match(/admin\.(get|post)\(/g)?.length);
    }
  });
  it('material-interest sending, anonymisation, export and authority verification require recent MFA', () => {
    expect(read('src/admin/routes/seller-messages.ts')).toMatch(/seller-material-notices\/:messageId\/send', requireRole\(\.\.\.sellerInterestApproveRoles\), requireRecentMfa/);
    const privacy = read('src/admin/routes/seller-privacy.ts');
    expect(privacy).toMatch(/\/anonymise', requireRole\(\.\.\.sellerRetentionRoles\), requireRecentMfa/);
    expect(privacy).toMatch(/\/export', requireRole\(\.\.\.sellerExportRoles\), requireRecentMfa/);
    expect(read('src/admin/routes/seller-authority.ts')).toMatch(/\/authority\/:ref\/transition', requireRole\(\.\.\.authorityReviewRoles\), requireRecentMfa/);
  });
  it('the dispatcher re-checks eligibility, content hash and revocation before any send', () => {
    const jobs = read('src/seller/jobs.ts');
    for (const needle of ['contentHash(', 'interestStage !== \'APPROVED\'', 'currentInterestVersion', 'm.entitled', 'claimForSend', 'cancelIneligible']) expect(jobs, needle).toContain(needle);
    expect(jobs.indexOf('cancelIneligible')).toBeLessThan(jobs.indexOf('await send(env, m.recipient'));
  });
  it('seller emails to sellers are only created from approved messages (no template call in the send path)', () => {
    expect(read('src/seller/jobs.ts')).not.toMatch(/renderSellerMaterialInterest|renderSellerFollowup\b/);
  });
  it('phase 4 routes contain no direct SQL and the new UI uses no innerHTML', () => {
    for (const f of ['seller-messages', 'seller-interest', 'seller-privacy']) expect(read(`src/admin/routes/${f}.ts`), f).not.toMatch(/\.prepare\(/);
    for (const f of ['dashboard-seller-privacy.js', 'dashboard-sellers.js', 'dashboard-seller-enquiries.js']) expect(read(`public/static/js/${f}`), f).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write|eval\(/);
  });
  it('retention lists nothing unless the business has configured an approved period', () => {
    expect(read('src/admin/routes/seller-privacy.ts')).toContain('policyConfigured: false');
  });
  it('phase 4 triggers keep messages frozen and history redaction-only', () => {
    const m = read('migrations/0039_seller_phase4_triggers.sql');
    for (const t of ['trg_messages_content_frozen', 'trg_messages_no_delete', 'trg_messages_no_resurrect', 'trg_interest_events_no_update', 'trg_seller_notes_no_update']) expect(m).toContain(t);
    expect(read('migrations/0038_seller_messages_interest_privacy.sql')).not.toMatch(/\bDROP\s+(TABLE|COLUMN)|\bDELETE\s+FROM/i);
  });
});
