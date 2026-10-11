#!/usr/bin/env node
/**
 * Sprint 32 completion gate.
 *
 * Unlike the earlier static gates, this one RUNS things: the leak audit over the 198 seeded
 * listings, the offline reconciliation, and the generated role matrix check. It still cannot
 * typecheck, run Vitest, deploy, or reach any provider. Those are listed as external gates.
 *
 *   node scripts/sprint32-completion-gate.mjs
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: Boolean(ok), detail });

function run(script, args = []) {
  const out = spawnSync(process.execPath, ['--no-warnings', join(root, 'scripts', script), ...args], { cwd: root, encoding: 'utf8' });
  return { ok: out.status === 0, text: `${out.stdout}${out.stderr}`.trim().split('\n').slice(-3).join(' | ') };
}

// Files
for (const path of [
  'src/domain/opportunities/redaction.ts',
  'src/domain/opportunities/lifecycle.ts',
  'src/domain/opportunities/reconciliation.ts',
  'test/unit/sprint32-redaction.test.ts',
  'test/unit/sprint32-lifecycle.test.ts',
  'test/unit/sprint32-legacy-public-leak.test.ts',
  'test/unit/sprint32-security-invariants.test.ts',
  'docs/ROLE_ROUTE_MATRIX.md',
  'docs/SPRINT_32_COMPLETION.md',
  'docs/SPRINT_32_OWNER_DECISIONS.md',
  'docs/MONITORING_AND_ALERTS.md',
  'e2e/playwright.config.ts',
  '.github/workflows/r2-documents-backup.yml',
]) check(`file exists: ${path}`, existsSync(join(root, path)));

// Migrations contiguous (Sprint 32 adds none)
const migrations = readdirSync(join(root, 'migrations')).filter((n) => /^\d{4}_.*\.sql$/.test(n)).sort();
check('migrations are contiguous 0001..0030', migrations.every((n, i) => Number(n.slice(0, 4)) === i + 1) && migrations.length === 30, `${migrations.length} files`);

// Source behaviour
const admin = read('src/admin/routes.ts');
const auth = read('src/auth/portal-routes.ts');
check('publication route enforces lifecycle transitions', admin.indexOf('checkLifecycleTransition(') > 0 && admin.indexOf('checkLifecycleTransition(') < admin.indexOf('UPDATE opportunities SET lifecycle = ?, public_visibility'));
check('fixed /opportunities paths registered before :id', ['lifecycle-transitions', 'reconciliation', 'review-queue', 'export.csv'].every((p) => admin.indexOf(`admin.get('/opportunities/${p}'`) > 0 && admin.indexOf(`admin.get('/opportunities/${p}'`) < admin.indexOf("admin.get('/opportunities/:id',")));
check('buyer email-code request does not call its response object', !/c\.json\(generic\(\), 202\)/.test(auth) && auth.includes('c.json(generic, 202)'));
check('serializer uses shared redaction module', read('src/domain/opportunities/serialize.ts').includes("from './redaction.ts'"));
check('public pages never serialize as tier 1', !read('src/web/pages/public.tsx').includes('serializeOpportunity(row, 1)'));

// Config
const pkg = JSON.parse(read('package.json'));
check('package scripts added', ['preflight:sprint32', 'audit:leaks', 'audit:reconcile', 'docs:role-matrix'].every((s) => pkg.scripts[s]));
check('pnpm-lock.yaml present and dependencies not edited', existsSync(join(root, 'pnpm-lock.yaml')) && !JSON.stringify(pkg).includes('playwright'));
check('static source tests run in Node and are excluded from tsc', read('vitest.node.config.ts').includes('sprint2[4-9]') && read('tsconfig.json').includes('sprint32-security-invariants'));
check('e2e suite is isolated from the root install', existsSync(join(root, 'e2e/package.json')) && read('eslint.config.js').includes("'e2e/**'"));

// Executed checks
for (const [label, script, args] of [
  ['leak audit passes on all seeded listings', 'sprint32-leak-audit.mjs', []],
  ['reconciliation accounts for all 198 records', 'sprint32-reconcile.mjs', []],
  ['role matrix is current', 'sprint32-role-matrix.mjs', ['--check']],
]) {
  const r = run(script, args);
  check(label, r.ok, r.ok ? '' : r.text);
}

let failed = 0;
for (const r of results) {
  if (!r.ok) failed += 1;
  console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${!r.ok && r.detail ? `  (${r.detail})` : ''}`);
}
console.log(`\nSprint 32 source gate: ${results.length - failed}/${results.length} checks passed.`);

const wrangler = read('wrangler.jsonc');
const placeholders = (wrangler.match(/0{8}-0{4}-0{4}-0{4}-0{12}|"0{32}"/g) ?? []).length;
console.log('\nEXTERNAL GATES (cannot be closed by source code; each needs evidence):');
for (const line of [
  `wrangler.jsonc still has ${placeholders} placeholder resource id(s); use real owner-controlled Cloudflare ids`,
  'pnpm install --frozen-lockfile, pnpm check (typecheck, lint, Vitest) must pass on a networked machine',
  'Vitest Workers-pool tests (sprint32-legacy-public-leak) have not been executed; run them in CI',
  'e2e/ Playwright suite must run green against staging',
  'real malware scanner, Resend sender domain (SPF/DKIM/DMARC) and Turnstile keys tested in staging',
  'D1 and R2 restore drill performed and recorded; R2 backup workflow run once',
  'uptime, error and queue alerts configured (docs/MONITORING_AND_ALERTS.md)',
  'owner decisions answered (docs/SPRINT_32_OWNER_DECISIONS.md), counsel sign-off recorded',
  'every listing hand-reviewed before publication',
]) console.log(` - ${line}`);
console.log('\nThis gate does not certify production readiness.');
process.exit(failed ? 1 : 0);
