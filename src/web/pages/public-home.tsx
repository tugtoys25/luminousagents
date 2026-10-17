import { Hono } from 'hono';
import { serializeOpportunity } from '../../domain/opportunities/serialize';
import { BaseLayout } from '../layouts/base';
import { SITE_DESCRIPTION } from '../static-pages';
import { OpportunityCard } from '../components/opportunity-card';
import { latestListings } from '../public-listings-repo';
import { ChairmanSection, ContactBand, FaqSection, ServicesSection, StatsBand, WorldwideSection } from '../components/sections';
import type { PublicApp } from './public-shared';
import { SITE_URL } from './public-shared';

const publicPages = new Hono<PublicApp>();

publicPages.get('/', async (c) => {
  const contact = c.get('contact');
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


export default publicPages;
