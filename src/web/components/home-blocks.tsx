import type { serializeOpportunity } from '../../domain/opportunities/serialize';
import type { ContactSettings } from '../site-settings';
import type { SiteContent } from '../../site-content/types';
import { OpportunityCard } from './opportunity-card';
import { ChairmanSection, ContactBand, FaqSection, ServicesSection, StatsBand, TrustStrip, WorldwideSection } from './sections';
import { CustomSection } from './custom-section';
import { Hero } from './hero';
import { text } from './escape';

type Latest = ReturnType<typeof serializeOpportunity>[];
interface Props {
  content: SiteContent;
  contact: ContactSettings;
  latest: Latest;
}

function LatestSection({ content, latest }: { content: SiteContent; latest: Latest }) {
  const c = content.copy;
  return (
    <section class="section" id="latest">
      <div class="container">
        <div class="section-head section-head-row">
          <div>
            {text(c, 'latestEyebrow') && <span class="eyebrow">{text(c, 'latestEyebrow')}</span>}
            {text(c, 'latestHeading') && <h2>{text(c, 'latestHeading')}</h2>}
          </div>
          {text(c, 'latestLink') && (
            <a class="text-link" href="/casinos-for-sale">
              {text(c, 'latestLink')} <span aria-hidden="true">→</span>
            </a>
          )}
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
            <h3>{text(c, 'emptyTitle')}</h3>
            <p>{text(c, 'emptyBody')}</p>
            {text(c, 'emptyButton') && (
              <a class="button button-dark" href="/contact">
                {text(c, 'emptyButton')}
              </a>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function ApproachSection({ content }: { content: SiteContent }) {
  const c = content.copy;
  return (
    <section class="section section-muted">
      <div class="container split-section">
        <div>
          {text(c, 'approachEyebrow') && <span class="eyebrow">{text(c, 'approachEyebrow')}</span>}
          <h2>{text(c, 'approachHeading')}</h2>
        </div>
        <div>
          {text(c, 'approachLead') && <p class="section-lead">{text(c, 'approachLead')}</p>}
          {text(c, 'approachBody') && <p>{text(c, 'approachBody')}</p>}
          {text(c, 'approachLink') && (
            <a class="text-link" href="/services">
              {text(c, 'approachLink')} <span aria-hidden="true">→</span>
            </a>
          )}
        </div>
      </div>
    </section>
  );
}

function CalloutSection({ content }: { content: SiteContent }) {
  const c = content.copy;
  return (
    <section class="section">
      <div class="container callout">
        <div>
          {text(c, 'calloutEyebrow') && <span class="eyebrow">{text(c, 'calloutEyebrow')}</span>}
          <h2>{text(c, 'calloutHeading')}</h2>
          {text(c, 'calloutBody') && <p>{text(c, 'calloutBody')}</p>}
        </div>
        {text(c, 'calloutButton') && (
          <a class="button button-dark" href="/contact">
            {text(c, 'calloutButton')} <span aria-hidden="true">↗</span>
          </a>
        )}
      </div>
    </section>
  );
}

/** Renders the home page in the order, and with the visibility, chosen in the dashboard. */
export function HomeSections({ content, contact, latest }: Props) {
  return (
    <>
      {content.homeSections.map((section) => {
        switch (text(section, 'type')) {
          case 'hero':
            return <Hero hero={content.hero} />;
          case 'trust':
            return <TrustStrip content={content} />;
          case 'stats':
            return <StatsBand content={content} />;
          case 'latest':
            return <LatestSection content={content} latest={latest} />;
          case 'approach':
            return <ApproachSection content={content} />;
          case 'services':
            return <ServicesSection content={content} />;
          case 'chairman':
            return <ChairmanSection contact={contact} content={content} />;
          case 'worldwide':
            return <WorldwideSection content={content} />;
          case 'faq':
            return <FaqSection content={content} />;
          case 'callout':
            return <CalloutSection content={content} />;
          case 'contact_band':
            return <ContactBand contact={contact} content={content} />;
          case 'custom':
            return <CustomSection section={section} />;
          default:
            return null;
        }
      })}
    </>
  );
}
