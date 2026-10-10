import type { ContactSettings } from '../site-settings';
import { telHref } from '../site-settings';
import { FAQS, MARKETS, OFFICES, SERVICES, STATS } from '../content/site-content';

export function StatsBand() {
  return (
    <section class="stats-band" aria-label="Company at a glance">
      <div class="container stats-grid">
        {STATS.map(([value, label]) => (
          <div class="stat">
            <strong>{value}</strong>
            <span>{label}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

export function ServicesGrid() {
  return (
    <div class="service-grid">
      {SERVICES.map(([title, copy], index) => (
        <article class="service-card">
          <span class="service-num">{String(index + 1).padStart(2, '0')}</span>
          <h3>{title}</h3>
          <p>{copy}</p>
        </article>
      ))}
    </div>
  );
}

export function ServicesSection() {
  return (
    <section class="section">
      <div class="container">
        <div class="section-head">
          <span class="eyebrow">OUR SERVICES</span>
          <h2>Casino expertise beyond brokerage.</h2>
          <p>
            Casino sales, hotels, management and consulting, supported by a team with a combined 180
            years of casino-industry experience.
          </p>
        </div>
        <ServicesGrid />
      </div>
    </section>
  );
}

export function ChairmanSection({ contact }: { contact: ContactSettings }) {
  return (
    <section class="section section-muted" id="chairman">
      <div class="container chairman">
        <figure class="chairman-profile">
          <img
            src="/static/img/brian-minister.png"
            alt="Brian Minister, Chairman"
            width="202"
            height="202"
            loading="lazy"
          />
          <figcaption>
            <strong>Brian Minister</strong>
            <small>Chairman, Casinos of Mayfair International Ltd</small>
          </figcaption>
        </figure>
        <div class="chairman-copy">
          <span class="eyebrow">WELCOME FROM THE CHAIRMAN</span>
          <h2>Personal, discreet and confidential.</h2>
          <p>
            We opened our first office in London in 1994 with only two casinos for sale. Today we
            present a worldwide portfolio of land-based casino and casino-hotel opportunities, with
            prices from under $1 million to over $1 billion.
          </p>
          <p>
            If you wish to discuss any casino for sale or casino hotel personally, please contact me
            directly. Every enquiry is treated in strict confidence, and opportunities are
            advertised in a way that protects the identity and location of the property.
          </p>
          <div class="chairman-actions">
            <a class="button button-primary" href={telHref(contact.phoneMobile)}>
              Call {contact.phoneMobile}
            </a>
            <a class="button button-dark" href={`mailto:${contact.chairmanEmail}`}>
              Email the Chairman
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}

export function WorldwideSection() {
  return (
    <section class="section section-muted" id="worldwide">
      <div class="container">
        <div class="section-head">
          <span class="eyebrow">INTERNATIONAL NETWORK</span>
          <h2>Offices and opportunities worldwide.</h2>
          <p>
            Casinos of Mayfair operates across international casino and hospitality markets, with
            offices in England, Spain and Las Vegas.
          </p>
        </div>
        <div class="world-grid">
          {[...OFFICES, ...MARKETS].map(([title, copy], index) => (
            <article class={index < OFFICES.length ? 'world-card world-card-office' : 'world-card'}>
              <span class="world-tag">{index < OFFICES.length ? 'OFFICE' : 'MARKET'}</span>
              <h3>{title}</h3>
              <p>{copy}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

export function FaqList() {
  return (
    <div class="faq-list">
      {FAQS.map(([question, answer]) => (
        <details class="faq-item">
          <summary>{question}</summary>
          <p>{answer}</p>
        </details>
      ))}
    </div>
  );
}

export function FaqSection() {
  return (
    <section class="section" id="faq">
      <div class="container content-narrow-wide">
        <div class="section-head">
          <span class="eyebrow">FREQUENTLY ASKED QUESTIONS</span>
          <h2>Casino sales and brokerage FAQs.</h2>
          <p>
            Answers to common questions about listings, confidentiality, pricing information and
            international opportunities.
          </p>
        </div>
        <FaqList />
        <p class="faq-more">
          More questions? <a href="/faq">See the full FAQ</a> or{' '}
          <a href="/contact">make a confidential enquiry</a>.
        </p>
      </div>
    </section>
  );
}

export function ContactLines({ contact }: { contact: ContactSettings }) {
  return (
    <ul class="contact-lines">
      <li>
        <small>Chairman mobile</small>
        <a href={telHref(contact.phoneMobile)}>{contact.phoneMobile}</a>
      </li>
      <li>
        <small>Telephone</small>
        <a href={telHref(contact.phoneOffice)}>{contact.phoneOffice}</a>
      </li>
      <li>
        <small>Email</small>
        <a href={`mailto:${contact.email}`}>{contact.email}</a>
      </li>
      <li>
        <small>Chairman&apos;s email</small>
        <a href={`mailto:${contact.chairmanEmail}`}>{contact.chairmanEmail}</a>
      </li>
    </ul>
  );
}

export function ContactBand({ contact }: { contact: ContactSettings }) {
  return (
    <section class="contact-band" aria-labelledby="contact-band-title">
      <div class="container contact-band-grid">
        <div>
          <span class="eyebrow eyebrow-light">CONFIDENTIAL ENQUIRY</span>
          <h2 id="contact-band-title">Speak directly with the Chairman.</h2>
          <p>
            For any casino for sale, casino hotel, management, consulting or investment requirement,
            contact us directly. Enquiries are treated in strict confidence.
          </p>
        </div>
        <ContactLines contact={contact} />
      </div>
    </section>
  );
}
