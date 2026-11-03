import { Hono } from 'hono';
import { serializeOpportunity } from '../../domain/opportunities/serialize';
import { BaseLayout } from '../layouts/base';
import { latestListings } from '../public-listings-repo';
import { HomeSections } from '../components/home-blocks';
import type { PublicApp } from './public-shared';
import { SITE_URL } from './public-shared';
import { text } from '../components/escape';

const publicPages = new Hono<PublicApp>();

publicPages.get('/', async (c) => {
  const contact = c.get('contact');
  const content = c.get('content');
  let latest: ReturnType<typeof serializeOpportunity>[] = [];
  try {
    const rows = await latestListings(c.env.DB, 3);
    latest = rows.map((row) => serializeOpportunity(row, 0));
  } catch {
    latest = [];
  }
  return c.html(
    <BaseLayout
      siteUrl={c.env.PUBLIC_BASE_URL || SITE_URL}
      contact={contact}
      content={content}
      title={text(content.seo, 'homeTitle')}
      description={text(content.seo, 'homeDescription')}
      image={text(content.seo, 'shareImage') || null}
      imageAlt={text(content.seo, 'shareImageAlt')}
    >
      <HomeSections content={content} contact={contact} latest={latest} />
    </BaseLayout>,
  );
});

export default publicPages;
