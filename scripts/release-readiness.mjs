import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
const configPath = resolve('wrangler.jsonc');
const config = readFileSync(configPath, 'utf8');
const issues = [];
if (!existsSync('pnpm-lock.yaml'))
  issues.push('pnpm-lock.yaml is missing; generate it with the pinned pnpm version and commit it.');
for (const id of config.matchAll(/"(?:database_id|id)"\s*:\s*"([0-9a-f-]{16,})"/gi)) {
  if (/^0+$/.test(id[1].replaceAll('-', '')))
    issues.push('wrangler.jsonc contains a placeholder Cloudflare resource ID.');
}
if (
  !process.env.MALWARE_SCANNER_API_URL ||
  !process.env.MALWARE_SCANNER_API_TOKEN ||
  !process.env.MALWARE_SCANNER_SIGNING_SECRET
)
  issues.push(
    'Trusted malware scanner URL, bearer token and HMAC signing secret are not configured in this environment.',
  );
if (!process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ACCOUNT_ID)
  issues.push('Cloudflare deployment credentials are not present in this execution environment.');
if (!process.env.CLOUDFLARE_ZONE_ID || !process.env.CLOUDFLARE_CACHE_PURGE_TOKEN)
  issues.push(
    'Cloudflare zone ID and scoped cache-purge token are not configured for publication invalidation.',
  );
if (process.argv.includes('--config-only')) {
  for (let i = issues.length - 1; i >= 0; i--)
    if (
      issues[i].startsWith('Trusted malware scanner') ||
      issues[i].startsWith('Cloudflare deployment credentials') ||
      issues[i].startsWith('Cloudflare zone ID')
    )
      issues.splice(i, 1);
}
if (issues.length) {
  console.error('RELEASE READINESS BLOCKED');
  for (const issue of [...new Set(issues)]) console.error(`- ${issue}`);
  process.exitCode = 1;
} else
  console.log(
    'Release configuration preflight passed. This does not replace tests, staging verification, legal approval or a restore drill.',
  );
