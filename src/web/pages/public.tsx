import { Hono } from 'hono';
import type { Env } from '../../env';
import { serializeOpportunity, type OpportunityRow } from '../../domain/opportunities/serialize';
import { slugify } from '../../domain/opportunities/slug';
import { BaseLayout } from '../layouts/base';
import { SITE_DESCRIPTION, STATIC_PAGES, staticPageSlug } from '../static-pages';
import { OPPORTUNITY_CARD_SELECT, OpportunityCard } from '../components/opportunity-card';
import {
  ChairmanSection,
  ContactBand,
  ContactLines,
  FaqList,
  FaqSection,
  ServicesGrid,
  ServicesSection,
  StatsBand,
  WorldwideSection,
} from '../components/sections';
import { OFFICES } from '../content/site-content';
import { loadContact, type ContactSettings } from '../site-settings';

const publicPages = new Hono<{
  Bindings: Env;
  Variables: { requestId: string; contact: ContactSettings };
}>();
const SITE_URL = 'https://casinosofmayfair.com';

/** Load contact settings only for HTML page requests (this app is mounted at "/"). */
publicPages.use('*', async (c, next) => {
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
});

publicPages.get('/', async (c) => {
  const contact = c.get('contact');
  let latest: ReturnType<typeof serializeOpportunity>[] = [];
  try {
    const rows = await c.env.DB.prepare(
      `SELECT ${OPPORTUNITY_CARD_SELECT} FROM opportunities WHERE lifecycle = 'published' AND content_review_status = 'approved' AND public_visibility = 1 AND classification = 'public' ORDER BY published_at DESC, title ASC LIMIT 3`,
    ).all<OpportunityRow>();
    latest = rows.results.map((row) => serializeOpportunity(row, 1));
  } catch {
    latest = [];
  }
  return c.html(
    <BaseLayout
      siteUrl={c.env.PUBLIC_BASE_URL || SITE_URL}
      contact={c.get('contact')}
      title="Casinos of Mayfair | Casino & Hospitality Brokerage"
      description={SITE_DESCRIPTION}
    >
      <section class="hero">
        <div class="container hero-grid">
          <div class="hero-copy">
            <span class="eyebrow">
              <span class="eyebrow-line" /> INTERNATIONAL INVESTMENT BROKERAGE
            </span>
            <h1>
              Exceptional hospitality assets. <em>Discreetly connected.</em>
            </h1>
            <p class="hero-lead">
              A specialist brokerage connecting qualified buyers with casino and casino-hotel
              investment opportunities across international markets.
            </p>
            <div class="hero-actions">
              <a class="button button-primary" href="/casinos-for-sale">
                Explore opportunities <span aria-hidden="true">↗</span>
              </a>
              <a class="text-link" href="/contact">
                Speak to our team <span aria-hidden="true">→</span>
              </a>
            </div>
            <div class="hero-note">
              <span class="status-dot" /> Personal, considered service for qualified enquiries
            </div>
          </div>
          <div
            class="hero-art"
            aria-label="Abstract architectural illustration representing a luxury hospitality property"
            role="img"
          >
            <div class="art-sun" />
            <div class="art-building art-building-back" />
            <div class="art-building art-building-front">
              <div class="art-columns" />
              <div class="art-door" />
            </div>
            <div class="art-ground" />
            <div class="art-caption">
              <span>PRIVATE OPPORTUNITY NETWORK</span>
              <strong>Global perspective. Personal service.</strong>
            </div>
          </div>
        </div>
      </section>
      <section class="trust-strip">
        <div class="container trust-grid">
          <div>
            <span class="trust-number">01</span>
            <strong>Specialist focus</strong>
            <span>Casino & hospitality assets</span>
          </div>
          <div>
            <span class="trust-number">02</span>
            <strong>Qualified introductions</strong>
            <span>Buyer-led conversations</span>
          </div>
          <div>
            <span class="trust-number">03</span>
            <strong>Discreet process</strong>
            <span>Information shared appropriately</span>
          </div>
        </div>
      </section>
      <StatsBand />
      <section class="section" id="latest">
        <div class="container">
          <div class="section-head section-head-row">
            <div>
              <span class="eyebrow">LATEST OPPORTUNITIES</span>
              <h2>Recently published listings.</h2>
            </div>
            <a class="text-link" href="/casinos-for-sale">
              View all opportunities <span aria-hidden="true">→</span>
            </a>
          </div>
          {latest.length ? (
            <div class="opportunity-grid opportunity-grid-wide">
              {latest.map((item) => (
                <OpportunityCard item={item} />
              ))}
            </div>
          ) : (
            <div class="empty-state">
              <span class="empty-icon">✦</span>
              <h3>New opportunities are being reviewed</h3>
              <p>
                Listings are published once they have been verified and approved. Contact our team
                to discuss your investment criteria in confidence.
              </p>
              <a class="button button-dark" href="/contact">
                Contact our team
              </a>
            </div>
          )}
        </div>
      </section>
      <section class="section section-muted">
        <div class="container split-section">
          <div>
            <span class="eyebrow">A SPECIALIST APPROACH</span>
            <h2>Clarity at every stage of the conversation.</h2>
          </div>
          <div>
            <p class="section-lead">
              Buying or selling a casino or hospitality asset requires sector understanding, careful
              qualification and a measured approach to confidential information.
            </p>
            <p>
              We help bring the right parties into conversation and coordinate next steps around
              each opportunity, subject to verification, due diligence and applicable requirements.
            </p>
            <a class="text-link" href="/services">
              Discover our services <span aria-hidden="true">→</span>
            </a>
          </div>
        </div>
      </section>
      <ServicesSection />
      <ChairmanSection contact={contact} />
      <WorldwideSection />
      <FaqSection />
      <section class="section">
        <div class="container callout">
          <div>
            <span class="eyebrow">START A CONVERSATION</span>
            <h2>Looking for the right opportunity?</h2>
            <p>
              Tell us about your investment criteria and our team can discuss relevant next steps.
            </p>
          </div>
          <a class="button button-dark" href="/contact">
            Contact our team <span aria-hidden="true">↗</span>
          </a>
        </div>
      </section>
      <ContactBand contact={contact} />
    </BaseLayout>,
  );
});

publicPages.get('/casinos-for-sale', async (c) => {
  const country = (c.req.query('country') ?? '').trim().slice(0, 80);
  const type = (c.req.query('type') ?? '').trim().slice(0, 40);
  const query = (c.req.query('q') ?? '').trim().slice(0, 100);
  const page = Math.max(1, Math.min(1000, Number.parseInt(c.req.query('page') ?? '1', 10) || 1));
  const conditions = [
    "lifecycle = 'published'",
    "content_review_status = 'approved'",
    'public_visibility = 1',
    "classification = 'public'",
  ];
  const binds: (string | number)[] = [];
  if (country) {
    conditions.push('country = ?');
    binds.push(country);
  }
  if (
    type &&
    ['casino', 'casino-hotel', 'hotel', 'resort', 'gaming-venue', 'other'].includes(type)
  ) {
    conditions.push('opportunity_type = ?');
    binds.push(type);
  }
  if (query) {
    conditions.push('(title LIKE ? OR summary LIKE ?)');
    binds.push(`%${query}%`, `%${query}%`);
  }
  const where = conditions.join(' AND ');
  try {
    const countResult = await c.env.DB.prepare(
      `SELECT COUNT(*) AS total FROM opportunities WHERE ${where}`,
    )
      .bind(...binds)
      .first<{ total: number }>();
    const total = countResult?.total ?? 0;
    const rows = await c.env.DB.prepare(
      `SELECT id, slug, title, country, opportunity_type, price_text, lifecycle, summary, availability, points_json, seo_title, seo_description, published_at, classification, labels_json, (SELECT id FROM opportunity_media m WHERE m.opportunity_id = opportunities.id ORDER BY m.sort_order ASC, m.created_at ASC LIMIT 1) AS cover_media_id, (SELECT alt_text FROM opportunity_media ma WHERE ma.id = (SELECT id FROM opportunity_media mb WHERE mb.opportunity_id = opportunities.id ORDER BY mb.sort_order ASC, mb.created_at ASC LIMIT 1)) AS cover_media_alt FROM opportunities WHERE ${where} ORDER BY published_at DESC, title ASC LIMIT 12 OFFSET ?`,
    )
      .bind(...binds, (page - 1) * 12)
      .all<OpportunityRow>();
    const opportunities = rows.results.map((row) => serializeOpportunity(row, 1));
    const countriesResult = await c.env.DB.prepare(
      "SELECT DISTINCT country FROM opportunities WHERE lifecycle = 'published' AND content_review_status = 'approved' AND public_visibility = 1 AND classification = 'public' AND country IS NOT NULL ORDER BY country",
    ).all<{ country: string }>();
    return c.html(
      <BaseLayout
        siteUrl={c.env.PUBLIC_BASE_URL || SITE_URL}
      contact={c.get('contact')}
        title="Casino & Hotel Opportunities | Casinos of Mayfair"
        description="Browse published casino and casino-hotel investment opportunities."
        canonicalPath="/casinos-for-sale"
      >
        <section class="page-hero">
          <div class="container">
            <span class="eyebrow">OPPORTUNITY DIRECTORY</span>
            <h1>Explore opportunities</h1>
            <p>
              Browse currently published opportunities. Further information may be subject to
              qualification and confidentiality requirements.
            </p>
          </div>
        </section>
        <section class="section">
          <div class="container directory-layout">
            <aside class="filters">
              <h2>Refine search</h2>
              <form method="get" action="/casinos-for-sale">
                <label for="q">Keyword</label>
                <input
                  id="q"
                  name="q"
                  type="search"
                  maxLength={100}
                  placeholder="Search opportunities"
                  value={query}
                />
                <label for="country">Market</label>
                <select id="country" name="country">
                  <option value="">All markets</option>
                  {countriesResult.results.map((item) => (
                    <option value={item.country} selected={item.country === country}>
                      {item.country}
                    </option>
                  ))}
                </select>
                <label for="type">Opportunity type</label>
                <select id="type" name="type">
                  <option value="">All types</option>
                  <option value="casino" selected={type === 'casino'}>
                    Casino
                  </option>
                  <option value="casino-hotel" selected={type === 'casino-hotel'}>
                    Casino & hotel
                  </option>
                  <option value="hotel" selected={type === 'hotel'}>
                    Hotel
                  </option>
                  <option value="resort" selected={type === 'resort'}>
                    Resort
                  </option>
                  <option value="gaming-venue" selected={type === 'gaming-venue'}>
                    Gaming venue
                  </option>
                  <option value="other" selected={type === 'other'}>
                    Other asset
                  </option>
                </select>
                <button class="button button-primary filter-submit" type="submit">
                  Apply filters
                </button>
                <a class="reset-link" href="/casinos-for-sale">
                  Clear filters
                </a>
              </form>
            </aside>
            <div class="directory-results">
              <div class="results-heading">
                <div>
                  <span class="eyebrow">CURATED LISTINGS</span>
                  <h2>Available opportunities</h2>
                </div>
                <span class="results-count">
                  {total} {total === 1 ? 'opportunity' : 'opportunities'}
                </span>
              </div>
              {opportunities.length ? (
                <div class="opportunity-grid">
                  {opportunities.map((item) => (
                    <OpportunityCard item={item} />
                  ))}
                </div>
              ) : (
                <div class="empty-state">
                  <span class="empty-icon">✦</span>
                  <h3>New opportunities are being reviewed</h3>
                  <p>
                    Our public directory is updated as listings are verified and approved for
                    publication. Contact our team to discuss your investment criteria.
                  </p>
                  <a class="button button-dark" href="/contact">
                    Contact our team
                  </a>
                </div>
              )}
              {total > 12 && (
                <nav class="pagination" aria-label="Pagination">
                  {page > 1 ? (
                    <a
                      href={`?${new URLSearchParams({ ...(country ? { country } : {}), ...(type ? { type } : {}), ...(query ? { q: query } : {}), page: String(page - 1) }).toString()}`}
                    >
                      ← Previous
                    </a>
                  ) : (
                    <span />
                  )}
                  {page * 12 < total ? (
                    <a
                      href={`?${new URLSearchParams({ ...(country ? { country } : {}), ...(type ? { type } : {}), ...(query ? { q: query } : {}), page: String(page + 1) }).toString()}`}
                    >
                      Next →
                    </a>
                  ) : (
                    <span />
                  )}
                </nav>
              )}
            </div>
          </div>
        </section>
      </BaseLayout>,
    );
  } catch (error) {
    console.error('public_directory_unavailable', {
      requestId: c.get('requestId'),
      errorType: error instanceof Error ? error.name : 'UnknownError',
    });
    return c.html(
      <BaseLayout
        siteUrl={c.env.PUBLIC_BASE_URL || SITE_URL}
      contact={c.get('contact')}
        title="Opportunities | Casinos of Mayfair"
        description="Explore casino and hospitality investment opportunities."
      >
        <section class="section">
          <div class="container empty-state">
            <h1>Directory temporarily unavailable</h1>
            <p>Please try again shortly or contact our team.</p>
            <a class="button button-dark" href="/contact">
              Contact our team
            </a>
          </div>
        </section>
      </BaseLayout>,
      503,
    );
  }
});

publicPages.get('/casinos-for-sale/:country', async (c) => {
  const countrySlug = c.req.param('country').slice(0, 100);
  const countryName = countrySlug
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
  const rows = await c.env.DB.prepare(
    "SELECT id, slug, title, country, opportunity_type, price_text, lifecycle, summary, availability, points_json, seo_title, seo_description, published_at, classification, labels_json, (SELECT id FROM opportunity_media m WHERE m.opportunity_id = opportunities.id ORDER BY m.sort_order ASC, m.created_at ASC LIMIT 1) AS cover_media_id, (SELECT alt_text FROM opportunity_media ma WHERE ma.id = (SELECT id FROM opportunity_media mb WHERE mb.opportunity_id = opportunities.id ORDER BY mb.sort_order ASC, mb.created_at ASC LIMIT 1)) AS cover_media_alt FROM opportunities WHERE lower(country) = lower(?) AND lifecycle = 'published' AND content_review_status = 'approved' AND public_visibility = 1 AND classification = 'public' ORDER BY published_at DESC, title ASC LIMIT 100",
  )
    .bind(countryName)
    .all<OpportunityRow>();
  const items = rows.results.map((row) => serializeOpportunity(row, 1));
  return c.html(
    <BaseLayout
      siteUrl={c.env.PUBLIC_BASE_URL || SITE_URL}
      contact={c.get('contact')}
      title={`Casino Opportunities in ${countryName} | Casinos of Mayfair`}
      description={`Explore verified public casino and hospitality opportunities in ${countryName}.`}
      canonicalPath={`/casinos-for-sale/${encodeURIComponent(countrySlug)}`}
    >
      <section class="page-hero">
        <div class="container">
          <span class="eyebrow">MARKET OVERVIEW</span>
          <h1>Opportunities in {countryName}</h1>
          <p>
            Publicly approved opportunities for this market. Further information may be subject to
            qualification and confidentiality requirements.
          </p>
        </div>
      </section>
      <section class="section">
        <div class="container">
          <div class="results-heading">
            <div>
              <span class="eyebrow">CURRENTLY PUBLISHED</span>
              <h2>{countryName}</h2>
            </div>
            <span class="results-count">
              {items.length} {items.length === 1 ? 'opportunity' : 'opportunities'}
            </span>
          </div>
          {items.length ? (
            <div class="opportunity-grid opportunity-grid-wide">
              {items.map((item) => (
                <OpportunityCard item={item} />
              ))}
            </div>
          ) : (
            <div class="empty-state">
              <h3>No publicly approved opportunities in this market</h3>
              <p>
                Listings are published only after review. Contact our team to discuss your
                investment criteria.
              </p>
              <a class="button button-dark" href="/contact">
                Contact our team
              </a>
            </div>
          )}
        </div>
      </section>
    </BaseLayout>,
  );
});

publicPages.get('/casino-hotels', async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT id, slug, title, country, opportunity_type, price_text, lifecycle, summary, availability, points_json, seo_title, seo_description, published_at, classification, labels_json, (SELECT id FROM opportunity_media m WHERE m.opportunity_id = opportunities.id ORDER BY m.sort_order ASC, m.created_at ASC LIMIT 1) AS cover_media_id, (SELECT alt_text FROM opportunity_media ma WHERE ma.id = (SELECT id FROM opportunity_media mb WHERE mb.opportunity_id = opportunities.id ORDER BY mb.sort_order ASC, mb.created_at ASC LIMIT 1)) AS cover_media_alt FROM opportunities WHERE opportunity_type = 'casino-hotel' AND lifecycle = 'published' AND content_review_status = 'approved' AND public_visibility = 1 AND classification = 'public' ORDER BY published_at DESC, title ASC LIMIT 100",
  ).all<OpportunityRow>();
  const items = rows.results.map((row) => serializeOpportunity(row, 1));
  return c.html(
    <BaseLayout
      siteUrl={c.env.PUBLIC_BASE_URL || SITE_URL}
      contact={c.get('contact')}
      title="Casino Hotels for Sale | Casinos of Mayfair"
      description="Explore publicly approved casino-hotel investment opportunities."
      canonicalPath="/casino-hotels"
    >
      <section class="page-hero">
        <div class="container">
          <span class="eyebrow">SPECIALIST ASSETS</span>
          <h1>Casino & hotel opportunities</h1>
          <p>
            Explore publicly approved casino-hotel opportunities for qualified buyers and operators.
          </p>
        </div>
      </section>
      <section class="section">
        <div class="container">
          {items.length ? (
            <div class="opportunity-grid opportunity-grid-wide">
              {items.map((item) => (
                <OpportunityCard item={item} />
              ))}
            </div>
          ) : (
            <div class="empty-state">
              <h2>Opportunities are being reviewed</h2>
              <p>New listings are published after verification and content review.</p>
              <a class="button button-dark" href="/contact">
                Discuss your criteria
              </a>
            </div>
          )}
        </div>
      </section>
    </BaseLayout>,
  );
});

publicPages.get('/archive', async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT id, slug, title, country, opportunity_type, price_text, lifecycle, summary, availability, points_json, seo_title, seo_description, published_at, classification, labels_json, (SELECT id FROM opportunity_media m WHERE m.opportunity_id = opportunities.id ORDER BY m.sort_order ASC, m.created_at ASC LIMIT 1) AS cover_media_id, (SELECT alt_text FROM opportunity_media ma WHERE ma.id = (SELECT id FROM opportunity_media mb WHERE mb.opportunity_id = opportunities.id ORDER BY mb.sort_order ASC, mb.created_at ASC LIMIT 1)) AS cover_media_alt FROM opportunities WHERE lifecycle IN ('sold','off_market') AND content_review_status = 'approved' AND public_visibility = 1 AND classification = 'public' ORDER BY updated_at DESC LIMIT 100",
  ).all<OpportunityRow>();
  const items = rows.results.map((row) => serializeOpportunity(row, 1));
  return c.html(
    <BaseLayout
      siteUrl={c.env.PUBLIC_BASE_URL || SITE_URL}
      contact={c.get('contact')}
      title="Past Opportunities | Casinos of Mayfair"
      description="Selected past opportunities, where approved for public display."
      canonicalPath="/archive"
    >
      <section class="page-hero">
        <div class="container">
          <span class="eyebrow">PAST OPPORTUNITIES</span>
          <h1>Archive</h1>
          <p>Selected past opportunities are shown only where approved for public display.</p>
        </div>
      </section>
      <section class="section">
        <div class="container">
          {items.length ? (
            <div class="opportunity-grid opportunity-grid-wide">
              {items.map((item) => (
                <OpportunityCard item={item} variant="archive" />
              ))}
            </div>
          ) : (
            <div class="empty-state">
              <h2>No archive listings are currently public</h2>
              <p>Past records remain private unless reviewed and approved for publication.</p>
            </div>
          )}
        </div>
      </section>
    </BaseLayout>,
  );
});

publicPages.get('/opportunities/:slug', async (c) => {
  const slug = c.req.param('slug').slice(0, 110);
  const row = await c.env.DB.prepare(
    "SELECT id, slug, title, country, opportunity_type, price_text, lifecycle, summary, availability, points_json, seo_title, seo_description, published_at, classification, labels_json, (SELECT id FROM opportunity_media m WHERE m.opportunity_id = opportunities.id ORDER BY m.sort_order ASC, m.created_at ASC LIMIT 1) AS cover_media_id, (SELECT alt_text FROM opportunity_media ma WHERE ma.id = (SELECT id FROM opportunity_media mb WHERE mb.opportunity_id = opportunities.id ORDER BY mb.sort_order ASC, mb.created_at ASC LIMIT 1)) AS cover_media_alt FROM opportunities WHERE slug = ? AND lifecycle = 'published' AND content_review_status = 'approved' AND public_visibility = 1 AND classification = 'public' LIMIT 1",
  )
    .bind(slug)
    .first<OpportunityRow>();
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
  const item = serializeOpportunity(row, 1);
  return c.html(
    <BaseLayout
      siteUrl={c.env.PUBLIC_BASE_URL || SITE_URL}
      contact={c.get('contact')}
      title={`${item.seoTitle} | Casinos of Mayfair`}
      description={item.seoDescription}
      canonicalPath={`/opportunities/${encodeURIComponent(item.slug)}`}
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

publicPages.get('/contact', (c) => {
  const opportunity = (c.req.query('opportunity') ?? '').trim().slice(0, 120);
  const submitted = c.req.query('submitted') === '1';
  const error = c.req.query('error') ?? '';
  const notice = submitted ? (
    <div class="form-notice" role="status">
      Thank you. Your enquiry has been received for review. Please do not send confidential
      documents through this form.
    </div>
  ) : error ? (
    <div class="form-error" role="alert">
      Some required fields were missing or the security check failed. Please review the form and try
      again.
    </div>
  ) : null;
  return c.html(
    <BaseLayout
      siteUrl={c.env.PUBLIC_BASE_URL || SITE_URL}
      contact={c.get('contact')}
      title="Contact Our Team | Casinos of Mayfair"
      description="Contact the Casinos of Mayfair team about casino and hospitality investment opportunities."
      canonicalPath="/contact"
    >
      <section class="page-hero">
        <div class="container">
          <span class="eyebrow">CASINOS OF MAYFAIR</span>
          <h1>Start a conversation</h1>
          <p>
            Call, email or message us directly, or send an enquiry below. Please do not include
            passwords, identity documents or confidential deal materials.
          </p>
        </div>
      </section>
      <section class="section">
        <div class="container contact-layout">
          <div class="contact-main">
          {notice}
          <form class="contact-form" method="post" action="/api/enquiries">
            <label for="contact-name">Full name *</label>
            <input
              id="contact-name"
              name="name"
              required
              minLength={2}
              maxLength={120}
              autoComplete="name"
            />
            <label for="contact-email">Business email *</label>
            <input
              id="contact-email"
              name="email"
              type="email"
              required
              maxLength={254}
              autoComplete="email"
            />
            <label for="contact-company">Company</label>
            <input
              id="contact-company"
              name="company"
              maxLength={160}
              autoComplete="organization"
            />
            <label for="contact-message">How can we help? *</label>
            <textarea
              id="contact-message"
              name="message"
              required
              minLength={10}
              maxLength={5000}
              rows={6}
            ></textarea>
            <input type="hidden" name="opportunity" value={opportunity} />
            <div class="honeypot" aria-hidden="true">
              <label for="contact-website">Leave this field empty</label>
              <input id="contact-website" name="website" tabIndex={-1} autoComplete="off" />
            </div>
            {c.env.TURNSTILE_SITE_KEY && (
              <div class="turnstile-widget">
                <div class="cf-turnstile" data-sitekey={c.env.TURNSTILE_SITE_KEY}></div>
              </div>
            )}
            <label class="consent-label">
              <input type="checkbox" name="consent" required /> I agree that Casinos of Mayfair may
              use these details to respond to my enquiry. *
            </label>
            <p class="form-privacy">
              Please read our <a href="/legal/privacy">privacy notice</a>. This form is for initial
              contact only and is not a secure document-transfer channel.
            </p>
            <button class="button button-primary" type="submit">
              Send enquiry <span aria-hidden="true">→</span>
            </button>
            {c.env.TURNSTILE_SITE_KEY && (
              <script
                src="https://challenges.cloudflare.com/turnstile/v0/api.js"
                async
                defer
              ></script>
            )}
            <script src="/static/js/contact-form.js" defer></script>
          </form>
          </div>
          <aside class="contact-aside" aria-label="Direct contact details">
            <span class="eyebrow">DIRECT CONTACT</span>
            <h2>Speak with the Chairman</h2>
            <p>
              For any casino for sale, casino hotel, management or consulting requirement. Enquiries
              are treated in strict confidence.
            </p>
            <ContactLines contact={c.get('contact')} />
            {c.get('contact').whatsapp.replace(/[^0-9]/g, '').length >= 8 && (
              <a
                class="button button-whatsapp"
                href={`https://wa.me/${c.get('contact').whatsapp.replace(/[^0-9]/g, '')}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                Chat on WhatsApp <span aria-hidden="true">↗</span>
              </a>
            )}
            <div class="contact-offices">
              <strong>Offices</strong>
              <ul>
                {OFFICES.map(([name]) => (
                  <li>{name}</li>
                ))}
              </ul>
            </div>
            <p class="contact-note">
              Please do not send passwords, identity documents or confidential deal materials
              through the form or by email.
            </p>
          </aside>
        </div>
      </section>
    </BaseLayout>,
  );
});

publicPages.get('/staff-access', (c) =>
  c.html(
    <BaseLayout
      siteUrl={c.env.PUBLIC_BASE_URL || SITE_URL}
      contact={c.get('contact')}
      title="Staff access | Casinos of Mayfair"
      description="How Casinos of Mayfair staff accounts are created."
      canonicalPath="/staff-access"
      noindex
    >
      <section class="page-hero">
        <div class="container">
          <span class="eyebrow">STAFF ACCESS</span>
          <h1>Staff accounts are invitation-only</h1>
          <p>
            Brokers, editors and administrators are set up by a Casinos of Mayfair administrator.
            There is no public staff sign-up.
          </p>
        </div>
      </section>
      <section class="section">
        <div class="container content-narrow">
          <h2>Already invited?</h2>
          <p>Sign in with your staff email and password.</p>
          <a class="button button-primary" href="/admin/login">
            Staff sign in
          </a>
          <h2>Need an account?</h2>
          <p>
            Ask an administrator to provision your account, or send us a message and we will pass
            your request on. If you are a buyer or investor, register a buyer account instead.
          </p>
          <div class="hero-actions">
            <a class="button button-dark" href="/contact">
              Contact our team
            </a>
            <a class="text-link" href="/register">
              Register as a buyer <span aria-hidden="true">→</span>
            </a>
          </div>
        </div>
      </section>
    </BaseLayout>,
  ),
);

for (const [path, title, description, heading, copy] of STATIC_PAGES) {
  publicPages.get(path, async (c) => {
    const override = await c.env.DB.prepare(
      "SELECT title, description, body_markdown AS body, seo_title AS seoTitle, seo_description AS seoDescription FROM managed_pages WHERE slug = ? AND status = 'published' LIMIT 1",
    )
      .bind(staticPageSlug(path))
      .first<{
        title: string;
        description: string;
        body: string;
        seoTitle: string;
        seoDescription: string;
      }>();
    if (override) {
      const paragraphs = override.body
        .split(/\r?\n\s*\r?\n/)
        .map((part) => part.trim())
        .filter(Boolean);
      return c.html(
        <BaseLayout
          siteUrl={c.env.PUBLIC_BASE_URL || SITE_URL}
      contact={c.get('contact')}
          title={`${override.seoTitle || override.title} | Casinos of Mayfair`}
          description={override.seoDescription || override.description || description}
          canonicalPath={path}
        >
          <section class="page-hero">
            <div class="container">
              <span class="eyebrow">CASINOS OF MAYFAIR</span>
              <h1>{override.title}</h1>
              {override.description && <p>{override.description}</p>}
            </div>
          </section>
          <section class="section">
            <div class="container content-narrow">
              {paragraphs.map((part) => (
                <p style="white-space:pre-line">{part}</p>
              ))}
              <a class="button button-dark" href="/contact">
                Contact our team
              </a>
            </div>
          </section>
        </BaseLayout>,
      );
    }
    return c.html(
      <BaseLayout
        siteUrl={c.env.PUBLIC_BASE_URL || SITE_URL}
      contact={c.get('contact')}
        title={`${title} | Casinos of Mayfair`}
        description={description}
        canonicalPath={path}
      >
        <section class="page-hero">
          <div class="container">
            <span class="eyebrow">CASINOS OF MAYFAIR</span>
            <h1>{heading}</h1>
            <p>{copy}</p>
          </div>
        </section>
        {path === '/services' && (
          <section class="section">
            <div class="container">
              <ServicesGrid />
            </div>
          </section>
        )}
        {path === '/about' && (
          <>
            <StatsBand />
            <ChairmanSection contact={c.get('contact')} />
            <WorldwideSection />
          </>
        )}
        {path === '/faq' && (
          <section class="section">
            <div class="container content-narrow-wide">
              <FaqList />
            </div>
          </section>
        )}
        <section class="section">
          <div class="container content-narrow">
            {path !== '/faq' && (
              <>
                <h2>How we work</h2>
                <p>
                  We aim to provide a professional and considered introduction process. No
                  information on this website should be treated as an offer, recommendation or
                  guarantee of investment outcome.
                </p>
              </>
            )}
            <a class="button button-dark" href="/contact">
              Contact our team
            </a>
          </div>
        </section>
      </BaseLayout>,
    );
  });
}

publicPages.get('/media/opportunities/:opportunityId/:mediaId', async (c) => {
  const media = await c.env.DB.prepare(
    "SELECT m.r2_key AS r2Key, m.content_type AS contentType, m.byte_size AS byteSize, m.sha256 AS sha256 FROM opportunity_media m JOIN opportunities o ON o.id = m.opportunity_id WHERE m.id = ? AND m.opportunity_id = ? AND o.lifecycle = 'published' AND o.content_review_status = 'approved' AND o.public_visibility = 1 AND o.classification = 'public' AND m.content_type IN ('image/jpeg','image/png') LIMIT 1",
  )
    .bind(c.req.param('mediaId'), c.req.param('opportunityId'))
    .first<{ r2Key: string; contentType: string; byteSize: number; sha256: string }>();
  if (!media) return c.notFound();
  const file = await c.env.PRIVATE_FILES.get(media.r2Key);
  if (!file || file.size !== media.byteSize || file.size > 8 * 1024 * 1024) return c.notFound();
  const bytes = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const actual = [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
  if (!media.sha256 || actual !== media.sha256) return c.notFound();
  c.header('Content-Type', media.contentType);
  c.header('Cache-Control', 'public, max-age=300');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Content-Length', String(bytes.byteLength));
  return c.body(bytes, 200);
});

publicPages.get('/robots.txt', (c) => {
  const baseUrl = (c.env.PUBLIC_BASE_URL || SITE_URL).replace(/\/$/, '');
  return c.text(
    `User-agent: *\nAllow: /\nDisallow: /dashboard/\nDisallow: /account/\nDisallow: /api/\nDisallow: /admin/\nDisallow: /register\nSitemap: ${baseUrl}/sitemap.xml\n`,
    200,
    { 'Content-Type': 'text/plain; charset=utf-8' },
  );
});
publicPages.get('/sitemap.xml', async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT slug FROM opportunities WHERE lifecycle = 'published' AND content_review_status = 'approved' AND public_visibility = 1 AND classification = 'public' ORDER BY updated_at DESC LIMIT 5000",
  ).all<{ slug: string }>();
  const countries = await c.env.DB.prepare(
    "SELECT DISTINCT country FROM opportunities WHERE lifecycle = 'published' AND content_review_status = 'approved' AND public_visibility = 1 AND classification = 'public' AND country IS NOT NULL ORDER BY country",
  ).all<{ country: string }>();
  const managedPages = await c.env.DB.prepare(
    "SELECT slug FROM managed_pages WHERE status = 'published' ORDER BY updated_at DESC LIMIT 500",
  ).all<{ slug: string }>();
  const countryPaths = countries.results.map(
    (row) => `/casinos-for-sale/${encodeURIComponent(slugify(row.country))}`,
  );
  const baseUrl = (c.env.PUBLIC_BASE_URL || SITE_URL).replace(/\/$/, '');
  const paths = [
    '/',
    '/casinos-for-sale',
    '/casino-hotels',
    '/archive',
    '/services',
    '/about',
    '/faq',
    '/contact',
    '/legal/privacy',
    '/legal/terms',
    '/legal/cookies',
    '/legal/aml-kyc',
    '/legal/sanctions',
    '/legal/anti-bribery',
    '/legal/complaints',
    '/legal/disclaimer',
    '/legal/modern-slavery',
    ...managedPages.results.map((row) => `/pages/${encodeURIComponent(row.slug)}`),
    ...countryPaths,
    ...rows.results.map((row) => `/opportunities/${encodeURIComponent(row.slug)}`),
  ];
  const xml = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths.map((path) => `<url><loc>${baseUrl}${path}</loc></url>`).join('')}</urlset>`;
  return c.body(xml, 200, {
    'Content-Type': 'application/xml; charset=utf-8',
    'Cache-Control': 'public, max-age=300',
  });
});

export default publicPages;
