import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { COLLECTIONS, getCollection } from '../../src/site-content/registry';
import { defaultSiteContent, resolveForAdmin, resolveSiteContent } from '../../src/site-content/resolve';
import { safeUrl } from '../../src/site-content/fields';
import { validateItem } from '../../src/site-content/validate';
import { themeBodyClass, themeCss } from '../../src/site-content/theme-css';
import { parseCards } from '../../src/web/components/custom-section';
import {
  addItem, deleteItem, isCustomised, listStored, loadAllStored, reorderItems, resetCollection, seedCollection, updateItem,
} from '../../src/site-content/site-content-repo';
import { loadSiteContent } from '../../src/site-content/load';

const ts = '2026-10-30T10:00:00.000Z';
const def = (key: string) => getCollection(key)!;

describe('site content rules', () => {
  it('ships Luminous Agents defaults and keeps the original content', () => {
    const d = defaultSiteContent();
    expect(d.homeSections).toHaveLength(11);
    expect(d.faqs).toHaveLength(7);
    expect(d.services).toHaveLength(6);
    expect(String(d.footer['copyright'])).toContain('Luminous Agents');
    expect(d.customised).toEqual([]);
  });

  it('every built-in default passes its own validation', () => {
    for (const c of COLLECTIONS) for (const row of c.defaults) expect(validateItem(c, row).ok, c.key).toBe(true);
  });

  it('rejects unsafe links, colours and unknown options', () => {
    const hero = def('hero');
    const base = hero.defaults[0]!;
    expect(validateItem(hero, { ...base, primaryUrl: 'javascript:alert(1)' }).ok).toBe(false);
    expect(validateItem(hero, { ...base, backgroundColor: 'red' }).ok).toBe(false);
    expect(validateItem(hero, { ...base, layout: 'bogus' }).ok).toBe(false);
    expect(safeUrl('//evil.example')).toBe('');
    expect(safeUrl('/contact')).toBe('/contact');
    expect(safeUrl('mailto:a@b.co', true)).toBe('mailto:a@b.co');
    expect(safeUrl('mailto:a@b.co')).toBe('');
  });

  it('checks custom home sections', () => {
    const hs = def('home_sections');
    const base = hs.defaults[0]!;
    expect(validateItem(hs, { ...base, type: 'custom' }).ok).toBe(false);
    expect(validateItem(hs, { ...base, type: 'custom', heading: 'Hello', anchor: 'Bad Anchor' }).ok).toBe(false);
    expect(validateItem(hs, { ...base, type: 'custom', heading: 'Hello', anchor: 'hello' }).ok).toBe(true);
  });

  it('uses stored content once customised, hides disabled items and allows an empty list', () => {
    const items = [
      { id: 'a', collection: 'faqs', sortOrder: 1, enabled: true, data: { question: 'Q2', answer: 'A2' }, updatedAt: ts },
      { id: 'b', collection: 'faqs', sortOrder: 0, enabled: true, data: { question: 'Q1', answer: 'A1' }, updatedAt: ts },
      { id: 'c', collection: 'faqs', sortOrder: 2, enabled: false, data: { question: 'Q3', answer: 'A3' }, updatedAt: ts },
    ];
    expect(resolveSiteContent({ customised: ['faqs'], items }).faqs.map((f) => f['question'])).toEqual(['Q1', 'Q2']);
    expect(resolveSiteContent({ customised: ['faqs'], items: [] }).faqs).toHaveLength(0);
    expect(resolveForAdmin(def('hero'), { customised: [], items: [] }).items[0]?.id).toBe('default-0');
  });

  it('builds safe theme CSS', () => {
    const css = themeCss({ primaryColor: '#112233', bodyFont: 'custom', customBodyFont: 'Foo; } body{display:none', buttonStyle: 'pill', headerStyle: 'dark' });
    expect(css).toContain('--red:#112233');
    expect(css).not.toContain('}body{display');
    expect(themeBodyClass({ buttonStyle: 'pill', headerStyle: 'dark' })).toBe('theme-header-dark theme-button-pill');
    expect(themeCss(defaultSiteContent().theme)).toBe('');
  });

  it('parses card lines and drops unsafe card links', () => {
    expect(parseCards('One | Text | /a\nTwo | Text | javascript:x\n\n')).toEqual([
      { title: 'One', body: 'Text', url: '/a' },
      { title: 'Two', body: 'Text', url: '' },
    ]);
  });
});

describe('site content storage', () => {
  it('runs its steps in order', async () => {
    await env.DB.prepare(
      "INSERT INTO users (id, email, display_name, role, user_type, status, created_at, updated_at) VALUES ('sc-staff', 'sc@example.com', 'SC', 'admin', 'staff', 'active', ?, ?)",
    ).bind(ts, ts).run();

    // Never customised: built-in content.
    expect((await loadSiteContent(env)).faqs).toHaveLength(7);

    // Adding to an uncustomised list seeds the built-ins first, in the same batch.
    const seed = def('faqs').defaults.map((data, i) => ({ id: `s${i}`, sortOrder: i, enabled: true, data: { ...data } }));
    await addItem(env.DB, 'faqs', { id: 'n1', sortOrder: 7, enabled: true, data: { question: 'New?', answer: 'Yes.' } }, seed, 'sc-staff', ts);
    expect(await isCustomised(env.DB, 'faqs')).toBe(true);
    expect(await listStored(env.DB, 'faqs')).toHaveLength(8);

    // Update, hide, reorder, delete.
    expect(await updateItem(env.DB, 'faqs', 'n1', { data: { question: 'Edited?', answer: 'Yes.' } }, 'sc-staff', ts)).toBe(true);
    expect(await updateItem(env.DB, 'faqs', 'missing', { enabled: false }, 'sc-staff', ts)).toBe(false);
    await updateItem(env.DB, 'faqs', 's0', { enabled: false }, 'sc-staff', ts);
    expect((await loadSiteContent(env)).faqs).toHaveLength(7);
    await reorderItems(env.DB, 'faqs', ['n1', ...seed.map((s) => s.id)], 'sc-staff', ts);
    expect((await loadSiteContent(env)).faqs[0]?.['question']).toBe('Edited?');
    expect(await deleteItem(env.DB, 'faqs', 'n1', 'sc-staff', ts)).toBe(true);
    expect((await loadAllStored(env.DB)).customised).toContain('faqs');

    // Singleton save, then reset returns the built-in content and removes the override.
    await seedCollection(env.DB, 'hero', [{ id: 'h1', sortOrder: 0, enabled: true, data: { ...def('hero').defaults[0]!, headline: 'Custom headline' } }], 'sc-staff', ts);
    expect((await loadSiteContent(env)).hero['headline']).toBe('Custom headline');
    await resetCollection(env.DB, 'hero');
    expect((await loadSiteContent(env)).hero['headline']).toBe('Exceptional hospitality assets.');
    expect(await isCustomised(env.DB, 'hero')).toBe(false);
  });
});
