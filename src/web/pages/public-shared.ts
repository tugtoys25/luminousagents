import type { Context } from 'hono';
import type { Env } from '../../env';
import type { ContactSettings } from '../site-settings';
import { loadContact } from '../site-settings';
import { loadSiteContent } from '../../site-content/load';
import type { SiteContent } from '../../site-content/types';

export type PublicApp = {
  Bindings: Env;
  Variables: { requestId: string; contact: ContactSettings; content: SiteContent };
};
import { BRAND } from '../../brand/defaults';
export const SITE_URL: string = BRAND.siteUrl;

/** Load contact settings only for HTML page requests (this app is mounted at "/"). */
export const loadContactForPages = async (
  c: Context<PublicApp>,
  next: () => Promise<void>,
) => {
  const path = c.req.path;
  const isPage =
    c.req.method === 'GET' &&
    !path.startsWith('/api/') &&
    !path.startsWith('/dashboard') &&
    !path.startsWith('/account') &&
    !path.startsWith('/media/') &&
    path !== '/robots.txt' &&
    path !== '/sitemap.xml';
  if (isPage) {
    const [contact, content] = await Promise.all([loadContact(c.env), loadSiteContent(c.env)]);
    c.set('contact', contact);
    c.set('content', content);
  }
  await next();
};
