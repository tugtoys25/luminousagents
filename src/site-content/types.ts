/** Shared types for the staff-managed site content system. */
export type Value = string | boolean | number;
export type Row = Record<string, Value>;

export type FieldType = 'text' | 'textarea' | 'url' | 'image' | 'select' | 'color' | 'toggle' | 'number';

export interface FieldDef {
  name: string;
  label: string;
  type: FieldType;
  /** Maximum characters (text types) or maximum value (number). */
  max?: number;
  min?: number;
  required?: boolean;
  options?: ReadonlyArray<readonly [string, string]>;
  help?: string;
  placeholder?: string;
  wide?: boolean;
}

export interface CollectionDef {
  key: string;
  label: string;
  /** Tab group shown in the dashboard. */
  group: 'Home page' | 'Lists' | 'Navigation' | 'Appearance' | 'Search and footer';
  help: string;
  kind: 'singleton' | 'list';
  fields: readonly FieldDef[];
  /** Field shown as the row title in list editors. */
  titleField?: string;
  maxItems?: number;
  /** Built-in content. A singleton has exactly one entry. */
  defaults: readonly Row[];
}

export interface StoredItem {
  id: string;
  collection: string;
  sortOrder: number;
  enabled: boolean;
  data: Row;
  updatedAt: string;
}

export type NavItem = Row & { label: string; url: string };

/** Everything the public site reads, with built-in defaults already merged in. */
export interface SiteContent {
  theme: Row;
  hero: Row;
  copy: Row;
  footer: Row;
  seo: Row;
  notFound: Row;
  trust: Row[];
  stats: Row[];
  services: Row[];
  offices: Row[];
  markets: Row[];
  faqs: Row[];
  navHeader: NavItem[];
  navFooterExplore: NavItem[];
  navFooterInfo: NavItem[];
  homeSections: Row[];
  /** Collection keys the staff have customised (a collection not listed here is showing built-in content). */
  customised: string[];
}
