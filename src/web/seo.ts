import type { ContactSettings } from './site-settings';

export interface Crumb {
  name: string;
  /** Site-relative path. Omit for a label that has no page of its own. */
  path?: string;
}

const LABELS: Record<string, string> = {
  'casinos-for-sale': 'Opportunities',
  'casino-hotels': 'Casino hotels',
  faq: 'FAQ',
  'aml-kyc': 'AML / KYC',
  'staff-access': 'Staff access',
  'anti-bribery': 'Anti-bribery',
  'modern-slavery': 'Modern slavery',
  legal: 'Legal',
};
/** URL segments that are not pages themselves. */
const UNLINKED = new Set(['legal']);

const titleCase = (value: string) =>
  value.replace(/-/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());

/** Breadcrumb trail (excluding Home) derived from the URL path. */
export function crumbsFromPath(path: string): Crumb[] {
  const segments = path.split('/').filter(Boolean);
  return segments.map((segment, index) => {
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      /* keep raw segment */
    }
    return {
      name: LABELS[decoded] ?? titleCase(decoded),
      path:
        UNLINKED.has(decoded) && index < segments.length - 1
          ? undefined
          : `/${segments
              .slice(0, index + 1)
              .map(encodeURIComponent)
              .join('/')}`,
    };
  });
}

/** JSON for a <script type="application/ld+json"> block ("<" escaped). */
export const ldJson = (data: unknown): string => JSON.stringify(data).replace(/</g, '\\u003c');

export function breadcrumbLd(baseUrl: string, crumbs: Crumb[]) {
  const linked = crumbs.filter((crumb) => crumb.path);
  if (!linked.length) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [{ name: 'Home', path: '' }, ...linked].map((crumb, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: crumb.name,
      item: `${baseUrl}${crumb.path ?? ''}`,
    })),
  };
}

export function organizationLd(baseUrl: string, contact: ContactSettings) {
  const phone = (value: string) => value.replace(/\(0\)/g, '').replace(/[^\d+]/g, '');
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    '@id': `${baseUrl}/#organization`,
    name: 'Casinos of Mayfair International Ltd',
    alternateName: 'Casinos of Mayfair',
    url: baseUrl,
    description:
      'International brokerage for casino and casino-hotel investment opportunities, with casino management and consulting services.',
    foundingDate: '1994',
    email: contact.email,
    telephone: phone(contact.phoneOffice),
    areaServed: 'Worldwide',
    knowsAbout: ['Casino sales', 'Casino hotels', 'Casino management', 'Casino consulting'],
    contactPoint: [
      {
        '@type': 'ContactPoint',
        contactType: 'customer service',
        telephone: phone(contact.phoneMobile),
        email: contact.chairmanEmail,
        availableLanguage: 'English',
      },
    ],
  };
}

export function websiteLd(baseUrl: string) {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    '@id': `${baseUrl}/#website`,
    name: 'Casinos of Mayfair',
    url: baseUrl,
    inLanguage: 'en',
    publisher: { '@id': `${baseUrl}/#organization` },
    potentialAction: {
      '@type': 'SearchAction',
      target: `${baseUrl}/casinos-for-sale?q={search_term_string}`,
      'query-input': 'required name=search_term_string',
    },
  };
}

export function itemListLd(
  baseUrl: string,
  name: string,
  items: { slug: string; title: string }[],
) {
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name,
    numberOfItems: items.length,
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.title,
      url: `${baseUrl}/opportunities/${encodeURIComponent(item.slug)}`,
    })),
  };
}

export function servicesLd(baseUrl: string, services: readonly (readonly [string, string])[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: 'Casinos of Mayfair services',
    itemListElement: services.map(([name, description], index) => ({
      '@type': 'ListItem',
      position: index + 1,
      item: {
        '@type': 'Service',
        name,
        description,
        areaServed: 'Worldwide',
        provider: { '@id': `${baseUrl}/#organization` },
      },
    })),
  };
}

export function webPageLd(baseUrl: string, path: string, name: string, description: string) {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name,
    description,
    url: `${baseUrl}${path}`,
    isPartOf: { '@id': `${baseUrl}/#website` },
    about: { '@id': `${baseUrl}/#organization` },
  };
}
