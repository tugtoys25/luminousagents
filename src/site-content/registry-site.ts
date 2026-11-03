import { BRAND } from '../brand/defaults';
import type { CollectionDef, FieldDef, Row } from './types';

const navFields = (withStyle: boolean): FieldDef[] => [
  { name: 'label', label: 'Label', type: 'text', required: true, max: 80 },
  { name: 'url', label: 'Link', type: 'url', required: true, help: '/page, #section or https://…' },
  ...(withStyle
    ? [{ name: 'style', label: 'Style', type: 'select' as const, options: [['link', 'Text link'], ['cta', 'Highlighted button']] as const }]
    : []),
  { name: 'newTab', label: 'Open in a new tab', type: 'toggle' },
];
const link = (label: string, url: string, style = 'link'): Row => ({ label, url, style, newTab: false });

const FOOTER_FIELDS: FieldDef[] = [
  { name: 'tagline', label: 'Brand tagline (under the name)', type: 'text', max: 60 },
  { name: 'blurb', label: 'Footer introduction', type: 'textarea', max: 300, wide: true },
  { name: 'exploreHeading', label: 'Explore column heading', type: 'text', max: 40 },
  { name: 'infoHeading', label: 'Information column heading', type: 'text', max: 40 },
  { name: 'contactHeading', label: 'Contact column heading', type: 'text', max: 40 },
  { name: 'copyright', label: 'Copyright line', type: 'text', max: 160, help: 'Use {year} for the current year.' },
  { name: 'disclaimer', label: 'Legal line', type: 'text', max: 240 },
  { name: 'cookieLabel', label: 'Cookie settings link label', type: 'text', max: 40 },
  { name: 'showAccountLinks', label: 'Show buyer and staff sign-in links', type: 'toggle' },
  { name: 'showOnDashboard', label: 'Show this footer in the staff dashboard', type: 'toggle' },
  { name: 'showOnAccountPages', label: 'Show this footer on buyer, seller and sign-in pages', type: 'toggle' },
];

const SEO_FIELDS: FieldDef[] = [
  { name: 'homeTitle', label: 'Home page title', type: 'text', max: 120 },
  { name: 'homeDescription', label: 'Home page description', type: 'textarea', max: 300, wide: true },
  { name: 'shareImage', label: 'Default sharing image', type: 'image', help: '1200 x 630 recommended.' },
  { name: 'shareImageAlt', label: 'Sharing image description', type: 'text', max: 160 },
];

const NOT_FOUND_FIELDS: FieldDef[] = [
  { name: 'eyebrow', label: 'Small label above the heading', type: 'text', max: 40 },
  { name: 'heading', label: 'Heading', type: 'text', max: 120 },
  { name: 'message', label: 'Message', type: 'textarea', max: 300, wide: true },
  { name: 'primaryLabel', label: 'First button label', type: 'text', max: 60 },
  { name: 'primaryUrl', label: 'First button link', type: 'url', help: '/page or https://…' },
  { name: 'secondaryLabel', label: 'Second button label', type: 'text', max: 60 },
  { name: 'secondaryUrl', label: 'Second button link', type: 'url', help: '/page or https://…' },
];

export const SITE_COLLECTIONS: CollectionDef[] = [
  { key: 'nav_header', label: 'Header menu', group: 'Navigation', kind: 'list', titleField: 'label', maxItems: 12,
    help: 'Links in the top navigation. A highlighted button is shown as the call to action.',
    fields: navFields(true),
    defaults: [link('Opportunities', '/casinos-for-sale'), link('Services', '/services'), link('About', '/about'),
      link('FAQ', '/faq'), link('Contact our team', '/contact', 'cta')] },
  { key: 'nav_footer_explore', label: 'Footer: Explore links', group: 'Navigation', kind: 'list', titleField: 'label', maxItems: 12,
    help: 'First footer column.', fields: navFields(false),
    defaults: [link('Opportunities', '/casinos-for-sale'), link('Services', '/services'), link('About us', '/about')] },
  { key: 'nav_footer_info', label: 'Footer: Information links', group: 'Navigation', kind: 'list', titleField: 'label', maxItems: 24,
    help: 'Second footer column (legal and help pages).', fields: navFields(false),
    defaults: [link('FAQ', '/faq'), link('Contact', '/contact'), link('Privacy', '/legal/privacy'), link('Terms', '/legal/terms'),
      link('Cookies', '/legal/cookies'), link('AML / KYC', '/legal/aml-kyc'), link('Sanctions', '/legal/sanctions'),
      link('Anti-bribery', '/legal/anti-bribery'), link('Listing disclaimer', '/legal/disclaimer'), link('Complaints', '/legal/complaints')] },
  { key: 'footer', label: 'Footer and brand line', group: 'Search and footer', kind: 'singleton', fields: FOOTER_FIELDS,
    help: 'Wording shown in the footer on every public page.',
    defaults: [{
      tagline: BRAND.tagline,
      blurb: 'Confidential brokerage for casino and hospitality investment opportunities.',
      exploreHeading: 'Explore', infoHeading: 'Information', contactHeading: 'Contact',
      copyright: `© {year} ${BRAND.name}. All rights reserved.`,
      disclaimer: 'All opportunities are subject to verification and qualification.',
      cookieLabel: 'Cookie settings', showAccountLinks: true, showOnDashboard: true, showOnAccountPages: true,
    }] },
  { key: 'seo', label: 'Search and sharing', group: 'Search and footer', kind: 'singleton', fields: SEO_FIELDS,
    help: 'Home page search-result text and the default picture shown when a link is shared.',
    defaults: [{
      homeTitle: `${BRAND.name} | Casino & Hospitality Brokerage`,
      homeDescription: 'Discreet, professional brokerage for casino and casino-hotel investment opportunities.',
      shareImage: '', shareImageAlt: `Casino roulette wheel - ${BRAND.name}`,
    }] },
  { key: 'not_found', label: 'Page not found (404)', group: 'Search and footer', kind: 'singleton', fields: NOT_FOUND_FIELDS,
    help: 'Wording and buttons of the page visitors see when a link does not exist. Empty a button label to hide that button.',
    defaults: [{
      eyebrow: 'Error 404', heading: 'Page not found',
      message: 'The page you requested does not exist or is no longer available.',
      primaryLabel: 'Return home', primaryUrl: '/', secondaryLabel: 'Browse opportunities', secondaryUrl: '/casinos-for-sale',
    }] },
];
