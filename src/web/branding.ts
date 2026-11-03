/**
 * Branding, contact/social icons and floating contact buttons.
 *
 * Ported from the PHP edition (branding.php, social-icons.php, email-widget.php, whatsapp-widget.php).
 * Everything is driven by Platform settings. An empty setting keeps the built-in default exactly as
 * before; a value is used only when it is a same-site path or an https:// address.
 */

import { BRAND } from '../brand/defaults';

export const DEFAULT_WHATSAPP_MESSAGE = `Hello, I would like to enquire about ${BRAND.name}.`;
export const DEFAULT_EMAIL: string = BRAND.email;
export const DEFAULT_EMAIL_SUBJECT = `Enquiry from the ${BRAND.name} website`;
export const DEFAULT_SHARE_IMAGE_PATH = '/static/img/roulette.jpg';
export const DEFAULT_CHAIRMAN_IMAGE = '/static/img/brian-minister.png';

export const escapeHtml = (value: unknown): string =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
  );

/** JavaScript encodeURIComponent semantics. */
export const encodeComponent = (value: string): string => encodeURIComponent(value);

/** A usable image URL: same-site absolute path or https. Returns '' otherwise. */
export function brandUrl(value: unknown): string {
  const v = typeof value === 'string' ? value.trim() : '';
  // eslint-disable-next-line no-control-regex -- rejects control characters, spaces, quotes and angle brackets
  if (!v || v.length > 500 || /[\x00-\x20"'<>\\]/.test(v)) return '';
  if (v.startsWith('/') && !v.startsWith('//')) return v;
  return /^https:\/\/[^/]+/i.test(v) ? v : '';
}

/** Absolute URL for share metadata. */
export function absoluteUrl(url: string, origin: string): string {
  if (!url || /^https?:\/\//i.test(url)) return url;
  return `${origin.replace(/\/$/, '')}${url.startsWith('/') ? '' : '/'}${url}`;
}

/** MIME type guessed from the extension of a configured URL, or '' (for example /media/12). */
export function brandType(url: string): string {
  const path = url.split(/[?#]/)[0] ?? '';
  const ext = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : '';
  return (
    ({
      svg: 'image/svg+xml',
      png: 'image/png',
      ico: 'image/x-icon',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      webp: 'image/webp',
      gif: 'image/gif',
    } as Record<string, string>)[ext] ?? ''
  );
}

/** Instagram profile URL from a full https URL or a bare handle (@name / name). '' when unusable. */
export function instagramUrl(raw: unknown): string {
  const v = typeof raw === 'string' ? raw.trim() : '';
  // eslint-disable-next-line no-control-regex
  if (!v || v.length > 200 || /[\x00-\x20"'<>\\]/.test(v)) return '';
  if (/^https:\/\/(?:www\.)?instagram\.com\/[A-Za-z0-9._/\-?=&%]+$/i.test(v)) return v;
  const handle = /^@?([A-Za-z0-9._]{1,30})$/.exec(v);
  return handle ? `https://www.instagram.com/${handle[1]}/` : '';
}

/** LinkedIn profile URL (https, linkedin.com host). '' when unusable. */
export function linkedinUrl(raw: unknown): string {
  const v = typeof raw === 'string' ? raw.trim() : '';
  // eslint-disable-next-line no-control-regex
  if (!v || v.length > 300 || /[\x00-\x20"'<>\\]/.test(v)) return '';
  return /^https:\/\/(?:[a-z]{2,3}\.|www\.)?linkedin\.com\/[A-Za-z0-9._/\-?=&%]+$/i.test(v) ? v : '';
}

const validEmail = (value: string): boolean =>
  value.length > 0 && value.length <= 254 && /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(value);

export type IconName = 'whatsapp' | 'email' | 'instagram' | 'linkedin';

/** Inline SVG for one icon. Decorative: the surrounding link carries the accessible name. */
export function socialIcon(name: IconName, size = 22): string {
  const s = Math.max(12, Math.min(64, size));
  const open = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${s}" height="${s}" aria-hidden="true" focusable="false"`;
  switch (name) {
    case 'whatsapp':
      return `${open} fill="currentColor"><path d="M12.04 2a9.9 9.9 0 0 0-8.5 14.95L2 22l5.2-1.36A9.93 9.93 0 1 0 12.04 2zm0 1.8a8.13 8.13 0 1 1-4.15 15.14l-.3-.18-3.08.8.82-3-.2-.31A8.13 8.13 0 0 1 12.04 3.8z"/><path d="M16.6 14.4c-.2-.1-1.4-.7-1.6-.8s-.4-.1-.5.1-.6.8-.8.9-.3.2-.5.1a6.6 6.6 0 0 1-3.3-2.9c-.2-.4.2-.4.7-1.3.1-.2 0-.3 0-.4l-.7-1.6c-.2-.4-.4-.4-.5-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.8 11.8 11.8 0 0 0 4.6 4c1.7.7 2.4.8 3.2.7a2.7 2.7 0 0 0 1.8-1.3 2.2 2.2 0 0 0 .2-1.3c0-.1-.2-.2-.5-.3z"/></svg>`;
    case 'email':
      return `${open} fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="m3.5 7.5 8.5 6.2 8.5-6.2"/></svg>`;
    case 'instagram':
      return `${open} fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4.1"/><circle cx="17.4" cy="6.6" r="1.1" fill="currentColor" stroke="none"/></svg>`;
    case 'linkedin':
      return `${open} fill="currentColor"><path d="M4.98 3.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM3 9.75h4V21H3zM9.5 9.75h3.8v1.6h.06c.53-1 1.84-2 3.8-2 4.07 0 4.84 2.55 4.84 5.86V21H18v-5.3c0-1.27-.02-2.9-1.8-2.9-1.8 0-2.07 1.38-2.07 2.8V21H9.5z"/></svg>`;
  }
}

/** Plain values the social/contact helpers need (loaded from Platform settings). */
export interface SocialInputs {
  whatsapp: string;
  whatsappMessage: string;
  /** Candidate e-mail addresses, in preference order. */
  emails: string[];
  instagram: string;
  linkedin: string;
}

export interface SocialLink {
  key: IconName;
  label: string;
  href: string;
  external: boolean;
}

export function whatsappDigits(raw: string): string {
  const digits = raw.replace(/[^0-9]/g, '');
  return digits.length >= 8 && digits.length <= 15 ? digits : '';
}

/** Links for the contact row, in display order. */
export function socialLinks(input: SocialInputs): SocialLink[] {
  const out: SocialLink[] = [];
  const digits = whatsappDigits(input.whatsapp);
  if (digits) {
    const message = input.whatsappMessage.trim() || DEFAULT_WHATSAPP_MESSAGE;
    out.push({
      key: 'whatsapp',
      label: 'WhatsApp',
      href: `https://wa.me/${digits}?text=${encodeComponent(message)}`,
      external: true,
    });
  }
  const mail = [...input.emails, DEFAULT_EMAIL].map((v) => v.trim()).find(validEmail);
  if (mail) out.push({ key: 'email', label: 'Email', href: `mailto:${mail}`, external: false });
  const ig = instagramUrl(input.instagram);
  if (ig) out.push({ key: 'instagram', label: 'Instagram', href: ig, external: true });
  const li = linkedinUrl(input.linkedin);
  if (li) out.push({ key: 'linkedin', label: 'LinkedIn', href: li, external: true });
  return out;
}

/** Row of round icon links. '' when there is nothing to show. */
export function socialRowHtml(
  input: SocialInputs,
  className = 'social-row',
  who = '',
  keys: IconName[] | null = null,
): string {
  let items = socialLinks(input);
  if (keys) items = keys.flatMap((k) => items.filter((it) => it.key === k));
  if (!items.length) return '';
  const links = items
    .map((it) => {
      const label =
        it.key === 'email' ? `Email${who ? ` ${who}` : ''}` : `${who ? `${who} on ` : ''}${it.label}`;
      return `<a class="social-link social-${it.key}" href="${escapeHtml(it.href)}"${
        it.external ? ' target="_blank" rel="noopener noreferrer"' : ''
      } aria-label="${escapeHtml(label)}" title="${escapeHtml(it.label)}">${socialIcon(it.key, 20)}</a>`;
    })
    .join('');
  return `<div class="${escapeHtml(className)}" role="group" aria-label="Contact and social links">${links}</div>`;
}

/** Inline CSS for the floating icon buttons (travels with the markup, so a cached older site.css cannot break it). */
export function fabCss(which: 'whatsapp' | 'email'): string {
  const common =
    '{position:fixed;right:20px;z-index:9999;width:54px;height:54px;padding:0;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:0;line-height:0;color:#fff;text-decoration:none;box-shadow:0 6px 20px rgba(0,0,0,.28);transition:transform .15s ease,box-shadow .15s ease}';
  if (which === 'email') {
    const a = 'a.mayfair-email[data-fab]';
    return `${a}${common}${a}{bottom:86px;background:#1f2937}${a}.mayfair-email--solo{bottom:20px}${a}:hover,${a}:focus-visible{transform:scale(1.08);box-shadow:0 8px 24px rgba(0,0,0,.34);color:#fff}${a}:focus-visible{outline:3px solid #fff;outline-offset:2px}${a} svg{width:28px;height:28px}@media (max-width:640px){${a}{right:14px;width:50px;height:50px;bottom:calc(max(14px,env(safe-area-inset-bottom)) + 62px)}${a}.mayfair-email--solo{bottom:max(14px,env(safe-area-inset-bottom))}}`;
  }
  const a = 'a.mayfair-whatsapp[data-fab]';
  return `${a}${common}${a}{bottom:20px;background:#25d366}${a}:hover,${a}:focus-visible{transform:scale(1.08);box-shadow:0 8px 24px rgba(0,0,0,.34);color:#fff}${a}:focus-visible{outline:3px solid #fff;outline-offset:2px}${a} svg{width:28px;height:28px}@media (max-width:640px){${a}{right:14px;width:50px;height:50px;bottom:max(14px,env(safe-area-inset-bottom))}}`;
}

/** Round WhatsApp icon button (same link, class and accessible name as the previous text pill). */
export function whatsappFabHtml(digits: string, message: string): string {
  const text = message.trim() || DEFAULT_WHATSAPP_MESSAGE;
  return `<style>${fabCss('whatsapp')}</style><a class="mayfair-whatsapp" data-fab="whatsapp" href="https://wa.me/${digits}?text=${encodeComponent(text)}" target="_blank" rel="noopener noreferrer" aria-label="Contact us on WhatsApp" title="Chat on WhatsApp">${socialIcon('whatsapp', 28)}</a>`;
}

/** Round e-mail icon button that stacks above the WhatsApp button. '' when no usable address. */
export function emailFabHtml(address: string, subject: string, hasWhatsapp: boolean): string {
  if (!validEmail(address)) return '';
  const subj = (subject.trim() || DEFAULT_EMAIL_SUBJECT).slice(0, 120);
  const href = `mailto:${address}?subject=${encodeComponent(subj)}`;
  return `<style>${fabCss('email')}</style><a class="mayfair-email${hasWhatsapp ? '' : ' mayfair-email--solo'}" data-fab="email" href="${escapeHtml(href)}" aria-label="Email us" title="Send us an email">${socialIcon('email', 28)}</a>`;
}

/** First usable address of: the widget address, the site contact e-mail, the built-in default. */
export function emailWidgetAddress(configured: string, contact: string): string {
  return [configured, contact, DEFAULT_EMAIL].map((v) => v.trim()).find(validEmail) ?? '';
}

/** Small stylesheet that sizes any logo image used in place of the "M" mark. */
export const BRAND_LOGO_CSS =
  '.brand-logo-image{display:block;width:auto;height:auto;max-width:200px;max-height:44px;object-fit:contain;flex:none}' +
  '.brand-footer .brand-logo-image{max-height:48px}.story .brand-logo-image{max-height:48px;background:none}' +
  '.buyer-brand .brand-logo-image{max-height:44px}.workspace-brand .brand-logo-image{max-height:36px;max-width:36px;border-radius:8px}' +
  '@media(max-width:640px){.brand-logo-image{max-width:150px;max-height:38px}}';

export interface BrandValues {
  logo: string;
  logoAlt: string;
  logoText: string;
  favicon: string;
  faviconSvg: string;
  apple: string;
  icon192: string;
  icon512: string;
  og: string;
  name: string;
}

/** Brand values from a settings reader (`get` returns '' for an unset key). */
export function brandFromSettings(get: (key: string) => string): BrandValues {
  const name = get('site_name').trim().slice(0, 100);
  return {
    logo: brandUrl(get('logo_url')),
    logoAlt: get('logo_alt').trim().slice(0, 160),
    logoText: get('logo_text').trim().slice(0, 100),
    favicon: brandUrl(get('favicon_url')),
    faviconSvg: brandUrl(get('favicon_svg_url')),
    apple: brandUrl(get('apple_touch_icon_url')),
    icon192: brandUrl(get('icon_192_url')),
    icon512: brandUrl(get('icon_512_url')),
    og: brandUrl(get('og_image_url')),
    name: name || BRAND.name,
  };
}

/** `<link>` tag for the home-screen touch icon (falls back to the 192 px icon). */
export function touchIconLink(b: BrandValues): string {
  const touch = b.apple || b.icon192;
  return touch ? `<link rel="apple-touch-icon" href="${escapeHtml(touch)}">` : '';
}

/** Web app manifest: the static manifest's values plus the configured name and icons. */
export function buildManifest(b: BrandValues): Record<string, unknown> {
  const icons: Record<string, string>[] = [];
  for (const [src, sizes] of [
    [b.icon192, '192x192'],
    [b.icon512, '512x512'],
  ] as const) {
    if (!src) continue;
    const icon: Record<string, string> = { src, sizes };
    const type = brandType(src);
    if (type) icon.type = type;
    icon.purpose = 'any';
    icons.push(icon);
  }
  const manifest: Record<string, unknown> = {
    name: b.name,
    short_name: b.name === BRAND.name ? BRAND.shortName : b.name.slice(0, 12),
    start_url: '/',
    display: 'standalone',
    background_color: '#f7f4ee',
    theme_color: '#8c1d28',
  };
  if (icons.length) manifest.icons = icons;
  return manifest;
}

/**
 * Applies the configured brand to a rendered HTML page: touch icon, manifest link, logo in place of the
 * "M" mark (public header/footer, sign-in, buyer area), logo sizing CSS, logo text, share image and, for
 * the staff dashboard, a `mf-logo` meta tag the workspace script uses for its sidebar.
 *
 * Idempotent: markup that was already replaced is left alone. `includeFavicons` is false on public pages,
 * where the site-wide customisation pass already adds the favicon links.
 */
export function applyBrand(
  html: string,
  b: BrandValues,
  opts: { includeFavicons: boolean; dashboard?: boolean },
): string {
  let head = '';
  if (opts.includeFavicons) {
    if (b.favicon) {
      const type = brandType(b.favicon);
      head += `<link rel="icon"${type ? ` type="${type}"` : ''} href="${escapeHtml(b.favicon)}">`;
    }
    if (b.faviconSvg)
      head += `<link rel="icon" type="image/svg+xml" href="${escapeHtml(b.faviconSvg)}">`;
  }
  head += touchIconLink(b);
  if (b.icon192 || b.icon512) {
    html = html.replace(
      /<link rel="manifest" href="\/site\.webmanifest"\s*\/?>/,
      () => '<link rel="manifest" href="/manifest.webmanifest">',
    );
  }
  if (b.logo) {
    const alt = b.logoAlt || b.name;
    const img = `<img src="${escapeHtml(b.logo)}" alt="${escapeHtml(alt)}" class="brand-logo-image" decoding="async">`;
    html = html
      .replace(/<span class="brand-mark"[^>]*>\s*[LM]\s*<\/span>/g, () => img)
      .replace(/<span class="mark">[LM]<\/span>/g, () => img)
      .replace(/<span class="buyer-brand-mark">[LM]<\/span>/g, () => img);
    head += `<style>${BRAND_LOGO_CSS}</style>`;
    if (opts.dashboard)
      head += `<meta name="mf-logo" content="${escapeHtml(b.logo)}" data-alt="${escapeHtml(alt)}">`;
  }
  if (b.logoText) {
    html = html.replace(
      /(<span class="brand-copy">\s*<strong>)[^<]*(<\/strong>)/g,
      (_m, open: string, close: string) => `${open}${escapeHtml(b.logoText)}${close}`,
    );
  }
  if (b.og) {
    html = html
      .replace(
        /(<meta (?:property="og:image"|name="twitter:image") content=")(https?:\/\/[^"/]+)?[^"]*\/static\/img\/roulette\.jpg(")/g,
        (_m, open: string, origin: string | undefined, close: string) =>
          `${open}${escapeHtml(absoluteUrl(b.og, origin ?? ''))}${close}`,
      )
      .replace(
        /("image":")(https?:\/\/[^"/]+)?[^"]*\/static\/img\/roulette\.jpg(")/g,
        (_m, open: string, origin: string | undefined, close: string) =>
          `${open}${absoluteUrl(b.og, origin ?? '').replace(/["\\]/g, '')}${close}`,
      );
  }
  if (head) html = html.replace('</head>', () => `${head}</head>`);
  return html;
}
