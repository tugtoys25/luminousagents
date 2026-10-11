import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('Sprint 24 managed media library invariants', () => {
  const routes = read('src/admin/routes.ts');
  const index = read('src/index.ts');
  const picker = read('public/static/js/dashboard-media-picker.js');
  const manager = read('public/static/js/dashboard-media.js');
  const migration = read('migrations/0021_media_library.sql');
  const shell = read('public/static/js/dashboard-shell.js');

  it('ships the manager, picker, styles and additive metadata migration', () => {
    for (const path of ['public/static/js/dashboard-media.js', 'public/static/js/dashboard-media-picker.js', 'public/static/css/dashboard-media.css', 'migrations/0021_media_library.sql'])
      expect(existsSync(resolve(process.cwd(), path))).toBe(true);
    expect(migration).toContain("CHECK (visibility IN ('public','private'))");
    expect(migration).toContain('sha256 TEXT NOT NULL');
  });

  it('requires staff authorization for management and restricts public delivery to explicitly public assets', () => {
    expect(routes).toMatch(/admin\.get\('\/media', requireRole\(/);
    expect(routes).toMatch(/admin\.post\('\/media\/upload', requireRole\(/);
    expect(routes).toMatch(/admin\.delete\('\/media\/:id', requireRole\('admin', 'super_admin'\)/);
    expect(index).toMatch(/WHERE (\(id = \? OR public_slug = \?\) AND|id = \? AND) visibility = \\'public\\'/);
    expect(index).toContain("headers.set('X-Content-Type-Options', 'nosniff')");
    expect(index).toContain('/static/js/dashboard-media-picker.js');
  });

  it('validates content signatures and caps upload size', () => {
    expect(routes).toContain('mediaSignatureMatches(type, bytes)');
    expect(routes).toContain('25 * 1024 * 1024');
    expect(routes).toContain("['application/pdf', '.pdf']");
    expect(routes).toContain("['image/webp', '.webp']");
  });

  it('only auto-attaches the picker to media-related URL fields and includes dynamic form rows', () => {
    expect(picker).toContain('Choose from Media');
    expect(picker).toContain('MutationObserver');
    expect(picker).toContain("visibility: 'public'");
    expect(picker).not.toMatch(/eval\(|new Function\(/);
    expect(manager).toContain('data-copy');
    expect(manager).toContain('data-delete');
  });

  it('places the media library in the canonical searchable dashboard navigation', () => {
    expect(shell).toContain("label: 'Media library'");
    expect(shell).toContain("href: '/dashboard/media/ui'");
  });
});
