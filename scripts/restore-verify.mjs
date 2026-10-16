#!/usr/bin/env node
/**
 * Restore-drill verifier. Loads a PLAINTEXT D1 export (.sql) into an in-memory SQLite database
 * and checks that it is a plausible, complete platform snapshot. No network, no dependencies.
 *
 *   node scripts/restore-verify.mjs path/to/export.sql [--expect-listings 198] [--json]
 *
 * Exit 1 when the SQL does not load or a check fails. Passing proves the snapshot is loadable and
 * internally consistent; it does not replace the buyer/staff smoke test on a restored staging D1.
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const ei = args.indexOf('--expect-listings');
const file = args.find((a, i) => !a.startsWith('--') && (ei < 0 || i !== ei + 1));
const expectListings = ei >= 0 ? Number(args[ei + 1]) : 198;
if (!file) {
  console.error('usage: restore-verify.mjs <export.sql> [--expect-listings N] [--json]');
  process.exit(2);
}

const started = Date.now();
const db = new DatabaseSync(':memory:');
try {
  db.exec(readFileSync(file, 'utf8'));
} catch (error) {
  console.error('FAIL: export did not load:', error instanceof Error ? error.message : error);
  process.exit(1);
}

const one = (sql) => db.prepare(sql).get();
const tableExists = (name) =>
  Boolean(one(`SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='${name}'`));
const REQUIRED_TABLES = [
  'users', 'sessions', 'opportunities', 'enquiries', 'audit_logs', 'notification_jobs',
  'staff_mfa', 'd1_migrations',
];
const checks = [];
const add = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });

for (const t of REQUIRED_TABLES) add(`table:${t}`, tableExists(t), '');
if (tableExists('opportunities')) {
  const total = one('SELECT COUNT(*) AS n FROM opportunities').n;
  add('opportunities count', total >= expectListings, `${total} (expected >= ${expectListings})`);
  const leaked = one(
    "SELECT COUNT(*) AS n FROM opportunities WHERE public_visibility = 1 AND content_review_status <> 'approved'",
  ).n;
  add('no unreviewed listing is public', leaked === 0, `${leaked} violations`);
}
if (tableExists('users')) {
  const staff = one("SELECT COUNT(*) AS n FROM users WHERE role IN ('super_admin','admin')").n;
  add('at least one admin account', staff >= 1, `${staff}`);
}
if (tableExists('d1_migrations')) {
  const n = one('SELECT COUNT(*) AS n FROM d1_migrations').n;
  add('migration history present', n >= 1, `${n} applied`);
}
const fk = db.prepare('PRAGMA foreign_key_check').all();
add('foreign keys consistent', fk.length === 0, `${fk.length} violations`);
const integrity = one('PRAGMA integrity_check');
add('sqlite integrity_check', Object.values(integrity)[0] === 'ok', String(Object.values(integrity)[0]));

const failed = checks.filter((c) => !c.ok);
if (json) console.log(JSON.stringify({ ms: Date.now() - started, checks, ok: failed.length === 0 }, null, 2));
else {
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  console.log(`\nLoaded and checked in ${Date.now() - started} ms. ${failed.length ? 'RESTORE CHECK FAILED' : 'Restore check passed.'}`);
}
process.exit(failed.length ? 1 : 0);
