import { BRAND } from '../brand/defaults';
import type { CollectionDef, FieldDef, Row } from './types';


export const HERO_FIELDS: readonly FieldDef[] = [
  { name: 'layout', label: 'Layout', type: 'select', options: [['split', 'Text left, illustration right'], ['centered', 'Centred text'], ['image', 'Full-width background image']] },
  { name: 'eyebrow', label: 'Eyebrow line', type: 'text', max: 120 },
  { name: 'headline', label: 'Headline (first part)', type: 'text', max: 160 },
  { name: 'headlineEmphasis', label: 'Headline (emphasised part)', type: 'text', max: 160 },
  { name: 'lead', label: 'Lead paragraph', type: 'textarea', max: 500, wide: true },
  { name: 'primaryLabel', label: 'Primary button label', type: 'text', max: 60 },
  { name: 'primaryUrl', label: 'Primary button link', type: 'url' },
  { name: 'secondaryLabel', label: 'Secondary link label', type: 'text', max: 60 },
  { name: 'secondaryUrl', label: 'Secondary link', type: 'url' },
  { name: 'note', label: 'Reassurance note', type: 'text', max: 160 },
  { name: 'showArt', label: 'Show the illustration (split layout)', type: 'toggle' },
  { name: 'artKicker', label: 'Illustration caption (small)', type: 'text', max: 80 },
  { name: 'artCaption', label: 'Illustration caption (large)', type: 'text', max: 120 },
  { name: 'backgroundImage', label: 'Background image', type: 'image', help: 'Used by the full-width layout; optional elsewhere.' },
  { name: 'backgroundColor', label: 'Background colour', type: 'color' },
  { name: 'overlay', label: 'Image overlay strength', type: 'select', options: [['none', 'None'], ['light', 'Light'], ['medium', 'Medium'], ['strong', 'Strong']] },
  { name: 'align', label: 'Text alignment', type: 'select', options: [['left', 'Left'], ['center', 'Centre']] },
  { name: 'height', label: 'Section height', type: 'select', options: [['auto', 'Fit content'], ['tall', 'Tall'], ['screen', 'Full screen']] },
];

const HERO_DEFAULT: Row = {
  layout: 'split',
  eyebrow: 'INTERNATIONAL INVESTMENT BROKERAGE',
  headline: 'Exceptional hospitality assets.',
  headlineEmphasis: 'Discreetly connected.',
  lead: 'A specialist brokerage connecting qualified buyers with casino and casino-hotel investment opportunities across international markets.',
  primaryLabel: 'Explore opportunities',
  primaryUrl: '/casinos-for-sale',
  secondaryLabel: 'Speak to our team',
  secondaryUrl: '/contact',
  note: 'Personal, considered service for qualified enquiries',
  showArt: true,
  artKicker: 'PRIVATE OPPORTUNITY NETWORK',
  artCaption: 'Global perspective. Personal service.',
  backgroundImage: '',
  backgroundColor: '',
  overlay: 'medium',
  align: 'left',
  height: 'auto',
};

const t = (name: string, label: string, def: string, max = 200, wide = false): [FieldDef, string] => [
  { name, label, type: max > 200 ? 'textarea' : 'text', max, wide: wide || max > 200 },
  def,
];

const COPY_SPEC: Array<[FieldDef, string]> = [
  t('latestEyebrow', 'Latest listings: eyebrow', 'LATEST OPPORTUNITIES', 80),
  t('latestHeading', 'Latest listings: heading', 'Recently published listings.', 120),
  t('latestLink', 'Latest listings: link label', 'View all opportunities', 60),
  t('emptyTitle', 'No listings yet: title', 'New opportunities are being reviewed', 120),
  t('emptyBody', 'No listings yet: text', 'Listings are published once they have been verified and approved. Contact our team to discuss your investment criteria in confidence.', 400),
  t('emptyButton', 'No listings yet: button', 'Contact our team', 60),
  t('approachEyebrow', 'Approach: eyebrow', 'A SPECIALIST APPROACH', 80),
  t('approachHeading', 'Approach: heading', 'Clarity at every stage of the conversation.', 160),
  t('approachLead', 'Approach: lead', 'Buying or selling a casino or hospitality asset requires sector understanding, careful qualification and a measured approach to confidential information.', 500),
  t('approachBody', 'Approach: text', 'We help bring the right parties into conversation and coordinate next steps around each opportunity, subject to verification, due diligence and applicable requirements.', 600),
  t('approachLink', 'Approach: link label', 'Discover our services', 60),
  t('servicesEyebrow', 'Services: eyebrow', 'OUR SERVICES', 80),
  t('servicesHeading', 'Services: heading', 'Casino expertise beyond brokerage.', 160),
  t('servicesLead', 'Services: lead', 'Casino sales, hotels, management and consulting, supported by a team with a combined 180 years of casino-industry experience.', 400),
  t('chairmanEyebrow', 'Chairman: eyebrow', 'WELCOME FROM THE CHAIRMAN', 80),
  t('chairmanHeading', 'Chairman: heading', 'Personal, discreet and confidential.', 160),
  t('chairmanCall', 'Chairman: call button prefix', 'Call', 30),
  t('chairmanEmail', 'Chairman: email button', 'Email the Chairman', 60),
  t('worldwideEyebrow', 'Network: eyebrow', 'INTERNATIONAL NETWORK', 80),
  t('worldwideHeading', 'Network: heading', 'Offices and opportunities worldwide.', 160),
  t('worldwideLead', 'Network: lead', `${BRAND.name} operates across international casino and hospitality markets, with offices in England, Spain and Las Vegas.`, 400),
  t('officeTag', 'Network: office tag', 'OFFICE', 30),
  t('marketTag', 'Network: market tag', 'MARKET', 30),
  t('faqEyebrow', 'FAQ: eyebrow', 'FREQUENTLY ASKED QUESTIONS', 80),
  t('faqHeading', 'FAQ: heading', 'Casino sales and brokerage FAQs.', 160),
  t('faqLead', 'FAQ: lead', 'Answers to common questions about listings, confidentiality, pricing information and international opportunities.', 400),
  t('faqMore', 'FAQ: footer text', 'More questions?', 80),
  t('faqMoreLinkA', 'FAQ: first link label', 'See the full FAQ', 60),
  t('faqMoreLinkB', 'FAQ: second link label', 'make a confidential enquiry', 60),
  t('calloutEyebrow', 'Call-out: eyebrow', 'START A CONVERSATION', 80),
  t('calloutHeading', 'Call-out: heading', 'Looking for the right opportunity?', 160),
  t('calloutBody', 'Call-out: text', 'Tell us about your investment criteria and our team can discuss relevant next steps.', 400),
  t('calloutButton', 'Call-out: button', 'Contact our team', 60),
  t('contactEyebrow', 'Contact band: eyebrow', 'CONFIDENTIAL ENQUIRY', 80),
  t('contactHeading', 'Contact band: heading', 'Speak directly with the Chairman.', 160),
  t('contactBody', 'Contact band: text', 'For any casino for sale, casino hotel, management, consulting or investment requirement, contact us directly. Enquiries are treated in strict confidence.', 500),
];

export const SECTION_TYPES = [
  ['hero', 'Hero'], ['trust', 'Trust strip'], ['stats', 'Statistics band'], ['latest', 'Latest listings'],
  ['approach', 'Specialist approach'], ['services', 'Services'], ['chairman', 'Chairman welcome'],
  ['worldwide', 'Offices and markets'], ['faq', 'FAQ'], ['callout', 'Call-out'], ['contact_band', 'Contact band'],
  ['custom', 'Custom section'],
] as const;

const blank = (type: string, label: string): Row => ({
  type, label, eyebrow: '', heading: '', body: '', layout: 'text', imageUrl: '', imageAlt: '', cards: '',
  ctaLabel: '', ctaUrl: '', backgroundColor: '', backgroundImage: '', tone: 'default', anchor: '',
});

export const SECTION_FIELDS: readonly FieldDef[] = [
  { name: 'type', label: 'Section', type: 'select', required: true, options: SECTION_TYPES },
  { name: 'label', label: 'Admin label', type: 'text', max: 80, help: 'Only shown in this list.' },
  { name: 'eyebrow', label: 'Eyebrow (custom only)', type: 'text', max: 80 },
  { name: 'heading', label: 'Heading (custom only)', type: 'text', max: 160 },
  { name: 'body', label: 'Text (custom only)', type: 'textarea', max: 4000, wide: true, help: 'Blank line = new paragraph.' },
  { name: 'layout', label: 'Layout (custom only)', type: 'select', options: [['text', 'Text'], ['split', 'Text and image'], ['split-reverse', 'Image and text'], ['cards', 'Cards'], ['cta', 'Call-out banner']] },
  { name: 'imageUrl', label: 'Image (custom only)', type: 'image' },
  { name: 'imageAlt', label: 'Image description', type: 'text', max: 160 },
  { name: 'cards', label: 'Cards (custom, one per line)', type: 'textarea', max: 3000, wide: true, help: 'Format: Title | Text | optional /link' },
  { name: 'ctaLabel', label: 'Button label (custom only)', type: 'text', max: 60 },
  { name: 'ctaUrl', label: 'Button link (custom only)', type: 'url' },
  { name: 'backgroundColor', label: 'Background colour (custom only)', type: 'color' },
  { name: 'backgroundImage', label: 'Background image (custom only)', type: 'image' },
  { name: 'tone', label: 'Style (custom only)', type: 'select', options: [['default', 'Plain'], ['muted', 'Soft grey'], ['dark', 'Dark'], ['accent', 'Accent colour']] },
  { name: 'anchor', label: 'Anchor id (custom only)', type: 'text', max: 40, help: 'Lower-case letters, numbers and hyphens; lets a link jump here with #id.' },
];

export const HOME_COLLECTIONS: CollectionDef[] = [
  { key: 'hero', label: 'Hero', group: 'Home page', kind: 'singleton', fields: HERO_FIELDS, defaults: [HERO_DEFAULT],
    help: 'The first screen of the home page: text, buttons, layout, background image and colour.' },
  { key: 'home_sections', label: 'Home page layout', group: 'Home page', kind: 'list', fields: SECTION_FIELDS, titleField: 'label', maxItems: 40,
    defaults: SECTION_TYPES.filter(([k]) => k !== 'custom').map(([k, l]) => blank(k, l)),
    help: 'Reorder, hide or remove built-in sections and add your own custom sections.' },
  { key: 'copy', label: 'Section wording', group: 'Home page', kind: 'singleton', fields: COPY_SPEC.map(([f]) => f),
    defaults: [Object.fromEntries(COPY_SPEC.map(([f, d]) => [f.name, d]))],
    help: 'Headings and text of every built-in home page section. Empty a field to remove that line.' },
];
