import type { CollectionDef, FieldDef } from './types';

/** Font stacks offered in the dashboard. Only these (or a sanitised custom stack) can reach the stylesheet. */
export const FONT_STACKS: Record<string, string> = {
  'serif-classic': "Georgia, 'Times New Roman', serif",
  'serif-modern': "'Iowan Old Style', 'Palatino Linotype', Palatino, 'Book Antiqua', serif",
  'sans-system': "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  'sans-humanist': "'Segoe UI', 'Helvetica Neue', Helvetica, Arial, sans-serif",
  rounded: "ui-rounded, 'SF Pro Rounded', 'Hiragino Maru Gothic ProN', Quicksand, sans-serif",
  mono: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
};

const fontOptions = [
  ['', 'Built-in default'], ['serif-classic', 'Classic serif'], ['serif-modern', 'Modern serif'],
  ['sans-system', 'System sans-serif'], ['sans-humanist', 'Humanist sans-serif'], ['rounded', 'Rounded'],
  ['mono', 'Monospace'], ['custom', 'Custom stack (below)'],
] as const;

const THEME_FIELDS: FieldDef[] = [
  { name: 'primaryColor', label: 'Primary colour', type: 'color' },
  { name: 'accentColor', label: 'Accent colour', type: 'color' },
  { name: 'backgroundColor', label: 'Page background colour', type: 'color' },
  { name: 'textColor', label: 'Text colour', type: 'color' },
  { name: 'headingFont', label: 'Heading font', type: 'select', options: fontOptions },
  { name: 'bodyFont', label: 'Body font', type: 'select', options: fontOptions },
  { name: 'customHeadingFont', label: 'Custom heading stack', type: 'text', max: 120, placeholder: "Garamond, 'Times New Roman', serif", help: 'Only fonts installed on the visitor’s device are used.' },
  { name: 'customBodyFont', label: 'Custom body stack', type: 'text', max: 120 },
  { name: 'fontSize', label: 'Base text size', type: 'select', options: [['', 'Default'], ['15', 'Small (15px)'], ['17', 'Large (17px)'], ['18', 'Extra large (18px)']] },
  { name: 'radius', label: 'Corner rounding', type: 'select', options: [['', 'Default'], ['0', 'Square'], ['6', 'Slight'], ['14', 'Rounded'], ['24', 'Very rounded']] },
  { name: 'containerWidth', label: 'Page width', type: 'select', options: [['', 'Default'], ['1040', 'Narrow'], ['1240', 'Wide'], ['1440', 'Extra wide']] },
  { name: 'headerStyle', label: 'Header style', type: 'select', options: [['light', 'Light'], ['dark', 'Dark'], ['accent', 'Primary colour']] },
  { name: 'buttonStyle', label: 'Button shape', type: 'select', options: [['default', 'Default'], ['pill', 'Pill'], ['square', 'Square']] },
  { name: 'pageBackgroundImage', label: 'Page background image', type: 'image', help: 'Shown behind the whole site; keep it subtle.' },
  { name: 'pageBackgroundMode', label: 'Background image mode', type: 'select', options: [['cover', 'Cover the page'], ['tile', 'Repeat as a pattern']] },
];

export const THEME_COLLECTION: CollectionDef = {
  key: 'theme', label: 'Colours, fonts and layout', group: 'Appearance', kind: 'singleton', fields: THEME_FIELDS,
  help: 'Site-wide look. Empty values keep the built-in design.',
  defaults: [{
    primaryColor: '', accentColor: '', backgroundColor: '', textColor: '', headingFont: '', bodyFont: '',
    customHeadingFont: '', customBodyFont: '', fontSize: '', radius: '', containerWidth: '',
    headerStyle: 'light', buttonStyle: 'default', pageBackgroundImage: '', pageBackgroundMode: 'cover',
  }],
};
