import type { Child } from 'hono/jsx';

interface BaseProps {
  title: string;
  description: string;
  canonicalPath?: string;
  siteUrl?: string;
  children: Child;
}

const SITE_URL = 'https://casinosofmayfair.com';

export function BaseLayout({
  title,
  description,
  canonicalPath = '/',
  siteUrl = SITE_URL,
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
        <meta name="viewport" content="width=device-width, initial-scale=1" />
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
        {canonicalPath === '/faq' && (
          <script type="application/ld+json">
            {JSON.stringify({
              '@context': 'https://schema.org',
              '@type': 'FAQPage',
              mainEntity: [
                {
                  '@type': 'Question',
                  name: 'How do I request confidential information?',
                  acceptedAnswer: {
                    '@type': 'Answer',
                    text: 'Submit an initial enquiry. Access to confidential materials may require buyer qualification and NDA review.',
                  },
                },
                {
                  '@type': 'Question',
                  name: 'Are the listed opportunities guaranteed?',
                  acceptedAnswer: {
                    '@type': 'Answer',
                    text: 'No. Information is indicative and must be independently verified through due diligence.',
                  },
                },
              ],
            })}
          </script>
        )}
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content="Casinos of Mayfair" />
        <meta property="og:title" content={title} />
        <meta property="og:description" content={description} />
        <meta property="og:url" content={canonical} />
        <link rel="stylesheet" href="/static/css/site.css" />
      </head>
      <body>
        <a class="skip-link" href="#main">
          Skip to content
        </a>
        <header class="site-header">
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
            <nav aria-label="Main navigation" class="main-nav">
              <a href="/casinos-for-sale">Opportunities</a>
              <a href="/services">Services</a>
              <a href="/about">About</a>
              <a href="/account">Buyer account</a>
              <a class="nav-cta" href="/contact">
                Contact our team
              </a>
            </nav>
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
