import { raw } from 'hono/html';
import type { ContactSettings } from '../site-settings';
import { chairmanImage, DEFAULT_CHAIRMAN, socialInputs, telHref } from '../site-settings';
import { socialRowHtml } from '../branding';
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
  const name = contact.chairmanName || DEFAULT_CHAIRMAN.name;
  const title = contact.chairmanTitle || DEFAULT_CHAIRMAN.title;
  const paragraphs = (contact.chairmanBio || DEFAULT_CHAIRMAN.bio)
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
  const facts = (contact.chairmanExpertise || '')
    .split(/[\r\n,;]+/)
    .map((part) => part.trim())
    .filter((part) => part && part.length <= 80);
  const languages = contact.chairmanLanguages || '';
  const alt = contact.chairmanImageAlt || `${name}, Chairman`;
  const social = socialRowHtml(
    socialInputs(contact, contact.chairmanEmail),
    'social-row chairman-social',
    name,
  );
  return (
    <section class="section section-muted" id="chairman">
      <div class="container chairman">
        <figure class="chairman-profile">
          <img src={chairmanImage(contact)} alt={alt} width="202" height="202" loading="lazy" />
          <figcaption>
            <strong>{name}</strong>
            <small>{title}</small>
          </figcaption>
        </figure>
        <div class="chairman-copy">
          <span class="eyebrow">WELCOME FROM THE CHAIRMAN</span>
          <h2>Personal, discreet and confidential.</h2>
          {paragraphs.map((text) => (
            <p>{text}</p>
          ))}
          {facts.length > 0 && (
            <ul class="chairman-facts" aria-label="Areas of expertise">
              {facts.map((fact) => (
                <li>{fact}</li>
              ))}
            </ul>
          )}
          {languages && (
            <p class="chairman-meta">
              <strong>Languages:</strong> {languages}
            </p>
          )}
          <div class="chairman-actions">
            <a class="button button-primary" href={telHref(contact.phoneMobile)}>
              Call {contact.phoneMobile}
            </a>
            <a class="button button-dark" href={`mailto:${contact.chairmanEmail}`}>
              Email the Chairman
            </a>
          </div>
          {social && raw(social)}
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
  const social = socialRowHtml(socialInputs(contact, contact.chairmanEmail));
  return (
    <div class="contact-card">
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
      {social && raw(social)}
    </div>
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
