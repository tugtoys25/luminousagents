import type { Child } from 'hono/jsx';
import { FAQS } from '../content/site-content';
import { DEFAULT_CONTACT, telHref, type ContactSettings } from '../site-settings';

interface BaseProps {
  title: string;
  description: string;
  canonicalPath?: string;
  siteUrl?: string;
  contact?: ContactSettings;
  noindex?: boolean;
  children: Child;
}

const SITE_URL = 'https://casinosofmayfair.com';

export function BaseLayout({
  title,
  description,
  canonicalPath = '/',
  siteUrl = SITE_URL,
  contact = DEFAULT_CONTACT,
  noindex = false,
  children,
}: BaseProps) {
  const baseUrl = siteUrl.replace(/\/$/, '');
  const canonical = `${baseUrl}${canonicalPath}`;
  const segments = canonicalPath.split('/').filter(Boolean);
  const breadcrumb = [
    { name: 'Home', item: baseUrl },
    ...segments.map((segment, index) => ({
      name: decodeURIComponent(segment)
        .replace(/-/g, ' ')
        .replace(/\b\w/g, (char) => char.toUpperCase()),
      item: `${baseUrl}/${segments
        .slice(0, index + 1)
        .map(encodeURIComponent)
        .join('/')}`,
    })),
  ];
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="theme-color" content="#fffdf9" />
        {noindex && <meta name="robots" content="noindex, nofollow" />}
        <meta name="color-scheme" content="light" />
        <title>{title}</title>
        <meta name="description" content={description} />
        <link rel="canonical" href={canonical} />
        <link rel="manifest" href="/site.webmanifest" />
        <script type="application/ld+json">
          {JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'Organization',
            name: 'Casinos of Mayfair',
            url: baseUrl,
          })}
        </script>
        <script type="application/ld+json">
          {JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'WebSite',
            name: 'Casinos of Mayfair',
            url: baseUrl,
          })}
        </script>
        <script type="application/ld+json">
          {JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'BreadcrumbList',
            itemListElement: breadcrumb.map((item, index) => ({
              '@type': 'ListItem',
              position: index + 1,
              name: item.name,
              item: item.item,
            })),
          })}
        </script>
        {(canonicalPath === '/faq' || canonicalPath === '/') && (
          <script type="application/ld+json">
            {JSON.stringify({
              '@context': 'https://schema.org',
              '@type': 'FAQPage',
              mainEntity: FAQS.map(([name, text]) => ({
                '@type': 'Question',
                name,
                acceptedAnswer: { '@type': 'Answer', text },
              })),
            })}
          </script>
        )}
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content="Casinos of Mayfair" />
        <meta property="og:title" content={title} />
        <meta property="og:description" content={description} />
        <meta property="og:url" content={canonical} />
        <link rel="stylesheet" href="/static/css/site.css" />
        <script src="/static/js/site-nav.js"></script>
      </head>
      <body>
        <a class="skip-link" href="#main">
          Skip to content
        </a>
        <header class="site-header" id="site-header">
          <div class="container header-inner">
            <a class="brand" href="/" aria-label="Casinos of Mayfair home">
              <span class="brand-mark" aria-hidden="true">
                M
              </span>
              <span class="brand-copy">
                <strong>CASINOS OF MAYFAIR</strong>
                <small>International Brokerage</small>
              </span>
            </a>
            <button
              class="menu-toggle"
              type="button"
              aria-expanded="false"
              aria-controls="site-menu"
              aria-label="Open menu"
            >
              <span class="menu-bars" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <span class="menu-label">Menu</span>
            </button>
            <div class="header-panel" id="site-menu">
              <nav aria-label="Main navigation" class="main-nav">
                <a href="/casinos-for-sale">Opportunities</a>
                <a href="/services">Services</a>
                <a href="/about">About</a>
                <a href="/faq">FAQ</a>
                <a class="nav-cta" href="/contact">
                  Contact our team
                </a>
              </nav>
              <div class="header-auth">
                <div class="auth-menu">
                  <button
                    class="auth-trigger"
                    type="button"
                    aria-expanded="false"
                    aria-haspopup="true"
                  >
                    Sign in <span aria-hidden="true">▾</span>
                  </button>
                  <div class="auth-pop">
                    <span class="auth-pop-title">Sign in as</span>
                    <a href="/account">
                      <strong>Buyer</strong>
                      <small>Saved opportunities and NDA access</small>
                    </a>
                    <a href="/admin/login">
                      <strong>Staff</strong>
                      <small>Brokers, editors and administrators</small>
                    </a>
                  </div>
                </div>
                <div class="auth-menu auth-menu-register">
                  <button
                    class="auth-trigger"
                    type="button"
                    aria-expanded="false"
                    aria-haspopup="true"
                  >
                    Register <span aria-hidden="true">▾</span>
                  </button>
                  <div class="auth-pop">
                    <span class="auth-pop-title">Register as</span>
                    <a href="/register">
                      <strong>Buyer</strong>
                      <small>Create an account for review</small>
                    </a>
                    <a href="/staff-access">
                      <strong>Staff</strong>
                      <small>Request a staff account</small>
                    </a>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </header>
        <main id="main">{children}</main>
        <footer class="site-footer">
          <div class="container footer-grid">
            <div>
              <a class="brand brand-footer" href="/">
                <span class="brand-mark">M</span>
                <span class="brand-copy">
                  <strong>CASINOS OF MAYFAIR</strong>
                  <small>International Brokerage</small>
                </span>
              </a>
              <p>Confidential brokerage for casino and hospitality investment opportunities.</p>
            </div>
            <div>
              <strong>Explore</strong>
              <a href="/casinos-for-sale">Opportunities</a>
              <a href="/services">Services</a>
              <a href="/about">About us</a>
            </div>
            <div>
              <strong>Information</strong>
              <a href="/faq">FAQ</a>
              <a href="/contact">Contact</a>
              <a href="/legal/privacy">Privacy</a>
              <a href="/legal/terms">Terms</a>
              <a href="/legal/cookies">Cookies</a>
              <a href="/legal/aml-kyc">AML / KYC</a>
              <a href="/legal/sanctions">Sanctions</a>
              <a href="/legal/anti-bribery">Anti-bribery</a>
              <a href="/legal/disclaimer">Listing disclaimer</a>
              <a href="/legal/complaints">Complaints</a>
            </div>
            <div>
              <strong>Contact</strong>
              <a href={telHref(contact.phoneMobile)}>{contact.phoneMobile}</a>
              <a href={telHref(contact.phoneOffice)}>{contact.phoneOffice}</a>
              <a href={`mailto:${contact.email}`}>{contact.email}</a>
              <a href="/account">Buyer sign in</a>
              <a href="/admin/login">Staff sign in</a>
            </div>
          </div>
          <div class="container footer-bottom">
            <span>© {new Date().getUTCFullYear()} Casinos of Mayfair. All rights reserved.</span>
            <span>All opportunities are subject to verification and qualification.</span>
          </div>
        </footer>
      </body>
    </html>
  );
}
