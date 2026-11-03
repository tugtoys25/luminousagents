import { raw } from 'hono/html';
import type { ContactSettings } from '../site-settings';
import { chairmanImage, DEFAULT_CHAIRMAN, socialInputs, telHref } from '../site-settings';
import { socialRowHtml } from '../branding';
import { safeUrl } from '../../site-content/fields';
import type { SiteContent } from '../../site-content/types';
import { text } from './escape';

type Content = { content: SiteContent };

export function StatsBand({ content }: Content) {
  if (!content.stats.length) return null;
  return (
    <section class="stats-band" aria-label="Company at a glance">
      <div class="container stats-grid">
        {content.stats.map((row) => (
          <div class="stat">
            <strong>{text(row, 'value')}</strong>
            <span>{text(row, 'label')}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

export function TrustStrip({ content }: Content) {
  if (!content.trust.length) return null;
  return (
    <section class="trust-strip">
      <div class="container trust-grid">
        {content.trust.map((row, index) => (
          <div>
            <span class="trust-number">{String(index + 1).padStart(2, '0')}</span>
            <strong>{text(row, 'title')}</strong>
            <span>{text(row, 'caption')}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

export function ServicesGrid({ content }: Content) {
  return (
    <div class="service-grid">
      {content.services.map((row, index) => {
        const url = safeUrl(text(row, 'url'));
        return (
          <article class="service-card">
            <span class="service-num">{String(index + 1).padStart(2, '0')}</span>
            <h3>{url ? <a href={url}>{text(row, 'title')}</a> : text(row, 'title')}</h3>
            <p>{text(row, 'description')}</p>
          </article>
        );
      })}
    </div>
  );
}

export function ServicesSection({ content }: Content) {
  const c = content.copy;
  return (
    <section class="section">
      <div class="container">
        <div class="section-head">
          {text(c, 'servicesEyebrow') && <span class="eyebrow">{text(c, 'servicesEyebrow')}</span>}
          {text(c, 'servicesHeading') && <h2>{text(c, 'servicesHeading')}</h2>}
          {text(c, 'servicesLead') && <p>{text(c, 'servicesLead')}</p>}
        </div>
        <ServicesGrid content={content} />
      </div>
    </section>
  );
}

export function ChairmanSection({ contact, content }: { contact: ContactSettings } & Content) {
  const c = content.copy;
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
          {text(c, 'chairmanEyebrow') && <span class="eyebrow">{text(c, 'chairmanEyebrow')}</span>}
          {text(c, 'chairmanHeading') && <h2>{text(c, 'chairmanHeading')}</h2>}
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
              {text(c, 'chairmanCall')} {contact.phoneMobile}
            </a>
            <a class="button button-dark" href={`mailto:${contact.chairmanEmail}`}>
              {text(c, 'chairmanEmail')}
            </a>
          </div>
          {social && raw(social)}
        </div>
      </div>
    </section>
  );
}

export function WorldwideSection({ content }: Content) {
  const c = content.copy;
  const officeCount = content.offices.length;
  const cards = [...content.offices, ...content.markets];
  if (!cards.length) return null;
  return (
    <section class="section section-muted" id="worldwide">
      <div class="container">
        <div class="section-head">
          {text(c, 'worldwideEyebrow') && <span class="eyebrow">{text(c, 'worldwideEyebrow')}</span>}
          {text(c, 'worldwideHeading') && <h2>{text(c, 'worldwideHeading')}</h2>}
          {text(c, 'worldwideLead') && <p>{text(c, 'worldwideLead')}</p>}
        </div>
        <div class="world-grid">
          {cards.map((row, index) => (
            <article class={index < officeCount ? 'world-card world-card-office' : 'world-card'}>
              <span class="world-tag">{index < officeCount ? text(c, 'officeTag') : text(c, 'marketTag')}</span>
              <h3>{text(row, 'title')}</h3>
              <p>{text(row, 'description')}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

export function FaqList({ content }: Content) {
  return (
    <div class="faq-list">
      {content.faqs.map((row) => (
        <details class="faq-item">
          <summary>{text(row, 'question')}</summary>
          <p>{text(row, 'answer')}</p>
        </details>
      ))}
    </div>
  );
}

export function FaqSection({ content }: Content) {
  const c = content.copy;
  if (!content.faqs.length) return null;
  return (
    <section class="section" id="faq">
      <div class="container content-narrow-wide">
        <div class="section-head">
          {text(c, 'faqEyebrow') && <span class="eyebrow">{text(c, 'faqEyebrow')}</span>}
          {text(c, 'faqHeading') && <h2>{text(c, 'faqHeading')}</h2>}
          {text(c, 'faqLead') && <p>{text(c, 'faqLead')}</p>}
        </div>
        <FaqList content={content} />
        <p class="faq-more">
          {text(c, 'faqMore')} <a href="/faq">{text(c, 'faqMoreLinkA')}</a> or{' '}
          <a href="/contact">{text(c, 'faqMoreLinkB')}</a>.
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

export function ContactBand({ contact, content }: { contact: ContactSettings } & Content) {
  const c = content.copy;
  return (
    <section class="contact-band" aria-labelledby="contact-band-title">
      <div class="container contact-band-grid">
        <div>
          {text(c, 'contactEyebrow') && <span class="eyebrow eyebrow-light">{text(c, 'contactEyebrow')}</span>}
          <h2 id="contact-band-title">{text(c, 'contactHeading')}</h2>
          <p>{text(c, 'contactBody')}</p>
        </div>
        <ContactLines contact={contact} />
      </div>
    </section>
  );
}
