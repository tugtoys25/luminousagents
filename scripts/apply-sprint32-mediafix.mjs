import { readFileSync, writeFileSync } from 'node:fs';
function patch(file, edits) {
  let src = readFileSync(file, 'utf8');
  for (const [label, from, to] of edits) {
    const n = src.split(from).length - 1;
    if (n !== 1) { console.error(`FAIL ${file}: "${label}" matched ${n} times (expected 1). Nothing written for this file.`); process.exit(1); }
    src = src.replace(from, () => to);
    console.log(`ok   ${file}: ${label}`);
  }
  writeFileSync(file, src);
}

// 1. The picker script is injected into every dashboard page, but its stylesheet was only linked from the Media library page.
patch('src/index.ts', [
  ['link dashboard-media.css on every dashboard page',
   "html = html.replace('</head>', () => `${identity}</head>`);",
   "const mediaCss = html.includes('/static/css/dashboard-media.css')\n      ? ''\n      : '<link rel=\"stylesheet\" href=\"/static/css/dashboard-media.css\">';\n    html = html.replace('</head>', () => `${identity}${mediaCss}</head>`);"],
]);

// 2. The picker must never enhance native file inputs (checkboxes, buttons...): only text-like URL fields.
patch('public/static/js/dashboard-media-picker.js', [
  ['skip non-text inputs before the label heuristics',
   "  const fieldKind = (el) => {\n    const key = labelFor(el);",
   "  const fieldKind = (el) => {\n    // Native file inputs and other non-text inputs are never URL fields.\n    if (el instanceof HTMLInputElement && !['url', 'text', 'search'].includes(el.type)) return null;\n    const key = labelFor(el);"],
]);
console.log('\nAll edits applied. Now run: pnpm typecheck && pnpm lint && pnpm test:node, then deploy.');
