import { Hono } from 'hono';
import { BaseLayout } from '../layouts/base';
import { STATIC_PAGES, staticPageSlug } from '../static-pages';
import { findPageOverride } from '../public-listings-repo';
import { ChairmanSection, ContactLines, FaqList, ServicesGrid, StatsBand, WorldwideSection } from '../components/sections';
import { text } from '../components/escape';
import { servicesLd, webPageLd } from '../seo';
import type { PublicApp } from './public-shared';
import { SITE_URL } from './public-shared';

const publicPages = new Hono<PublicApp>();

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
      content={c.get('content')}
      title="Contact Our Team | Luminous Agents"
      description="Contact the Luminous Agents team about casino and hospitality investment opportunities."
      canonicalPath="/contact"
      jsonLd={[
        webPageLd(
          (c.env.PUBLIC_BASE_URL || SITE_URL).replace(/\/$/, ''),
          '/contact',
          'Contact Luminous Agents',
          'Contact the Luminous Agents team about casino and hospitality investment opportunities.',
          'ContactPage',
        ),
      ]}
    >
      <section class="page-hero">
        <div class="container">
          <span class="eyebrow">LUMINOUS AGENTS</span>
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
                <input type="checkbox" name="consent" required /> I agree that Luminous Agents
                may use these details to respond to my enquiry. *
              </label>
              <p class="form-privacy">
                Please read our <a href="/legal/privacy">privacy notice</a>. This form is for
                initial contact only and is not a secure document-transfer channel.
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
                {c.get('content').offices.map((office) => (
                  <li>{text(office, 'title')}</li>
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
      content={c.get('content')}
      title="Staff access | Luminous Agents"
      description="How Luminous Agents staff accounts are created."
      canonicalPath="/staff-access"
      noindex
    >
      <section class="page-hero">
        <div class="container">
          <span class="eyebrow">STAFF ACCESS</span>
          <h1>Staff accounts are invitation-only</h1>
          <p>
            Brokers, editors and administrators are set up by a Luminous Agents administrator.
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
    const override = await findPageOverride(c.env.DB, staticPageSlug(path));
    if (override) {
      const paragraphs = override.body
        .split(/\r?\n\s*\r?\n/)
        .map((part) => part.trim())
        .filter(Boolean);
      return c.html(
        <BaseLayout
          siteUrl={c.env.PUBLIC_BASE_URL || SITE_URL}
          contact={c.get('contact')}
          content={c.get('content')}
          title={`${override.seoTitle || override.title} | Luminous Agents`}
          description={override.seoDescription || override.description || description}
          canonicalPath={path}
        >
          <section class="page-hero">
            <div class="container">
              <span class="eyebrow">LUMINOUS AGENTS</span>
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
        content={c.get('content')}
        title={`${title} | Luminous Agents`}
        description={description}
        canonicalPath={path}
        jsonLd={[
          webPageLd(
            (c.env.PUBLIC_BASE_URL || SITE_URL).replace(/\/$/, ''),
            path,
            title,
            description,
            path === '/about' ? 'AboutPage' : 'WebPage',
          ),
          ...(path === '/services'
            ? [servicesLd(
                (c.env.PUBLIC_BASE_URL || SITE_URL).replace(/\/$/, ''),
                c.get('content').services.map((row) => [text(row, 'title'), text(row, 'description')] as const),
              )]
            : []),
        ]}
      >
        <section class="page-hero">
          <div class="container">
            <span class="eyebrow">LUMINOUS AGENTS</span>
            <h1>{heading}</h1>
            <p>{copy}</p>
          </div>
        </section>
        {path === '/services' && (
          <section class="section">
            <div class="container">
              <ServicesGrid content={c.get('content')} />
            </div>
          </section>
        )}
        {path === '/about' && (
          <>
            <StatsBand content={c.get('content')} />
            <ChairmanSection contact={c.get('contact')} content={c.get('content')} />
            <WorldwideSection content={c.get('content')} />
          </>
        )}
        {path === '/faq' && (
          <section class="section">
            <div class="container content-narrow-wide">
              <FaqList content={c.get('content')} />
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


export default publicPages;
