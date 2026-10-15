import { describe, expect, it } from 'vitest';
import { hasIcoSignature, isSafeSvg } from '../../src/security/svg-sanitizer';
import {
  applyBrand,
  brandFromSettings,
  brandUrl,
  buildManifest,
  emailFabHtml,
  emailWidgetAddress,
  instagramUrl,
  linkedinUrl,
  socialRowHtml,
} from '../../src/web/branding';

const bytes = (text: string) => new TextEncoder().encode(text);

describe('SVG upload screening', () => {
  it('accepts plain vector artwork with internal references', () => {
    expect(isSafeSvg(bytes('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h10v10z"/></svg>'))).toBe(true);
    expect(isSafeSvg(bytes('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="a"/></defs><rect fill="url(#a)"/><use href="#a"/></svg>'))).toBe(true);
  });

  it.each([
    ['script element', '<svg><script>alert(1)</script></svg>'],
    ['event handler', '<svg onload="x()"></svg>'],
    ['external image', '<svg><image href="https://evil.example/x.png"/></svg>'],
    ['javascript URL', '<svg><a href="javascript:alert(1)"/></svg>'],
    ['foreignObject', '<svg><foreignObject/></svg>'],
    ['animation', '<svg><animateTransform/></svg>'],
    ['css import', '<svg><style>@import url(x)</style></svg>'],
    ['external url()', '<svg><rect fill="url(https://x.example)"/></svg>'],
    ['not an svg', '<html><svg/></html>'],
    ['entity declaration', '<!DOCTYPE svg [<!ENTITY x "y">]><svg/>'],
  ])('rejects %s', (_name, source) => {
    expect(isSafeSvg(bytes(source))).toBe(false);
  });

  it('rejects empty, NUL-containing and oversized files', () => {
    expect(isSafeSvg(new Uint8Array())).toBe(false);
    expect(isSafeSvg(new Uint8Array([60, 115, 118, 103, 0]))).toBe(false);
    expect(isSafeSvg(bytes(`<svg>${'a'.repeat(512 * 1024)}</svg>`))).toBe(false);
  });

  it('recognises the ICO header', () => {
    expect(hasIcoSignature(new Uint8Array([0, 0, 1, 0, 1]))).toBe(true);
    expect(hasIcoSignature(new Uint8Array([1, 2, 3, 4]))).toBe(false);
  });
});

describe('branding URL and social link validation', () => {
  it('allows only site paths and https URLs', () => {
    expect(brandUrl('/media/12')).toBe('/media/12');
    expect(brandUrl('https://example.com/x.png')).toBe('https://example.com/x.png');
    for (const bad of ['//evil.example/x', 'javascript:x', 'http://example.com/x', '/a b', "/x'y"])
      expect(brandUrl(bad)).toBe('');
  });

  it('builds Instagram and LinkedIn links from safe input only', () => {
    expect(instagramUrl('@mayfair')).toBe('https://www.instagram.com/mayfair/');
    expect(instagramUrl('https://evil.example/x')).toBe('');
    expect(linkedinUrl('https://www.linkedin.com/in/1649250')).not.toBe('');
    expect(linkedinUrl('https://linkedin.evil.example/in/x')).toBe('');
  });

  it('renders icon rows with accessible names and hides unset networks', () => {
    const row = socialRowHtml(
      { whatsapp: '+44 7817 027077', whatsappMessage: '', emails: ['', '', 'team@example.com'], instagram: '', linkedin: 'https://www.linkedin.com/in/1649250' },
      'social-row',
      'Brian',
    );
    expect(row).toContain('https://wa.me/447817027077?text=');
    expect(row).toContain('mailto:team@example.com');
    expect(row).toContain('aria-label="Brian on WhatsApp"');
    expect(row).toContain('social-linkedin');
    expect(row).not.toContain('instagram');
  });

  it('picks the first valid e-mail address for the widget and omits it when unusable', () => {
    expect(emailWidgetAddress('not-an-email', 'good@example.com')).toBe('good@example.com');
    expect(emailFabHtml('nope', '', true)).toBe('');
    expect(emailFabHtml('a@example.com', '', false)).toContain('mayfair-email--solo');
  });
});

describe('applyBrand', () => {
  const page =
    '<html><head><link rel="manifest" href="/site.webmanifest"/><meta property="og:image" content="https://x.test/static/img/roulette.jpg"/><meta name="twitter:image" content="https://x.test/static/img/roulette.jpg"/><script type="application/ld+json">{"image":"https://x.test/static/img/roulette.jpg"}</script></head><body><span class="brand-mark" aria-hidden="true">M</span><span class="buyer-brand-mark">M</span><span class="mark">M</span></body></html>';

  it('leaves a page byte-for-byte unchanged when nothing is configured', () => {
    expect(applyBrand(page, brandFromSettings(() => ''), { includeFavicons: false })).toBe(page);
  });

  it('applies logo, share image, icons and manifest when configured', () => {
    const settings: Record<string, string> = { logo_url: '/media/9', og_image_url: '/media/5', icon_192_url: '/media/6', site_name: 'ACME Ltd' };
    const brand = brandFromSettings((key) => settings[key] ?? '');
    const out = applyBrand(page, brand, { includeFavicons: true, dashboard: true });
    expect((out.match(/brand-logo-image/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(out).toContain('content="https://x.test/media/5"');
    expect(out).toContain('/manifest.webmanifest');
    expect(out).toContain('apple-touch-icon" href="/media/6"');
    expect(out).toContain('name="mf-logo"');
    const manifest = buildManifest(brand) as { name: string; icons: { sizes: string }[] };
    expect(manifest.name).toBe('ACME Ltd');
    expect(manifest.icons[0]?.sizes).toBe('192x192');
  });
});
