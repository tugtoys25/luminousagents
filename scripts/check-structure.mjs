#!/usr/bin/env node
/**
 * Structure guard (runs in CI).
 *
 * Rules for everything under src/:
 *   1. No file over 400 lines.
 *   2. Only repository files (repo.ts, *-repo.ts, repositories/) may call `.prepare(`.
 *
 * Existing offenders are recorded in scripts/structure-allowlist.json with their CURRENT limits.
 * It is a ratchet: a listed file may shrink but never grow, an unlisted file may not break a rule,
 * and `--update` rewrites the allowlist downwards only. The goal is an empty allowlist.
 *
 *   node scripts/check-structure.mjs            # check
 *   node scripts/check-structure.mjs --update   # lower recorded limits after you shrank something
 *   node scripts/check-structure.mjs --init     # write a fresh allowlist from the current tree
 */
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const allowPath = join(root, 'scripts/structure-allowlist.json');
const MAX_LINES = 400;
const mode = process.argv.includes('--init') ? 'init' : process.argv.includes('--update') ? 'update' : 'check';

const isRepo = (file) => /(^|\/)(repo\.ts|[\w-]+-repo\.ts)$/.test(file) || file.includes('/repositories/');

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

const measured = {};
for (const full of walk(join(root, 'src'))) {
  const file = relative(root, full).split('\\').join('/');
  const source = readFileSync(full, 'utf8');
  measured[file] = {
    lines: source.split('\n').length - (source.endsWith('\n') ? 1 : 0),
    sql: isRepo(file) ? 0 : (source.match(/\.prepare\(/g) ?? []).length,
  };
}

const offenders = Object.fromEntries(
  Object.entries(measured)
    .filter(([, m]) => m.lines > MAX_LINES || m.sql > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, m]) => [file, { maxLines: Math.max(m.lines, MAX_LINES), maxSql: m.sql }]),
);

if (mode === 'init') {
  writeFileSync(allowPath, JSON.stringify(offenders, null, 2) + '\n');
  console.log(`Wrote ${Object.keys(offenders).length} allowlist entries.`);
  process.exit(0);
}

const allow = existsSync(allowPath) ? JSON.parse(readFileSync(allowPath, 'utf8')) : {};
const problems = [];
const loosenable = [];

for (const [file, m] of Object.entries(measured)) {
  const limit = allow[file] ?? { maxLines: MAX_LINES, maxSql: 0 };
  if (m.lines > limit.maxLines)
    problems.push(`${file}: ${m.lines} lines (limit ${limit.maxLines}${allow[file] ? ', ratchet' : ''})`);
  if (m.sql > limit.maxSql)
    problems.push(`${file}: ${m.sql} SQL calls outside a repository (limit ${limit.maxSql}${allow[file] ? ', ratchet' : ''})`);
  if (allow[file] && (m.lines < limit.maxLines || m.sql < limit.maxSql)) loosenable.push(file);
}
for (const file of Object.keys(allow)) if (!measured[file]) loosenable.push(file);

if (mode === 'update') {
  writeFileSync(allowPath, JSON.stringify(offenders, null, 2) + '\n');
  console.log(`Allowlist now has ${Object.keys(offenders).length} entries.`);
  process.exit(problems.length ? 1 : 0);
}

const remaining = Object.keys(allow).length;
if (problems.length) {
  console.error('Structure guard failed:\n' + problems.map((p) => `  - ${p}`).join('\n'));
  console.error('\nMove SQL into a repo.ts and split large files. Do not raise the limits.');
  process.exit(1);
}
if (loosenable.length)
  console.log(`Note: ${loosenable.length} allowlisted file(s) have shrunk. Run: node scripts/check-structure.mjs --update`);
console.log(`Structure guard passed. ${Object.keys(measured).length} files checked, ${remaining} legacy allowlist entries remaining.`);
