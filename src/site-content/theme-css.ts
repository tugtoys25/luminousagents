import { FONT_STACKS } from './registry-theme';
import { isHexColor, safeUrl } from './fields';
import type { Row } from './types';

const str = (row: Row, key: string): string => {
  const v = row[key];
  return typeof v === 'string' ? v : '';
};

/** A custom stack may only contain font names, quotes, commas, hyphens and spaces. */
export const cleanStack = (value: string): string => value.replace(/[^a-zA-Z0-9 ,\-'"]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);

function stack(row: Row, key: 'heading' | 'body'): string {
  const choice = str(row, `${key}Font`);
  if (choice === 'custom') return cleanStack(str(row, key === 'heading' ? 'customHeadingFont' : 'customBodyFont'));
  return FONT_STACKS[choice] ?? '';
}

/** CSS custom properties and rules for the staff-chosen theme. Returns '' when nothing is customised. */
export function themeCss(theme: Row): string {
  const vars: string[] = [];
  const rules: string[] = [];
  const color = (key: string, ...names: string[]) => {
    const v = str(theme, key);
    if (isHexColor(v)) for (const n of names) vars.push(`${n}:${v}`);
  };
  color('primaryColor', '--red', '--color-primary');
  color('accentColor', '--gold', '--color-accent');
  color('backgroundColor', '--paper', '--color-background');
  color('textColor', '--ink');
  const heading = stack(theme, 'heading');
  const body = stack(theme, 'body');
  if (heading) vars.push(`--serif:${heading}`);
  if (body) vars.push(`--sans:${body}`, `--font-family:${body}`);
  const radius = str(theme, 'radius');
  if (/^\d{1,2}$/.test(radius)) vars.push(`--radius:${radius}px`);
  const width = str(theme, 'containerWidth');
  if (/^\d{3,4}$/.test(width)) vars.push(`--container:${width}px`);
  const size = str(theme, 'fontSize');
  if (/^1[5-8]$/.test(size)) rules.push(`html{font-size:${size}px}`);
  const bg = safeUrl(str(theme, 'pageBackgroundImage'));
  if (bg) {
    const mode = str(theme, 'pageBackgroundMode') === 'tile'
      ? 'background-repeat:repeat'
      : 'background-size:cover;background-attachment:fixed;background-position:center';
    rules.push(`body{background-image:url("${bg.replace(/"/g, '%22')}");${mode}}`);
  }
  return (vars.length ? `:root{${vars.join(';')}}` : '') + rules.join('');
}

/** Body classes derived from theme choices (header style, button shape). */
export function themeBodyClass(theme: Row): string {
  const classes: string[] = [];
  const header = str(theme, 'headerStyle');
  if (header === 'dark' || header === 'accent') classes.push(`theme-header-${header}`);
  const button = str(theme, 'buttonStyle');
  if (button === 'pill' || button === 'square') classes.push(`theme-button-${button}`);
  return classes.join(' ');
}
