#!/usr/bin/env node
/**
 * Sprint 32 — offline reconciliation of the legacy opportunity import.
 *
 * Applies every numbered migration to an in-memory SQLite database (Node's built-in
 * node:sqlite, no dependencies) and runs the same check list the dashboard endpoint
 * GET /dashboard/opportunities/reconciliation uses. The check list is read straight from
 * src/domain/opportunities/reconciliation.ts so the two cannot drift apart.
 *
 *   node scripts/reconcile.mjs [--expect 198] [--json]
 *
 * Exit code 1 when the record count differs from --expect (default 198) or a blocker check is
 * non-zero. This proves the migrations and seed are consistent; it does not prove a remote D1
 * database matches. Run the dashboard endpoint against staging for that.
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const asJson = args.includes('--json');
const expectIndex = args.indexOf('--expect');
const expected = expectIndex >= 0 ? Number(args[expectIndex + 1]) : 198;

function loadChecks() {
  const source = readFileSync(join(root, 'src/domain/opportunities/reconciliation.ts'), 'utf8');
  const pattern =
    /key:\s*'([a-z_]+)',\s*label:\s*'([^']+)',\s*severity:\s*'([a-z]+)',\s*where:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g;
  const checks = [];
  for (const match of source.matchAll(pattern)) {
    const raw = match[4];
    const body = raw.slice(1, -1).replace(/\\'/g, "'").replace(/\\"/g, '"');
    checks.push({ key: match[1], label: match[2], severity: match[3], where: body });
  }
  if (checks.length < 10) throw new Error(`Only parsed ${checks.length} reconciliation checks; format changed?`);
  return checks;
}

const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON');
const migrations = readdirSync(join(root, 'migrations'))
  .filter((name) => /^\d{4}_.*\.sql$/.test(name))
  .sort();
for (const name of migrations) {
  try {
    db.exec(readFileSync(join(root, 'migrations', name), 'utf8'));
  } catch (error) {
    console.error(`Migration ${name} failed: ${error.message}`);
    process.exit(1);
  }
}

const checks = loadChecks();
const total = db.prepare('SELECT COUNT(*) AS n FROM opportunities').get().n;
const results = checks.map((check) => ({
  ...check,
  count: db.prepare(`SELECT COUNT(*) AS n FROM opportunities WHERE ${check.where}`).get().n,
}));
const groups = {};
for (const column of ['lifecycle', 'content_review_status', 'public_visibility', 'classification', 'legacy_status']) {
  groups[column] = db
    .prepare(`SELECT ${column} AS value, COUNT(*) AS count FROM opportunities GROUP BY ${column} ORDER BY count DESC`)
    .all();
}
const duplicateLegacy = db
  .prepare('SELECT COUNT(*) AS n FROM (SELECT legacy_id FROM opportunities WHERE legacy_id IS NOT NULL GROUP BY legacy_id HAVING COUNT(*) > 1)')
  .get().n;
const duplicateSlug = db
  .prepare('SELECT COUNT(*) AS n FROM (SELECT slug FROM opportunities GROUP BY slug HAVING COUNT(*) > 1)')
  .get().n;
const fkViolations = db.prepare('PRAGMA foreign_key_check').all().length;

const blockers = results.filter((r) => r.severity === 'blocker' && r.count > 0);
const problems = [];
if (total !== expected) problems.push(`expected ${expected} records, found ${total}`);
if (blockers.length) problems.push(`blocker checks failing: ${blockers.map((b) => b.key).join(', ')}`);
if (duplicateLegacy) problems.push(`${duplicateLegacy} duplicate legacy ids`);
if (duplicateSlug) problems.push(`${duplicateSlug} duplicate slugs`);
if (fkViolations) problems.push(`${fkViolations} foreign key violations`);

const report = {
  migrationsApplied: migrations.length,
  total,
  expected,
  duplicateLegacyIds: duplicateLegacy,
  duplicateSlugs: duplicateSlug,
  foreignKeyViolations: fkViolations,
  checks: results.map(({ key, label, severity, count }) => ({ key, label, severity, count })),
  groups,
  problems,
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`Sprint 32 reconciliation — ${migrations.length} migrations applied`);
  console.log(`Records: ${total} (expected ${expected}) · duplicate legacy ids: ${duplicateLegacy} · duplicate slugs: ${duplicateSlug} · FK violations: ${fkViolations}\n`);
  for (const r of results) console.log(`${r.severity.padEnd(8)} ${String(r.count).padStart(4)}  ${r.label}`);
  for (const [column, rows] of Object.entries(groups)) {
    console.log(`\nBy ${column}: ${rows.map((row) => `${row.value ?? 'null'}=${row.count}`).join(', ')}`);
  }
  console.log(problems.length ? `\nFAIL: ${problems.join('; ')}` : '\nPASS: all records accounted for; no blocker checks failing.');
  console.log('\nThis is an in-memory migration check. Run the dashboard reconciliation endpoint against staging D1 to verify remote data.');
}
process.exit(problems.length ? 1 : 0);
