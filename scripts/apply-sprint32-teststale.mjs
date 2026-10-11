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
const BS = '\\';

// 1. My csvCell merge dropped the "[=+\-@" pattern that the Sprint 19 test looks for.
patch('src/admin/routes.ts', [
  ['csv guard also lists = + - @ (Sprint 19 test)',
   `const guarded = /^[${BS}t${BS}r]/.test(safe)`,
   `const guarded = /^[=+${BS}-@${BS}t${BS}r]/.test(safe)`],
]);

// 2. Sprint 24 test predates the Sprint 25 public_slug lookup in the media route.
patch('test/unit/sprint24-media-library-invariants.test.ts', [
  ['media delivery test matches the Sprint 25 query',
   `expect(index).toMatch(/WHERE id = ${BS}? AND visibility = ${BS}${BS}'public${BS}${BS}'/);`,
   `expect(index).toMatch(/WHERE (${BS}(id = ${BS}? OR public_slug = ${BS}?${BS}) AND|id = ${BS}? AND) visibility = ${BS}${BS}'public${BS}${BS}'/);`],
]);

// 3. Sprint 16 test predates the owner decision (DECISIONS.md, Sprint 25) to re-add buyer email-code sign-in.
patch('test/unit/sprint16-security-invariants.test.ts', [
  ['allow the Sprint 25 buyer email-code endpoints; keep the retired-table check',
   `expect(source).not.toMatch(/request-code|verify-code|buyer_login_codes/);`,
   `// Sprint 25 owner decision (DECISIONS.md): buyers may use email one-time codes again, in buyer_email_codes.
      expect(source).not.toMatch(/buyer_login_codes/);`],
]);
console.log('\nAll edits applied. Now run: pnpm typecheck && pnpm lint && pnpm test:node');
