import { FAQS, MARKETS, OFFICES, SERVICES, STATS } from '../web/content/site-content';
import type { CollectionDef, Row } from './types';

const pairs = (rows: ReadonlyArray<readonly [string, string]>, a: string, b: string): Row[] =>
  rows.map(([x, y]) => ({ [a]: x, [b]: y }));

const titleDesc = (key: string, label: string, rows: ReadonlyArray<readonly [string, string]>, help: string): CollectionDef => ({
  key, label, group: 'Lists', kind: 'list', titleField: 'title', maxItems: 24, help,
  fields: [
    { name: 'title', label: 'Title', type: 'text', required: true, max: 120 },
    { name: 'description', label: 'Description', type: 'textarea', max: 600, wide: true },
    ...(key === 'services' ? [{ name: 'url', label: 'Link (optional)', type: 'url' as const }] : []),
  ],
  defaults: pairs(rows, 'title', 'description').map((r) => (key === 'services' ? { ...r, url: '' } : r)),
});

export const LIST_COLLECTIONS: CollectionDef[] = [
  { key: 'trust', label: 'Trust strip', group: 'Lists', kind: 'list', titleField: 'title', maxItems: 6,
    help: 'The three short reassurance points under the hero (numbered automatically).',
    fields: [
      { name: 'title', label: 'Title', type: 'text', required: true, max: 80 },
      { name: 'caption', label: 'Caption', type: 'text', max: 120 },
    ],
    defaults: [
      { title: 'Specialist focus', caption: 'Casino & hospitality assets' },
      { title: 'Qualified introductions', caption: 'Buyer-led conversations' },
      { title: 'Discreet process', caption: 'Information shared appropriately' },
    ] },
  { key: 'stats', label: 'Statistics', group: 'Lists', kind: 'list', titleField: 'value', maxItems: 8,
    help: 'The figures band (for example founding year or portfolio size).',
    fields: [
      { name: 'value', label: 'Figure', type: 'text', required: true, max: 40 },
      { name: 'label', label: 'Label', type: 'text', required: true, max: 120 },
    ],
    defaults: pairs(STATS, 'value', 'label') },
  titleDesc('services', 'Services', SERVICES, 'Service cards on the home and Services pages.'),
  titleDesc('offices', 'Offices', OFFICES, 'Office cards in the network section and on the contact page.'),
  titleDesc('markets', 'Markets', MARKETS, 'Market cards in the network section.'),
  { key: 'faqs', label: 'FAQs', group: 'Lists', kind: 'list', titleField: 'question', maxItems: 60,
    help: 'Questions shown on the FAQ page, the home page and in search-engine FAQ data.',
    fields: [
      { name: 'question', label: 'Question', type: 'text', required: true, max: 200 },
      { name: 'answer', label: 'Answer', type: 'textarea', required: true, max: 2000, wide: true },
    ],
    defaults: pairs(FAQS, 'question', 'answer') },
];
