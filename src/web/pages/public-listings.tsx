import { Hono } from 'hono';
import { serializeOpportunity } from '../../domain/opportunities/serialize';
import { BaseLayout } from '../layouts/base';
import { OpportunityCard } from '../components/opportunity-card';
import { archivedListings, casinoHotelListings, listingsByCountry, searchCatalogue } from '../public-listings-repo';
import { itemListLd, webPageLd } from '../seo';
import type { PublicApp } from './public-shared';
import { SITE_URL } from './public-shared';

const publicPages = new Hono<PublicApp>();

publicPages.get('/casinos-for-sale', async (c) => {
  const country = (c.req.query('country') ?? '').trim().slice(0, 80);
  const type = (c.req.query('type') ?? '').trim().slice(0, 40);
  const query = (c.req.query('q') ?? '').trim().slice(0, 100);
  const sortParam = c.req.query('sort') ?? '';
  const sort = sortParam === 'title' || sortParam === 'country' ? sortParam : 'newest';
  const page = Math.max(1, Math.min(1000, Number.parseInt(c.req.query('page') ?? '1', 10) || 1));
  try {
    const { total, rows, countries } = await searchCatalogue(c.env.DB, { country, type, query, sort, page });
    const opportunities = rows.map((row) => serializeOpportunity(row, 0));
    return c.html(
      <BaseLayout
        siteUrl={c.env.PUBLIC_BASE_URL || SITE_URL}
        contact={c.get('contact')}
        title="Casino & Hotel Opportunities | Casinos of Mayfair"
        description="Browse published casino and casino-hotel investment opportunities."
        canonicalPath="/casinos-for-sale"
        jsonLd={[
          webPageLd(
            (c.env.PUBLIC_BASE_URL || SITE_URL).replace(/\/$/, ''),
            '/casinos-for-sale',
            'Casino & Hotel Opportunities',
            'Browse published casino and casino-hotel investment opportunities.',
            'CollectionPage',
          ),
          itemListLd(
            (c.env.PUBLIC_BASE_URL || SITE_URL).replace(/\/$/, ''),
            'Casino and hotel opportunities',
            opportunities,
          ),
        ]}
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
                  {countries.map((item) => (
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
                <label for="sort">Sort by</label>
                <select id="sort" name="sort">
                  <option value="newest" selected={sort === 'newest'}>Recently published</option>
                  <option value="title" selected={sort === 'title'}>Title A–Z</option>
                  <option value="country" selected={sort === 'country'}>Market A–Z</option>
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
                      href={`?${new URLSearchParams({ ...(country ? { country } : {}), ...(type ? { type } : {}), ...(query ? { q: query } : {}), ...(sort !== 'newest' ? { sort } : {}), page: String(page - 1) }).toString()}`}
                    >
                      ← Previous
                    </a>
                  ) : (
                    <span />
                  )}
                  {page * 12 < total ? (
                    <a
                      href={`?${new URLSearchParams({ ...(country ? { country } : {}), ...(type ? { type } : {}), ...(query ? { q: query } : {}), ...(sort !== 'newest' ? { sort } : {}), page: String(page + 1) }).toString()}`}
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
  const rows = await listingsByCountry(c.env.DB, countryName);
  const items = rows.map((row) => serializeOpportunity(row, 0));
  return c.html(
    <BaseLayout
      siteUrl={c.env.PUBLIC_BASE_URL || SITE_URL}
      contact={c.get('contact')}
      title={`Casino Opportunities in ${countryName} | Casinos of Mayfair`}
      description={`Explore verified public casino and hospitality opportunities in ${countryName}.`}
      canonicalPath={`/casinos-for-sale/${encodeURIComponent(countrySlug)}`}
      crumbs={[{ name: 'Opportunities', path: '/casinos-for-sale' }, { name: countryName }]}
      jsonLd={[
        itemListLd(
          (c.env.PUBLIC_BASE_URL || SITE_URL).replace(/\/$/, ''),
          `Casino opportunities in ${countryName}`,
          items,
        ),
      ]}
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
  const rows = await casinoHotelListings(c.env.DB);
  const items = rows.map((row) => serializeOpportunity(row, 0));
  return c.html(
    <BaseLayout
      siteUrl={c.env.PUBLIC_BASE_URL || SITE_URL}
      contact={c.get('contact')}
      title="Casino Hotels for Sale | Casinos of Mayfair"
      description="Explore publicly approved casino-hotel investment opportunities."
      canonicalPath="/casino-hotels"
      crumbs={[{ name: 'Opportunities', path: '/casinos-for-sale' }, { name: 'Casino hotels' }]}
      jsonLd={[
        itemListLd((c.env.PUBLIC_BASE_URL || SITE_URL).replace(/\/$/, ''), 'Casino hotels', items),
      ]}
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
  const rows = await archivedListings(c.env.DB);
  const items = rows.map((row) => serializeOpportunity(row, 0));
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


export default publicPages;
