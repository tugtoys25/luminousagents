#!/usr/bin/env node
/**
 * Sprint 32 — public-output leak audit over every seeded opportunity.
 *
 * Applies all migrations to an in-memory SQLite database (node:sqlite), loads every
 * opportunity, runs the REAL serializer as an anonymous (tier 0) viewer, and fails when any
 * public field still contains a money-like amount or the listing's own asking price.
 *
 *   node scripts/leak-audit.mjs
 *
 * Needs Node 22.18+ (built-in TypeScript type stripping and node:sqlite). No dependencies.
 * This audits the serializer's output only. It does not render pages, so HTML, JSON-LD,
 * sitemap and export output still need their own checks in staging (see docs/history/SPRINT_32_COMPLETION.md).
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { serializeOpportunity } = await import(pathToFileURL(join(root, 'src/domain/opportunities/serialize.ts')).href);
const { containsMoneyLike, parseAmount } = await import(pathToFileURL(join(root, 'src/domain/opportunities/redaction.ts')).href);

const db = new DatabaseSync(':memory:');
for (const name of readdirSync(join(root, 'migrations')).filter((n) => /^\d{4}_.*\.sql$/.test(n)).sort()) {
  db.exec(readFileSync(join(root, 'migrations', name), 'utf8'));
}
const rows = db.prepare('SELECT * FROM opportunities').all();

const findings = [];
let priceFieldLeaks = 0;
for (const row of rows) {
  const out = serializeOpportunity(row, 0);
  if (out.price) {
    priceFieldLeaks += 1;
    findings.push(`${row.slug}: price field exposed (${out.price})`);
  }
  const fields = {
    title: out.title,
    summary: out.summary,
    availability: out.availability,
    seoTitle: out.seoTitle,
    seoDescription: out.seoDescription,
    coverMediaAlt: out.coverMediaAlt,
    ...Object.fromEntries(out.points.map((p, i) => [`points[${i}]`, p])),
    ...Object.fromEntries(out.labels.map((l, i) => [`labels[${i}]`, l])),
  };
  const asking = parseAmount(row.price_text || '');
  for (const [name, value] of Object.entries(fields)) {
    if (!value) continue;
    if (containsMoneyLike(value)) findings.push(`${row.slug}: ${name} still contains a money-like amount`);
    if (asking && asking >= 1000) {
      const numbers = [...value.matchAll(/\d(?:[\d.,]*\d)?(?:\s?(?:million|billion|bn|mn|m|k)\b)?/gi)].map((m) => parseAmount(m[0]));
      if (numbers.includes(asking)) findings.push(`${row.slug}: ${name} still contains the asking price ${row.price_text}`);
    }
  }
  // Control: a tier-1 viewer must still be able to see the price, so we know the field is not simply always empty.
  if (row.price_text && !serializeOpportunity(row, 1).price) findings.push(`${row.slug}: tier 1 viewer lost the price field`);
}

console.log(`Leak audit: ${rows.length} listings serialized as an anonymous visitor`);
console.log(`Price field exposed: ${priceFieldLeaks} · findings: ${findings.length}`);
for (const finding of findings.slice(0, 40)) console.log(` - ${finding}`);
if (!rows.length) {
  console.log('FAIL: no opportunities found; seed missing');
  process.exit(1);
}
console.log(findings.length ? 'FAIL' : 'PASS: no money-like text and no asking price in any public field.');
process.exit(findings.length ? 1 : 0);
