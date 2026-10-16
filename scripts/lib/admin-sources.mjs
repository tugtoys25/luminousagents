// The staff dashboard router is split across src/admin/. Static checks that used to read the single
// src/admin/routes.ts read the combined text instead: index, shared helpers, then each domain
// router in mount order (the order that decides route precedence).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function adminSourceFiles(root = process.cwd()) {
  const indexPath = join(root, 'src/admin/routes.ts');
  const index = readFileSync(indexPath, 'utf8');
  const mounted = [...index.matchAll(/^import \w+ from '\.\/routes\/([\w-]+)';$/gm)].map((m) => m[1]);
  return [
    'src/admin/routes.ts',
    'src/admin/shared.ts',
    ...mounted.map((name) => `src/admin/routes/${name}.ts`),
    // SQL extracted from routes lives in repositories; static checks must still see it.
    ...(existsSync(join(root, 'src/admin/repos'))
      ? readdirSync(join(root, 'src/admin/repos'))
          .filter((n) => n.endsWith('.ts'))
          .sort()
          .map((n) => `src/admin/repos/${n}`)
      : []),
  ].map((rel) => join(root, rel));
}

export function readAdminSources(root = process.cwd()) {
  return adminSourceFiles(root)
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');
}
