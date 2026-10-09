import { existsSync, readFileSync } from 'node:fs';
const failures = [];
const requireFile = (path) => {
  if (!existsSync(path)) failures.push(`Missing required Sprint 10 file: ${path}`);
};
for (const file of [
  'src/security/malware-scanner.ts',
  'migrations/0010_sprint10_readiness.sql',
  'migrations/0011_seed_legacy_listings.sql',
  'migrations/0012_broker_assignment.sql',
  'public/static/css/dashboard.css',
  'public/static/js/dashboard-opportunities.js',
  'public/static/js/dashboard-buyers.js',
  'public/static/js/dashboard-nda-templates.js',
  'test/unit/scanner.test.ts',
  'test/unit/sprint10-security-invariants.test.ts',
  'test/unit/public-cache.test.ts',
])
  requireFile(file);
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
if (pkg.packageManager !== 'pnpm@10.18.3')
  failures.push('packageManager must remain pinned to pnpm@10.18.3.');
if (!existsSync('pnpm-lock.yaml'))
  failures.push(
    'pnpm-lock.yaml is missing; dependency installation and the full build remain blocked.',
  );
for (const file of ['src/admin/routes.ts', 'src/buyers/routes.ts']) {
  const source = readFileSync(file, 'utf8');
  if (/<style\s*>/i.test(source))
    failures.push(
      `${file} still contains an inline style block incompatible with style-src 'self'.`,
    );
  if (/\sstyle\s*=\s*["']/.test(source))
    failures.push(`${file} still contains a style attribute incompatible with style-src 'self'.`);
}
const scanner = readFileSync('src/security/malware-scanner.ts', 'utf8');
for (const token of [
  'crypto.subtle.verify',
  'X-Content-SHA256',
  'expectedSha256',
  'PRIVATE_FILES.get',
])
  if (!scanner.includes(token)) failures.push(`Scanner adapter missing invariant: ${token}`);
const migration = readFileSync('migrations/0011_seed_legacy_listings.sql', 'utf8');
const inserts = (migration.match(/INSERT INTO opportunities/g) || []).length;
if (inserts !== 198) failures.push(`Legacy migration must contain 198 inserts; found ${inserts}.`);
if (/, 1, '2026-10-09T/.test(migration))
  failures.push('Legacy seed may contain a public-visibility row; review migration before use.');
console.log('Sprint 10 source readiness gate');
console.log(`Failures: ${failures.length}`);
for (const failure of failures) console.error(`FAIL: ${failure}`);
console.log(
  'This source gate does not install dependencies, typecheck, run tests, validate live Cloudflare resources, or prove provider integration.',
);
if (failures.length) process.exitCode = 1;
