import { readFileSync, writeFileSync } from 'node:fs';
const file = 'src/admin/routes.ts';
let src = readFileSync(file, 'utf8');
const from = String.raw`  const safe = /^[\s]*[=+\-@]/.test(text) || /^[\t\r]/.test(text) ? ` + "`'${text}`" + String.raw` : text;
  return ` + '`"${safe.replace(/"/g, \'""\')}"`;';
const to = String.raw`  const safe = /^[\s]*[=+@]/.test(text) || /^[\s]*-/.test(text) ? ` + "`'${text}`" + String.raw` : text;
  // Also neutralise a leading tab or carriage return.
  const guarded = /^[\t\r]/.test(safe) ? ` + "`'${safe}`" + String.raw` : safe;
  return ` + '`"${guarded.replace(/"/g, \'""\')}"`;';
const n = src.split(from).length - 1;
if (n !== 1) { console.error(`FAIL: csvCell line matched ${n} times (expected 1). Nothing written.`); process.exit(1); }
writeFileSync(file, src.replace(from, () => to));
console.log('ok   csvCell restored to the exact line the Sprint 26 test expects, plus tab/CR guard');
