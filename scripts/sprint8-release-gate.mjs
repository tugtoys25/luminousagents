import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const failures = [];
const warnings = [];
const requireFile = (path, label) => {
  if (!existsSync(join(root, path))) failures.push(`Missing ${label}: ${path}`);
};

requireFile('pnpm-lock.yaml', 'committed pnpm lockfile');
requireFile('docs/SPRINT_8.md', 'Sprint 8 release dossier');
requireFile('migrations/0009_document_integrity.sql', 'document integrity migration');

const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (packageJson.packageManager !== 'pnpm@10.18.3') {
  failures.push(
    `Expected packageManager pnpm@10.18.3; found ${packageJson.packageManager ?? 'unset'}`,
  );
}

const wrangler = readFileSync(join(root, 'wrangler.jsonc'), 'utf8');
if (/00000000-0000-0000-0000-000000000000/.test(wrangler)) {
  failures.push('wrangler.jsonc still contains placeholder D1 database IDs.');
}
if (/00000000000000000000000000000000/.test(wrangler)) {
  failures.push('wrangler.jsonc still contains placeholder KV namespace IDs.');
}
if (/"PRIVATE_FILES"[\s\S]{0,200}"bucket_name"\s*:\s*"[^"]+"/.test(wrangler) === false) {
  failures.push('Could not find a PRIVATE_FILES R2 binding.');
}

const admin = readFileSync(join(root, 'src/admin/routes.ts'), 'utf8');
const buyers = readFileSync(join(root, 'src/buyers/routes.ts'), 'utf8');
const migration = readFileSync(join(root, 'migrations/0009_document_integrity.sql'), 'utf8');
if (!/DEFAULT\s+'pending'/i.test(migration))
  failures.push('Document scan status is not visibly fail-closed by default.');
if (!/scan_status\s*=\s*'clean'/i.test(buyers))
  failures.push('Buyer document routes do not visibly require clean scan status.');
if (!/expires_at\s*>\s*\?/i.test(buyers))
  failures.push('Buyer access routes do not visibly check grant expiry.');
if (!/revoked_at\s+IS\s+NULL/i.test(buyers))
  failures.push('Buyer access routes do not visibly reject revoked grants.');
if (!/scanner reference|scannerReference|scanner_ref/i.test(admin))
  warnings.push(
    'Review staff release workflow: source-level scanner reference checks are not proof of a trusted scan.',
  );
if (!existsSync(join(root, 'src/security/malware-scanner.ts'))) {
  failures.push(
    'No malware-scanner adapter module found; production document release must remain blocked.',
  );
}

console.log('Sprint 8 release-gate source audit');
console.log(`Failures: ${failures.length}`);
for (const item of failures) console.error(`FAIL: ${item}`);
console.log(`Warnings: ${warnings.length}`);
for (const item of warnings) console.warn(`WARN: ${item}`);
console.log(
  'This audit inspects source/configuration only; it does not run application tests, scan files, or verify Cloudflare resources.',
);
if (failures.length) process.exitCode = 1;
