#!/usr/bin/env node
/**
 * Content readiness worklist for the 198 imported listings. Offline: applies migrations to an
 * in-memory SQLite DB (like reconcile.mjs) and reports, per listing, what a reviewer must fix
 * before it can be approved and published. It changes nothing.
 *
 *   node --experimental-strip-types --no-warnings scripts/content-readiness.mjs [--csv] [--sql]
 *
 *  --csv  one row per listing needing attention
 *  --sql  UPDATE statements for price_minor/currency, EXACT parses only, for a person to review
 *         and run deliberately. Ambiguous prices are never emitted.
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePriceText } from '../src/lib/money.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const db = new DatabaseSync(':memory:');
for (const f of readdirSync(join(root, 'migrations')).filter((n) => /^\d+.*\.sql$/.test(n)).sort())
  db.exec(readFileSync(join(root, 'migrations', f), 'utf8'));

const COPY_RISKS = [
  [/\bguarantee[sd]?\b/i, 'guarantee language'],
  [/\b(returns?|roi|yield)\b/i, 'return/yield claim'],
  [/\b(licen[cs]e[sd]?|licensing)\b/i, 'licence claim to verify'],
  [/\b(exclusive|sole mandate)\b/i, 'exclusivity claim to verify'],
  [/\b(sold|under offer)\b/i, 'sale status wording'],
  [/\bportegual\b|\bteh\b/i, 'typo'],
];
const rows = db
  .prepare("SELECT id, legacy_id, slug, title, country, price_text, price_minor, summary, body_html, content_review_status FROM opportunities ORDER BY CAST(legacy_id AS INTEGER) DESC")
  .all();

const out = [];
const sql = [];
const tally = { total: rows.length, noCountry: 0, priceAmbiguous: 0, priceExact: 0, priceOnRequest: 0, priceEmpty: 0, copyFlags: 0 };
for (const r of rows) {
  const issues = [];
  if (!r.country) { issues.push('country missing'); tally.noCountry++; }
  const p = parsePriceText(r.price_text);
  if (p.kind === 'ambiguous') { issues.push(`price ambiguous (${p.reason}): "${r.price_text}"`); tally.priceAmbiguous++; }
  else if (p.kind === 'exact') {
    tally.priceExact++;
    if (r.price_minor == null)
      sql.push(`UPDATE opportunities SET price_minor = ${p.minor}, currency = '${p.currency}' WHERE id = '${String(r.id).replace(/'/g, "''")}' AND price_minor IS NULL; -- "${String(r.price_text).replace(/[\r\n]/g, ' ')}"`);
  } else if (p.kind === 'on_request') tally.priceOnRequest++;
  else { tally.priceEmpty++; issues.push('price empty'); }
  if (!r.summary || r.summary.trim().length < 20) issues.push('summary missing or thin');
  const text = `${r.title} ${r.summary} ${r.body_html}`.replace(/<[^>]+>/g, ' ');
  for (const [re, label] of COPY_RISKS) if (re.test(text)) { issues.push(label); tally.copyFlags++; }
  if (issues.length) out.push({ legacy: r.legacy_id, slug: r.slug, title: r.title, issues });
}

if (process.argv.includes('--sql')) {
  console.log(`-- ${sql.length} exact price parses. Review before running. Ambiguous prices are excluded.\nBEGIN;\n${sql.join('\n')}\nCOMMIT;`);
} else if (process.argv.includes('--csv')) {
  const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
  console.log('legacy_id,slug,title,issues');
  for (const o of out) console.log([o.legacy, o.slug, o.title, o.issues.join('; ')].map(q).join(','));
} else {
  console.log(JSON.stringify(tally, null, 2));
  console.log(`${out.length} of ${rows.length} listings need attention before approval.`);
}
