import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const checks = [
  [
    'migration 0009 exists',
    'migrations/0009_document_integrity.sql',
    /scan_status TEXT NOT NULL DEFAULT 'pending'/,
  ],
  [
    'scan status constrained',
    'migrations/0009_document_integrity.sql',
    /CHECK \(scan_status IN \('pending','clean','rejected'\)\)/,
  ],
  [
    'upload stores digest and pending status',
    'src/admin/routes.ts',
    /sha256, scan_status\) VALUES \([\s\S]*?'pending'\)/,
  ],
  [
    'clean release requires verified scanner adapter',
    'src/admin/routes.ts',
    /scanR2Document\(c\.env[\s\S]*?VERIFIED_SCAN_REQUIRED/,
  ],
  [
    'release decision includes verified hash and scan provenance',
    'src/admin/routes.ts',
    /scan_digest = \?[\s\S]{0,800}sha256: result\.sha256/,
  ],
  ['buyer download checks clean status', 'src/buyers/routes.ts', /scan_status = 'clean'/],
];
let failed = 0;
for (const [label, file, pattern] of checks) {
  const path = resolve(root, file);
  const ok = existsSync(path) && pattern.test(readFileSync(path, 'utf8'));
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
  if (!ok) failed++;
}
if (!existsSync(resolve(root, 'pnpm-lock.yaml'))) {
  console.error('BLOCKER pnpm-lock.yaml is missing; frozen CI installs will fail.');
  failed++;
} else console.log('PASS pnpm-lock.yaml exists');
if (failed) process.exitCode = 1;
else
  console.log(
    'Preflight source checks passed. These checks do not replace runtime tests or scanner integration.',
  );
