import { existsSync, readFileSync } from 'node:fs';

const failures = [];
const requireFile = (file) => {
  if (!existsSync(file)) failures.push(`Missing required Sprint 13 file: ${file}`);
};
const requireMatch = (file, label, pattern) => {
  if (!existsSync(file) || !pattern.test(readFileSync(file, 'utf8')))
    failures.push(`Missing source invariant: ${label}`);
};
for (const file of [
  'src/auth/portal-routes.ts',
  'public/static/css/portal.css',
  'public/static/js/portal-bootstrap.js',
  'public/static/js/portal-register.js',
  'public/static/js/dashboard-buyers.js',
  'public/static/js/dashboard-access-grants.js',
  'migrations/0013_sprint12_port.sql',
  'test/unit/portal-registration.test.ts',
  'test/unit/listing-media.test.ts',
  'test/unit/buyer-download-e2e.test.ts',
  'docs/SPRINT_13.md',
  'pnpm-lock.yaml',
]) requireFile(file);
requireMatch('src/auth/portal-routes.ts', 'one-time bootstrap token guard', /ADMIN_BOOTSTRAP_TOKEN[\s\S]*?user_type = 'staff'/);
requireMatch('src/auth/portal-routes.ts', 'buyer registration requires consent', /consent:\s*z\.literal\(true\)/);
requireMatch('src/auth/portal-routes.ts', 'registration stays invited', /'buyer', 'buyer', 'invited'/);
requireMatch('src/admin/routes.ts', 'listing classification and labels', /classification:[\s\S]*?labels:/);
requireMatch('src/admin/routes.ts', 'image upload validates signatures and digest', /INVALID_FILE_SIGNATURE[\s\S]*?SHA-256/);
requireMatch('src/admin/routes.ts', 'public listing publication requires public classification', /existing\.classification !== 'public'/);
requireMatch('src/web/pages/public.tsx', 'public media verifies stored hash and listing visibility', /classification = 'public'[\s\S]*?actual !== media\.sha256/);
requireMatch('src/admin/routes.ts', 'audited grant revocation', /access_grant\.revoked/);
const wrangler = readFileSync('wrangler.jsonc', 'utf8');
for (const environment of ['staging', 'production'])
  if (!wrangler.includes(`"${environment}"`)) failures.push(`Missing preserved Wrangler environment: ${environment}`);
if (failures.length) {
  console.error(`Sprint 13 integration gate: ${failures.length} failure(s)`);
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exitCode = 1;
} else {
  console.log('Sprint 13 integration source gate passed.');
  console.log('This gate is static only; it does not run typecheck, Vitest, Cloudflare deployment, or live email/scanner checks.');
}
