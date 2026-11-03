/**
 * Single source of truth for the built-in brand. Every default that names the business, its domain or its
 * mailbox lives here. Staff can override all of it from the dashboard (Platform settings and Site content);
 * nothing below is ever required at runtime once those values are set.
 */
export const BRAND = {
  name: 'Luminous Agents',
  nameUpper: 'LUMINOUS AGENTS',
  shortName: 'Luminous',
  markLetter: 'L',
  domain: 'luminousagents.com',
  siteUrl: 'https://luminousagents.com',
  email: 'info@luminousagents.com',
  chairmanEmail: 'info@luminousagents.com',
  tagline: 'International Brokerage',
} as const;
