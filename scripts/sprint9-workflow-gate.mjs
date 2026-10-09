import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const required = [
  ['buyer/staff E2E suite', 'test/buyer-staff-workflows.e2e.test.ts'],
  ['buyer authorization re-checks', 'src/buyers/routes.ts'],
  ['staff NDA review endpoint', 'src/admin/routes.ts'],
  ['Worker test configuration', 'vitest.config.ts'],
];
let failed = false;
for (const [label, file] of required) {
  const ok = existsSync(file);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${file}`);
  failed ||= !ok;
}
const buyer = readFileSync('src/buyers/routes.ts', 'utf8');
for (const [label, pattern] of [
  ['expired grants denied', /expires_at > \?/],
  ['revoked grants denied', /revoked_at IS NULL/],
  ['non-clean documents excluded', /scan_status = 'clean'/],
  [
    'opportunity publication revalidated',
    /lifecycle = 'published'.*content_review_status = 'approved'.*public_visibility = 1/s,
  ],
]) {
  const ok = pattern.test(buyer);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
  failed ||= !ok;
}
if (!existsSync('node_modules')) {
  console.log(
    'BLOCKED dependencies not installed; run pnpm install --frozen-lockfile after committing the lockfile.',
  );
  failed = true;
} else {
  const result = spawnSync('pnpm', ['test:e2e:buyer-staff'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) failed = true;
}
process.exitCode = failed ? 1 : 0;
