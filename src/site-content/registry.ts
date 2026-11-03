import { HOME_COLLECTIONS } from './registry-home';
import { LIST_COLLECTIONS } from './registry-lists';
import { SITE_COLLECTIONS } from './registry-site';
import { THEME_COLLECTION } from './registry-theme';
import type { CollectionDef } from './types';

/** Every staff-editable collection, in dashboard order. */
export const COLLECTIONS: readonly CollectionDef[] = [
  ...HOME_COLLECTIONS,
  ...LIST_COLLECTIONS,
  ...SITE_COLLECTIONS.filter((c) => c.group === 'Navigation'),
  THEME_COLLECTION,
  ...SITE_COLLECTIONS.filter((c) => c.group === 'Search and footer'),
];

const BY_KEY = new Map(COLLECTIONS.map((c) => [c.key, c]));
export const getCollection = (key: string): CollectionDef | undefined => BY_KEY.get(key);
