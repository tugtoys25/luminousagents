import { BRAND } from '../../brand/defaults';
import type { Child } from 'hono/jsx';
import { raw } from 'hono/html';
import { socialRowHtml } from '../branding';
import { safeUrl } from '../../site-content/fields';
import { defaultSiteContent } from '../../site-content/resolve';
import { themeBodyClass, themeCss } from '../../site-content/theme-css';
import type { NavItem, SiteContent } from '../../site-content/types';
import { flag, text } from '../components/escape';
import {
  DEFAULT_CONTACT,
  socialInputs,
  telHref,
  type ContactSettings,
} from '../site-settings';
import {
  DEFAULT_SHARE_IMAGE,
  breadcrumbLd,
  crumbsFromPath,
  ldJson,
  organizationLd,
  websiteLd,
  type Crumb,
} from '../seo';

interface BaseProps {
  title: string;
  description: string;
  canonicalPath?: string;
  siteUrl?: string;
  contact?: ContactSettings;
  content?: SiteContent;
  noindex?: boolean;
  /** Absolute or site-relative share image (Open Graph / Twitter). */
  image?: string | null;
  imageAlt?: string;
  ogType?: 'website' | 'article';
  /** Breadcrumb trail after Home; derived from canonicalPath when omitted. */
  crumbs?: Crumb[];
  /** Extra schema.org objects for this page. */
  jsonLd?: unknown[];
  children: Child;
}

const SITE_URL: string = BRAND.siteUrl;

/** href plus new-tab attributes for a managed navigation link (links were already validated when loaded). */
function linkAttrs(item: NavItem): Record<string, string> {
  const href = safeUrl(item.url);
  return item['newTab'] === true
    ? { href, target: '_blank', rel: 'noopener noreferrer' }
    : { href };
}

export function BaseLayout({
  title,
  description,
  canonicalPath = '/',
  siteUrl = SITE_URL,
  contact = DEFAULT_CONTACT,
  content = defaultSiteContent(),
  noindex = false,
  image = null,
  imageAlt = '',
  ogType = 'website',
  crumbs,
  jsonLd = [],
  children,
}: BaseProps) {
  const baseUrl = siteUrl.replace(/\/$/, '');
  const canonical = `${baseUrl}${canonicalPath}`;
  const shareImage = (() => {
    const source = image || text(content.seo, 'shareImage') || DEFAULT_SHARE_IMAGE;
    return /^https?:\/\//i.test(source)
      ? source
      : `${baseUrl}${source.startsWith('/') ? '' : '/'}${source}`;
  })();
  const shareAlt = imageAlt || (image ? title : text(content.seo, 'shareImageAlt') || BRAND.name);
  const trail = crumbs ?? crumbsFromPath(canonicalPath);
  const footerSocial = socialRowHtml(
    socialInputs(contact, contact.chairmanEmail),
    'social-row footer-social',
  );
  const breadcrumbSchema = breadcrumbLd(baseUrl, trail);
  const themeStyles = themeCss(content.theme);
  const f = content.footer;
  const brandCopy = (
    <span class="brand-copy">
      <strong>{BRAND.nameUpper}</strong>
      {text(f, 'tagline') && <small>{text(f, 'tagline')}</small>}
    </span>
  );
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="theme-color" content="#fffdf9" />
        <meta name="color-scheme" content="light" />
        <title>{title}</title>
        <meta name="description" content={description} />
        <meta
          name="robots"
          content={
            noindex
              ? 'noindex, nofollow'
              : 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1'
          }
        />
        <meta name="author" content={BRAND.name} />
        <meta name="publisher" content={BRAND.name} />
        <link rel="alternate" hreflang="en" href={canonical} />
        <link rel="canonical" href={canonical} />
        <link rel="manifest" href="/site.webmanifest" />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: ldJson(organizationLd(baseUrl, contact)) }}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: ldJson(websiteLd(baseUrl)) }}
        />
        {breadcrumbSchema && (
          <script
            type="application/ld+json"
            dangerouslySetInnerHTML={{ __html: ldJson(breadcrumbSchema) }}
          />
        )}
        {jsonLd.map((item) => (
          <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: ldJson(item) }} />
        ))}
        {(canonicalPath === '/faq' || canonicalPath === '/') && content.faqs.length > 0 && (
          <script
            type="application/ld+json"
            dangerouslySetInnerHTML={{
              __html: ldJson({
                '@context': 'https://schema.org',
                '@type': 'FAQPage',
                mainEntity: content.faqs.map((row) => ({
                  '@type': 'Question',
                  name: text(row, 'question'),
                  acceptedAnswer: { '@type': 'Answer', text: text(row, 'answer') },
                })),
              }),
            }}
          />
        )}
        <meta property="og:type" content={ogType} />
        <meta property="og:locale" content="en_GB" />
        <meta property="og:site_name" content={BRAND.name} />
        <meta property="og:title" content={title} />
        <meta property="og:description" content={description} />
        <meta property="og:url" content={canonical} />
        <meta property="og:image" content={shareImage} />
        <meta property="og:image:alt" content={shareAlt} />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content={title} />
        <meta name="twitter:description" content={description} />
        <meta name="twitter:image" content={shareImage} />
        <meta name="twitter:image:alt" content={shareAlt} />
        <link rel="stylesheet" href="/static/css/site.css" />
        <link rel="stylesheet" href="/static/css/social.css" />
        <link rel="stylesheet" href="/static/css/site-content.css" />
        {themeStyles && <style dangerouslySetInnerHTML={{ __html: themeStyles }} />}
        <script src="/static/js/site-nav.js"></script>
      </head>
      <body class={`has-footer ${themeBodyClass(content.theme)}`.trim()}>
        <a class="skip-link" href="#main">
          Skip to content
        </a>
        <header class="site-header" id="site-header">
          <div class="container header-inner">
            <a class="brand" href="/" aria-label={`${BRAND.name} home`}>
              <span class="brand-mark" aria-hidden="true">
                {BRAND.markLetter}
              </span>
              {brandCopy}
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
                {content.navHeader.map((item) => (
                  <a class={item['style'] === 'cta' ? 'nav-cta' : undefined} {...linkAttrs(item)}>
                    {item.label}
                  </a>
                ))}
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
        {trail.length > 0 && (
          <nav class="breadcrumbs" aria-label="Breadcrumb">
            <ol class="container">
              <li>
                <a href="/">Home</a>
              </li>
              {trail.map((crumb, index) => (
                <li>
                  {crumb.path && index < trail.length - 1 ? (
                    <a href={crumb.path}>{crumb.name}</a>
                  ) : (
                    <span aria-current={index === trail.length - 1 ? 'page' : undefined}>
                      {crumb.name}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          </nav>
        )}
        <main id="main">{children}</main>
        <footer class="site-footer">
          <div class="container footer-grid">
            <div>
              <a class="brand brand-footer" href="/">
                <span class="brand-mark">L</span>
                <span class="brand-copy">
                  <strong>LUMINOUS AGENTS</strong>
                  <small>International Brokerage</small>
                </span>
              </a>
              <p>Confidential brokerage for casino and hospitality investment opportunities.</p>
              {footerSocial && raw(footerSocial)}
            </div>
            <div>
              <strong>{text(f, 'exploreHeading')}</strong>
              {content.navFooterExplore.map((item) => (
                <a {...linkAttrs(item)}>{item.label}</a>
              ))}
            </div>
            <div>
              <strong>{text(f, 'infoHeading')}</strong>
              {content.navFooterInfo.map((item) => (
                <a {...linkAttrs(item)}>{item.label}</a>
              ))}
            </div>
            <div>
              <strong>{text(f, 'contactHeading')}</strong>
              <a href={telHref(contact.phoneMobile)}>{contact.phoneMobile}</a>
              <a href={telHref(contact.phoneOffice)}>{contact.phoneOffice}</a>
              <a href={`mailto:${contact.email}`}>{contact.email}</a>
              {flag(f, 'showAccountLinks') && (
                <>
                  <a href="/account">Buyer sign in</a>
                  <a href="/admin/login">Staff sign in</a>
                </>
              )}
            </div>
          </div>
          <div class="container footer-bottom">
            <span>{text(f, 'copyright').replace('{year}', String(new Date().getUTCFullYear()))}</span>
            <span>
              {text(f, 'disclaimer')}{' '}
              {text(f, 'cookieLabel') && (
                <a href="/legal/cookies" data-cookie-settings>
                  {text(f, 'cookieLabel')}
                </a>
              )}
            </span>
          </div>
        </footer>
      </body>
    </html>
  );
}
