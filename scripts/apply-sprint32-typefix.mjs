import { readFileSync, writeFileSync } from 'node:fs';

function patch(file, edits) {
  let src = readFileSync(file, 'utf8');
  for (const [label, from, to] of edits) {
    const count = src.split(from).length - 1;
    if (count !== 1) {
      console.error(`FAIL ${file}: "${label}" matched ${count} times (expected 1). Nothing written for this file.`);
      process.exit(1);
    }
    src = src.replace(from, () => to);
    console.log(`ok   ${file}: ${label}`);
  }
  writeFileSync(file, src);
}

patch('src/admin/routes.ts', [
  ['merge csvCell (keep one, stricter rule)',
`function csvCell(value: unknown): string {
  const text = value == null ? '' : typeof value === 'string' ? value : String(value);
  // Prevent spreadsheet formula execution while preserving ordinary text.
  const safe = /^[\\s]*[=+@]/.test(text) || /^[\\s]*-/.test(text) ? \`'\${text}\` : text;
  return \`"\${safe.replace(/"/g, '""')}"\`;
}`,
`function csvCell(value: unknown): string {
  const text = value == null ? '' : typeof value === 'string' ? value : String(value);
  // Prevent spreadsheet formula execution while preserving ordinary text.
  const safe = /^[\\s]*[=+\\-@]/.test(text) || /^[\\t\\r]/.test(text) ? \`'\${text}\` : text;
  return \`"\${safe.replace(/"/g, '""')}"\`;
}`],
  ['remove duplicate csvCell',
`const csvCell = (value: unknown): string => {
  let text = String(value ?? '');
  // Neutralise spreadsheet formula injection from public input.
  if (/^[=+\\-@\\t\\r]/.test(text)) text = \`'\${text}\`;
  return \`"\${text.replace(/"/g, '""')}"\`;
};
`, ''],
  ['args may hold null',
   "const args: (string | number)[] = [];\n  for (const [key, column] of [['filename'",
   "const args: (string | number | null)[] = [];\n  for (const [key, column] of [['filename'"],
  ['rows[0] guard', 'const headers = rows[0].map(', 'const headers = (rows[0] ?? []).map('],
  ['cells guard', 'const cells = rows[rowIndex];\n', 'const cells = rows[rowIndex];\n    if (!cells) continue;\n'],
  ['row.id guard', 'const opportunityId = row.id.trim();', "const opportunityId = (row.id ?? '').trim();"],
]);

patch('src/web/pages/public.tsx', [
  ['entries lastmod guards',
`    entries[1].lastmod = isoDate(newest);
    entries[0].lastmod = isoDate(newest);
    entries[3].lastmod = isoDate(archived?.updatedAt);`,
`    if (entries[1]) entries[1].lastmod = isoDate(newest);
    if (entries[0]) entries[0].lastmod = isoDate(newest);
    if (entries[3]) entries[3].lastmod = isoDate(archived?.updatedAt);`],
]);

patch('src/web/seo.ts', [
  ['optional path under exactOptionalPropertyTypes',
`    return {
      name: LABELS[decoded] ?? titleCase(decoded),
      path:
        UNLINKED.has(decoded) && index < segments.length - 1
          ? undefined
          : \`/\${segments
              .slice(0, index + 1)
              .map(encodeURIComponent)
              .join('/')}\`,
    };`,
`    const name = LABELS[decoded] ?? titleCase(decoded);
    if (UNLINKED.has(decoded) && index < segments.length - 1) return { name };
    return {
      name,
      path: \`/\${segments
        .slice(0, index + 1)
        .map(encodeURIComponent)
        .join('/')}\`,
    };`],
]);
console.log('\nAll edits applied. Now run: pnpm typecheck');
