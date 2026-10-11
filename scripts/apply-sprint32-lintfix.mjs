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
const BS = '\\'; // one backslash

patch('eslint.config.js', [
  ['more browser globals',
   "  console: 'readonly',\n};\nconst node",
   "  console: 'readonly',\n  location: 'readonly',\n  history: 'readonly',\n  navigator: 'readonly',\n  crypto: 'readonly',\n  localStorage: 'readonly',\n  setTimeout: 'readonly',\n  clearTimeout: 'readonly',\n  setInterval: 'readonly',\n  URL: 'readonly',\n  Event: 'readonly',\n  Node: 'readonly',\n  MutationObserver: 'readonly',\n  HTMLInputElement: 'readonly',\n};\nconst node"],
  ['allow /* global */ comments in analytics files',
   "  { files: ['scripts/**/*.mjs'], languageOptions: { globals: node } },",
   "  {\n    files: ['public/static/js/analytics-consent*.js'],\n    rules: { 'no-redeclare': ['error', { builtinGlobals: false }] },\n  },\n  { files: ['scripts/**/*.mjs'], languageOptions: { globals: node } },"],
]);

patch('src/admin/routes.ts', [
  ['intentional control chars in filename sanitiser',
   "    const safeName = file.name.replace(",
   "    // eslint-disable-next-line no-control-regex -- intentionally strips control characters from filenames\n    const safeName = file.name.replace("],
  ['literal BOM -> \\uFEFF escape (same output)',
   '`\uFEFF${lines.join(',
   '`' + BS + 'uFEFF${lines.join('],
]);

patch('src/index.ts', [
  ['useless escape in character class',
   `,${BS}-'${BS}"]/g`,
   `,${BS}-'"]/g`],
]);

patch('src/web/managed-content.ts', [
  ['drop unused opportunityTitle declaration', "  let opportunityTitle = '';\n", ''],
  ['drop unused opportunityTitle assignment', "      opportunityTitle = op.title;\n", ''],
]);

patch('test/unit/sprint25-security-baseline.test.ts', [
  ['useless escapes', `'[${BS}"Price 21m Euros${BS}"]'`, `'["Price 21m Euros"]'`],
]);
patch('test/unit/sprint31-completion-hardening.test.ts', [
  ['useless escapes', `'name=${BS}"sort${BS}"'`, `'name="sort"'`],
]);
patch('scripts/sprint31-completion-gate.mjs', [
  ['unused import', "import { join } from 'node:path';\n", ''],
]);
console.log('\nAll edits applied. Now run: pnpm lint');
