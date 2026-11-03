import type { Env } from '../env';
import { defaultSiteContent, resolveSiteContent } from './resolve';
import { loadAllStored } from './site-content-repo';
import type { SiteContent } from './types';

/** Loads staff-managed content. Any failure (for example the migration is not applied yet) falls back to the built-in content. */
export async function loadSiteContent(env: Env): Promise<SiteContent> {
  try {
    return resolveSiteContent(await loadAllStored(env.DB));
  } catch {
    return defaultSiteContent();
  }
}
