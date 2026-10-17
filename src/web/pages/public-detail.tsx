import { Hono } from 'hono';
import { serializeOpportunity } from '../../domain/opportunities/serialize';
import { BaseLayout } from '../layouts/base';
import { findPublicListing } from '../public-listings-repo';
import { webPageLd } from '../seo';
import type { PublicApp } from './public-shared';
import { SITE_URL } from './public-shared';

const publicPages = new Hono<PublicApp>();

publicPages.get('/opportunities/:slug', async (c) => {
  const slug = c.req.param('slug').slice(0, 110);
  const row = await findPublicListing(c.env.DB, slug);
  if (!row)
    return c.html(
      <BaseLayout
        siteUrl={c.env.PUBLIC_BASE_URL || SITE_URL}
        contact={c.get('contact')}
        title="Opportunity not found | Casinos of Mayfair"
        description="This opportunity may no longer be available."
      >
        <section class="section">
          <div class="container empty-state">
            <h1>Opportunity not found</h1>
            <p>This listing may have been withdrawn or is no longer available publicly.</p>
            <a class="button button-dark" href="/casinos-for-sale">
              Back to opportunities
            </a>
          </div>
        </section>
      </BaseLayout>,
      404,
    );
  const item = serializeOpportunity(row, 0);
  return c.html(
    <BaseLayout
      siteUrl={c.env.PUBLIC_BASE_URL || SITE_URL}
      contact={c.get('contact')}
      title={`${item.seoTitle} | Casinos of Mayfair`}
      description={item.seoDescription}
      image={item.coverMediaPath}
      imageAlt={item.coverMediaAlt}
      canonicalPath={`/opportunities/${encodeURIComponent(item.slug)}`}
      crumbs={[{ name: 'Opportunities', path: '/casinos-for-sale' }, { name: item.title }]}
      jsonLd={[
        webPageLd(
          (c.env.PUBLIC_BASE_URL || SITE_URL).replace(/\/$/, ''),
          `/opportunities/${encodeURIComponent(item.slug)}`,
          item.title,
          item.seoDescription,
        ),
      ]}
    >
      <section class="page-hero">
        <div class="container">
          <a class="back-link" href="/casinos-for-sale">
            ← All opportunities
          </a>
          {item.coverMediaPath && (
            <img
              class="detail-cover"
              src={item.coverMediaPath}
              alt={item.coverMediaAlt}
              loading="eager"
              decoding="async"
              {...{ fetchpriority: 'high' }}
            />
          )}
          <div class="detail-meta">
            <span class="card-type">
              {item.type === 'casino-hotel' ? 'CASINO & HOTEL' : item.type.toUpperCase()}
            </span>
            <span>{item.country ?? 'International market'}</span>
          </div>
          <h1>{item.title}</h1>
          <div class="card-labels">
            {item.labels.map((label) => (
              <span>{label}</span>
            ))}
          </div>
          <p>{item.summary || 'Further information is available to qualified parties.'}</p>
        </div>
      </section>
      <section class="section">
        <div class="container detail-layout">
          <div class="detail-main">
            <span class="eyebrow">OVERVIEW</span>
            <h2>About this opportunity</h2>
            <p>
              {item.summary ||
                'This opportunity is being presented for consideration by qualified buyers. Additional information may be available following an initial conversation and appropriate confidentiality arrangements.'}
            </p>
            {item.points.length > 0 && (
              <>
                <h3>Key information</h3>
                <ul class="feature-list">
                  {item.points.map((point) => (
                    <li>{point}</li>
                  ))}
                </ul>
              </>
            )}
            <p class="confidentiality-note">
              Detailed location, ownership and supporting documents are not displayed publicly.
              Information is subject to verification and appropriate disclosure.
            </p>
          </div>
          <aside class="detail-sidebar">
            <span class="eyebrow">ENQUIRIES</span>
            <h2>Interested in learning more?</h2>
            <p>Tell us about your interest and our team will review your enquiry.</p>
            <a
              class="button button-primary button-full"
              href={`/contact?opportunity=${encodeURIComponent(item.slug)}`}
            >
              Enquire about this listing
            </a>
            <a
              class="button button-dark button-full"
              href={`/account?opportunity=${encodeURIComponent(item.slug)}`}
            >
              Request confidential access
            </a>
            <div class="sidebar-rule" />
            <span class="sidebar-label">INDICATIVE PRICE</span>
            <strong class="price-value">{item.price ?? 'Price on request'}</strong>
            <span class="sidebar-label">MARKET</span>
            <strong>{item.country ?? 'International'}</strong>
          </aside>
        </div>
      </section>
    </BaseLayout>,
  );
});


export default publicPages;
