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

describe('seller gap closure (static checks)', () => {
  it('closing or declining requires step-up, and assignment notifies through the outbox', () => {
    const src = read('src/admin/routes/seller-enquiries.ts');
    expect(src).toContain("stepUpResponse(c, '/dashboard/seller-enquiries/ui')");
    expect(src).toContain('seller_assignment:');
    expect(read('src/seller/staff-repo.ts')).toContain('INSERT OR IGNORE INTO notification_jobs');
  });
  it('seller routes are covered by the denial audit', () => {
    const routes = read('src/admin/routes.ts');
    for (const p of ["'/sellers/*'", "'/seller-enquiries/*'", "'/authority/*'", "'/seller-material-notices/*'", "'/seller-retention/*'"]) expect(routes, p).toContain(p);
    expect(read('src/seller/denial-audit.ts')).toContain('routePattern(c.req.path)');
  });
  it('seller erasure carries every precondition in the single update that gates all redactions', () => {
    const repo = read('src/seller/privacy-repo.ts');
    const body = repo.slice(repo.indexOf('export async function anonymiseSeller'));
    for (const needle of ["status = 'INACTIVE'", "relationship_status = 'ACTIVE'", 'legal_hold = 0', "e.legal_hold = 1", "i.stage IN ('RECORDED','UNDER_REVIEW','APPROVED')", 'public_visibility = 1']) expect(body, needle).toContain(needle);
    expect(read('src/admin/routes/seller-privacy.ts')).toMatch(/\/sellers\/:ref\/anonymise', requireRole\(\.\.\.sellerRetentionRoles\), requireRecentMfa/);
  });
  it('additional contacts are never used as notice recipients', () => {
    expect(read('src/admin/routes/seller-interest.ts')).not.toMatch(/seller_contacts|listSellerContacts/);
    expect(read('src/seller/jobs.ts')).not.toMatch(/seller_contacts|listSellerContacts/);
  });
  it('the e2e suite never targets production and ships a seller spec', () => {
    expect(read('e2e/tests/seller-workflow.spec.ts')).toContain('/sell-a-casino');
  });
});

describe('seller compliance, settings and evidence (static checks)', () => {
  it('evidence routes are role-guarded, and download, delete and verification need recent MFA', () => {
    const src = read('src/admin/routes/seller-evidence.ts');
    expect(src.match(/requireRole\(/g)?.length).toBe(src.match(/admin\.(get|post)\(/g)?.length);
    expect(src).toMatch(/\/download', requireRole\(\.\.\.sellerEvidenceDownloadRoles\), requireRecentMfa/);
    expect(src).toMatch(/\/delete', requireRole\(\.\.\.sellerEvidenceDeleteRoles\), requireRecentMfa/);
    expect(src).not.toMatch(/\.prepare\(/);
  });
  it('downloads fail closed: the access log is written before any bytes are read', () => {
    const src = read('src/admin/routes/seller-evidence.ts');
    expect(src.indexOf('logDownload(')).toBeGreaterThan(-1);
    expect(src.indexOf('logDownload(')).toBeLessThan(src.indexOf('PRIVATE_FILES.get('));
    expect(src).toContain("scanStatus !== 'clean'");
    expect(src).toContain("'X-Content-Type-Options': 'nosniff'");
    expect(src).toContain("'Cache-Control': 'private, no-store'");
  });
  it('verification requires real evidence, and no code builds a public or pre-signed evidence URL', () => {
    expect(read('src/admin/routes/seller-authority.ts')).toContain('usableEvidenceCount(');
    for (const f of ['src/admin/routes/seller-evidence.ts', 'src/seller/evidence-repo.ts', 'src/seller/evidence-files.ts']) expect(read(f), f).not.toMatch(/createSignedUrl|presign|public.*r2\.dev|https?:\/\//i);
  });
  it('editable policy is stored outside platform_settings, validated, audited, and sensitive keys need a super admin plus MFA', () => {
    const route = read('src/admin/routes/seller-settings.ts');
    expect(route).toContain("def.sensitive");
    expect(route).toContain("staff.role !== 'super_admin'");
    expect(route).toContain('stepUpResponse(');
    expect(read('src/seller/policy-repo.ts')).toContain('seller_policy_settings');
    expect(read('src/seller/policy-repo.ts')).not.toContain('platform_settings');
    expect(read('src/seller/policy-repo.ts')).toContain('seller_policy.changed');
  });
  it('seller code no longer reads the editable settings straight from the environment', () => {
    for (const f of ['src/admin/routes/seller-authority.ts', 'src/admin/routes/seller-publication.ts', 'src/admin/routes/seller-messages.ts', 'src/admin/routes/seller-interest.ts', 'src/admin/routes/seller-privacy.ts', 'src/seller/jobs.ts', 'src/seller/routes.ts', 'src/web/pages/public-sell.tsx'])
      expect(read(f), f).not.toMatch(/env\.SELLER_(SEPARATION|MATERIAL|RETENTION|MARKETING|ALERT_RECIPIENTS|ESCALATION_RECIPIENTS)/);
  });
  it('compliance is a staff role with MFA required by default, and cannot reach publication or sending', () => {
    expect(read('src/permissions/permissions.ts')).toContain("'compliance'] as const");
    expect(read('src/auth/mfa.ts')).toContain("'compliance'");
    expect(read('src/admin/shared.ts')).toMatch(/sellerWorkRoles = \['admin', 'broker', 'super_admin'\]/);
  });
  it('evidence and policy migrations are additive and the evidence log is append-only', () => {
    expect(read('migrations/0042_seller_authority_evidence.sql')).not.toMatch(/\bDROP\s+(TABLE|COLUMN)|\bDELETE\s+FROM/i);
    expect(read('migrations/0043_seller_evidence_triggers.sql')).toContain('trg_evidence_log_no_update');
    expect(read('migrations/0041_seller_policy_settings.sql')).not.toMatch(/platform_settings\s*\(/);
  });
});
