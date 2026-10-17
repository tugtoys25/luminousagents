import type { Context } from 'hono';
import type { Env } from '../../env';
import type { ContactSettings } from '../site-settings';
import { loadContact } from '../site-settings';

export type PublicApp = {
  Bindings: Env;
  Variables: { requestId: string; contact: ContactSettings };
};
export const SITE_URL = 'https://casinosofmayfair.com';

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
  if (isPage) c.set('contact', await loadContact(c.env));
  await next();
};
