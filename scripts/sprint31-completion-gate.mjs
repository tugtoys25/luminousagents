import { readFileSync, existsSync, readdirSync } from 'node:fs';
const read = (path) => readFileSync(path, 'utf8');
const checks = [];
const pass = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), detail });
pass('signed NDA migration exists', existsSync('migrations/0029_sprint29_signed_nda_upload.sql'));
pass('unapproved bootstrap NDA is gated', existsSync('migrations/0030_sprint30_nda_template_legal_gate.sql') && /SET status = 'draft'/.test(read('migrations/0030_sprint30_nda_template_legal_gate.sql')));
pass('tier 3 migration exists', existsSync('migrations/0028_sprint29_compliance_access_tier.sql'));
pass('review queue migration exists', existsSync('migrations/0027_sprint27_review_queue_indexes.sql'));
pass('buyer profile API exists', /buyers\.put\('\/api\/buyer\/profile'/.test(read('src/buyers/routes.ts')));
pass('signed NDA upload requires scanner', /scanR2Document/.test(read('src/buyers/routes.ts')) && /signed_pdf_sha256/.test(read('src/buyers/routes.ts')));
pass('private document management UI exists', existsSync('public/static/js/dashboard-documents.js') && /\/documents\/ui/.test(read('src/admin/routes.ts')));
pass('media deletion checks references', /MEDIA_IN_USE/.test(read('src/admin/routes.ts')) && /MEDIA_URL_IN_USE/.test(read('src/admin/routes.ts')));
pass('public media verifies digest', /actual !== asset\.sha256/.test(read('src/index.ts')));
pass('public directory sorting uses whitelist', /\['newest', 'title', 'country'\]/.test(read('src/web/pages/public.tsx')));
pass('notification retries use provider idempotency key', /Idempotency-Key/.test(read('src/operations/queue.ts')) && /mayfair-\$\{job\.id\}/.test(read('src/operations/queue.ts')));
pass('release runbook exists', existsSync('docs/SPRINT_30_RELEASE_RUNBOOK.md'));
pass('new regression test exists', existsSync('test/unit/sprint31-completion-hardening.test.ts'));
const migrationNumbers = readdirSync('migrations')
  .filter((name) => /^\d+.*\.sql$/.test(name))
  .map((name) => Number.parseInt(name, 10))
  .sort((a, b) => a - b);
pass('numbered migrations are contiguous through 0030', migrationNumbers.length === 30 && migrationNumbers.every((number, index) => number === index + 1));
let failed = 0;
for (const check of checks) {
  console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.name}${check.detail ? ` — ${check.detail}` : ''}`);
  if (!check.ok) failed++;
}
console.log(`Sprint 31 completion source gate: ${checks.length - failed}/${checks.length} checks passed.`);
console.log('This static gate does not replace TypeScript typechecking, runtime tests, browser E2E, live provider tests, backup/restore rehearsal or deployment approval.');
if (failed) process.exitCode = 1;
