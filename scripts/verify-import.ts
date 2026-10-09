import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const sourcePath = resolve(process.argv[2] ?? 'legacy-source/mayfair/listings.json');
const sqlPath = resolve(process.argv[3] ?? 'scripts/generated/legacy-opportunities.sql');
const source: unknown = JSON.parse(await readFile(sourcePath, 'utf8'));
if (!Array.isArray(source)) throw new Error('Source listings must be an array.');
const sql = await readFile(sqlPath, 'utf8');
const ids = new Set<string>();
for (const item of source) {
  if (!item || typeof item.id !== 'string') throw new Error('Source contains an invalid ID.');
  if (ids.has(item.id)) throw new Error(`Duplicate source ID: ${item.id}`);
  ids.add(item.id);
}
const insertLines = sql.split('\n').filter((line) => line.startsWith('INSERT INTO opportunities '));
if (insertLines.length !== source.length)
  throw new Error(
    `Import mismatch: ${source.length} source rows, ${insertLines.length} SQL inserts.`,
  );
const unsafeLines = insertLines.filter(
  (line) =>
    !/, '(?:draft|sold|off_market|on_hold)', 'pending',/.test(line) ||
    !/, 0, '\d{4}-\d{2}-\d{2}T[^']+', '\d{4}-\d{2}-\d{2}T[^']+'\) ON CONFLICT\(legacy_id\)/.test(
      line,
    ),
);
if (unsafeLines.length)
  throw new Error(
    `${unsafeLines.length} generated rows do not prove the non-public import invariant.`,
  );
console.log(
  JSON.stringify(
    {
      sourceCount: source.length,
      uniqueLegacyIds: ids.size,
      generatedInsertStatements: insertLines.length,
      allImportedAsNonPublic: true,
      databaseOrphans: 'not measurable until applied to D1',
    },
    null,
    2,
  ),
);
