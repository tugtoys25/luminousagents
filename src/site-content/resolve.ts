import { COLLECTIONS, getCollection } from './registry';
import type { CollectionDef, NavItem, Row, SiteContent, StoredItem } from './types';
import { safeUrl } from './fields';

export interface Stored {
  customised: readonly string[];
  items: readonly StoredItem[];
}

export const DEFAULT_ID_PREFIX = 'default-';

/** One collection as the dashboard shows it: stored items when customised, otherwise the built-in ones (ids "default-N"). */
export function resolveForAdmin(def: CollectionDef, stored: Stored): { customised: boolean; items: Array<{ id: string; enabled: boolean; data: Row }> } {
  const customised = stored.customised.includes(def.key);
  if (!customised) return { customised, items: def.defaults.map((data, i) => ({ id: `${DEFAULT_ID_PREFIX}${i}`, enabled: true, data: { ...data } })) };
  const rows = stored.items.filter((i) => i.collection === def.key).sort((a, b) => a.sortOrder - b.sortOrder);
  const base = def.kind === 'singleton' ? (def.defaults[0] ?? {}) : {};
  const items = rows.map((r) => ({ id: r.id, enabled: r.enabled, data: { ...base, ...r.data } }));
  return { customised, items };
}

function singleton(def: CollectionDef, stored: Stored): Row {
  const first = resolveForAdmin(def, stored).items[0];
  return first ? first.data : { ...(def.defaults[0] ?? {}) };
}

function list(key: string, stored: Stored): Row[] {
  const def = getCollection(key);
  if (!def) return [];
  return resolveForAdmin(def, stored).items.filter((i) => i.enabled).map((i) => i.data);
}

/** Navigation links with unsafe or empty entries removed. */
export function cleanNav(rows: Row[]): NavItem[] {
  const out: NavItem[] = [];
  for (const row of rows) {
    const label = typeof row['label'] === 'string' ? row['label'].trim() : '';
    const url = safeUrl(row['url']);
    if (label && url) out.push({ ...row, label, url });
  }
  return out;
}

/** Builds everything the public pages read. Pure: no I/O, so it is trivially testable. */
export function resolveSiteContent(stored: Stored): SiteContent {
  const def = (key: string): CollectionDef => {
    const found = getCollection(key);
    if (!found) throw new Error(`Unknown content collection ${key}`);
    return found;
  };
  return {
    theme: singleton(def('theme'), stored),
    hero: singleton(def('hero'), stored),
    copy: singleton(def('copy'), stored),
    footer: singleton(def('footer'), stored),
    seo: singleton(def('seo'), stored),
    notFound: singleton(def('not_found'), stored),
    trust: list('trust', stored),
    stats: list('stats', stored),
    services: list('services', stored),
    offices: list('offices', stored),
    markets: list('markets', stored),
    faqs: list('faqs', stored),
    navHeader: cleanNav(list('nav_header', stored)),
    navFooterExplore: cleanNav(list('nav_footer_explore', stored)),
    navFooterInfo: cleanNav(list('nav_footer_info', stored)),
    homeSections: list('home_sections', stored),
    customised: COLLECTIONS.filter((c) => stored.customised.includes(c.key)).map((c) => c.key),
  };
}

/** Built-in content, used when the database is unavailable or nothing has been customised. */
export const defaultSiteContent = (): SiteContent => resolveSiteContent({ customised: [], items: [] });
