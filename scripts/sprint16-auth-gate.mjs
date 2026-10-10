import { existsSync, readFileSync } from 'node:fs';

const failures = [];
const read = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : '');
const need = (file) => {
  if (!existsSync(file)) failures.push(`Missing required Sprint 16 file: ${file}`);
};
const match = (file, label, pattern) => {
  if (!pattern.test(read(file))) failures.push(`Missing source invariant: ${label}`);
};
const absent = (file, label, pattern) => {
  if (pattern.test(read(file))) failures.push(`Forbidden pattern present: ${label}`);
};

for (const file of [
  'migrations/0014_custom_staff_auth.sql',
  'migrations/0015_platform_management.sql',
  'migrations/0016_auth_hardening.sql',
  'src/auth/password.ts',
  'src/auth/staff-session.ts',
  'src/auth/portal-routes.ts',
  'public/static/js/auth-forms.js',
  'public/static/js/dashboard-staff.js',
  'public/static/js/dashboard-session.js',
  'test/apply-migrations.ts',
  'vitest.node.config.ts',
  'test/unit/password-auth.test.ts',
  'test/unit/sprint16-security-invariants.test.ts',
  'docs/SPRINT_16_UNIFIED_AUTH.md',
])
  need(file);
if (existsSync('src/auth/password-routes.ts'))
  failures.push('Legacy src/auth/password-routes.ts must be removed (duplicate auth routes).');
match('src/auth/password.ts', 'Workers-compatible PBKDF2 cost', /ITERATIONS = 100_000/);
match('src/auth/portal-routes.ts', 'login lockout', /MAX_FAILED_LOGINS/);
match(
  'src/auth/portal-routes.ts',
  'password-less staff credential migration',
  /AND password_hash IS NULL LIMIT 1/,
);
match(
  'src/admin/routes.ts',
  'staff management restricted to super admins',
  /admin\.post\('\/staff', requireRole\('super_admin'\)/,
);
match('src/admin/routes.ts', 'Sprint 15 platform settings preserved', /admin\.put\('\/settings'/);
match('src/index.ts', 'managed content routes preserved', /managedContentRoutes/);
match('vitest.config.ts', 'D1 migrations applied in tests', /readD1Migrations/);
absent('src/index.ts', 'legacy password routes mounted', /passwordRoutes/);
for (const file of [
  'src/admin/routes.ts',
  'src/buyers/routes.ts',
  'src/auth/portal-routes.ts',
  'src/env.ts',
])
  absent(
    file,
    `${file} references Cloudflare Access or OTP login`,
    /Cf-Access-Jwt-Assertion|ACCESS_AUD|request-code|verify-code|buyer_login_codes/,
  );

if (failures.length) {
  console.error(`Sprint 16 auth gate: ${failures.length} failure(s)`);
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exitCode = 1;
} else {
  console.log('Sprint 16 auth source gate passed.');
  console.log(
    'This gate is static only; it does not run typecheck, Vitest, Cloudflare deployment, or live email checks.',
  );
}
