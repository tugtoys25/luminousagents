import { requireRole } from '../../auth/staff-session';
import { Hono } from 'hono';
import { type AdminApp, platformSettingKeys } from '../shared';

const admin = new Hono<AdminApp>();

const escapeHtml = (s: unknown) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
  );

admin.get('/settings/ui', requireRole('admin', 'super_admin', 'editor'), async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT setting_key AS key,value_json AS value FROM platform_settings ORDER BY setting_key',
  ).all<{ key: string; value: string }>();
  const values: Record<string, unknown> = {};
  for (const row of rows.results ?? []) {
    try {
      values[row.key] = JSON.parse(row.value);
    } catch {
      values[row.key] = row.value;
    }
  }
  const structuredKeys = [
    'header_navigation',
    'footer_explore_navigation',
    'footer_navigation',
    'geo_sections',
    'homepage_sections',
  ];
  const settingGroups: Array<[string, string, string[]]> = [
    [
      'Brand and identity',
      'Name, description, logo and favicon shown across the public site.',
      [
        'site_name',
        'site_description',
        'logo_text',
        'logo_url',
        'logo_alt',
        'favicon_url',
        'favicon_svg_url',
      ],
    ],
    [
      'Icons, sharing image and chairman photo',
      'Home-screen icons, the picture shown when a page is shared, and the Chairman photo. Choose a file from the media library (PNG, JPEG, WebP, SVG or ICO) or paste a site path or HTTPS address. Anything left empty keeps the built-in default.',
      [
        'apple_touch_icon_url',
        'icon_192_url',
        'icon_512_url',
        'og_image_url',
        'chairman_image_url',
        'chairman_image_alt',
      ],
    ],
    [
      'Contact and analytics',
      'Where enquiries go and how traffic is measured.',
      [
        'notification_email',
        'contact_phone_mobile',
        'contact_phone_office',
        'contact_email',
        'contact_email_chairman',
        'whatsapp_number',
        'whatsapp_message',
        'email_widget_enabled',
        'email_widget_address',
        'email_widget_subject',
        'ga4_id',
      ],
    ],
    [
      'Chairman profile and social links',
      'The Chairman card on the home and About pages, plus the Instagram and LinkedIn icons shown with the WhatsApp and email icons on the Chairman card, the contact card and the footer. An icon appears only when its link is filled in. For Instagram you can paste the profile address or just the handle (for example @name).',
      [
        'chairman_name',
        'chairman_title',
        'chairman_bio',
        'chairman_expertise',
        'chairman_languages',
        'instagram_url',
        'linkedin_url',
      ],
    ],
    [
      'Cookie banner and privacy',
      'The consent pop-up shown to visitors. Leave a text field empty to use its default (shown as a placeholder). Visitors can change their choice from the footer link.',
      [
        'cookie_banner_enabled',
        'cookie_banner_title',
        'cookie_banner_text',
        'cookie_accept_label',
        'cookie_reject_label',
        'cookie_banner_position',
        'cookie_consent_days',
        'cookie_privacy_url',
        'cookie_policy_url',
        'cookie_terms_url',
      ],
    ],
    [
      'Colours and typography',
      'Brand colours (any CSS colour) and font families.',
      [
        'primary_color',
        'accent_color',
        'background_color',
        'font_family',
        'font_heading',
        'font_body',
      ],
    ],
    [
      'Navigation and homepage structure',
      'Add, edit, reorder and remove items with the buttons below. Changes go live when you save.',
      [
        'header_navigation',
        'footer_explore_navigation',
        'footer_navigation',
        'homepage_sections',
        'geo_sections',
      ],
    ],
  ];
  const selectFields: Record<string, Array<[string, string]>> = {
    email_widget_enabled: [
      ['on', 'On - show the email icon above the WhatsApp icon'],
      ['off', 'Off - hide the email icon'],
    ],
    cookie_banner_enabled: [
      ['on', 'On - show the banner'],
      ['off', 'Off - hide the banner'],
    ],
    cookie_banner_position: [
      ['bottom-left', 'Bottom left'],
      ['bottom', 'Bottom, full width'],
      ['center', 'Centre of the screen'],
    ],
  };
  const selectDefaults: Record<string, string> = {
    email_widget_enabled: 'on',
    cookie_banner_enabled: 'on',
    cookie_banner_position: 'bottom-left',
  };
  const placeholders: Record<string, string> = {
    logo_url: 'Empty = default M mark. PNG, WebP or SVG, transparent background recommended',
    apple_touch_icon_url: 'Empty = none. 180 x 180 PNG (iPhone and iPad home screen)',
    icon_192_url: 'Empty = none. 192 x 192 PNG (Android and web app)',
    icon_512_url: 'Empty = none. 512 x 512 PNG (Android and web app)',
    og_image_url: 'Empty = built-in image. 1200 x 630 JPEG or PNG',
    chairman_image_url: 'Empty = built-in photo. Square image, 400 x 400 or larger',
    chairman_image_alt: 'Empty = Brian Minister, Chairman',
    instagram_url: 'Empty = icon hidden. https://www.instagram.com/yourname/ or @yourname',
    linkedin_url: 'Empty = icon hidden. https://www.linkedin.com/in/...',
    chairman_name: 'Brian Minister',
    chairman_title: 'Chairman, Casinos of Mayfair International Ltd',
    chairman_bio: 'Empty = built-in welcome text. Leave a blank line between paragraphs.',
    chairman_expertise: 'Optional. One item per line or comma separated, shown as small tags under the bio.',
    chairman_languages: 'Optional, for example English, Spanish',
    email_widget_address: 'Empty = use the contact email',
    email_widget_subject: 'Enquiry from the Casinos of Mayfair website',
    cookie_banner_title: 'Your privacy matters',
    cookie_banner_text:
      'We use essential cookies to run this site. With your consent we also use analytics cookies to understand how it is used.',
    cookie_accept_label: 'Accept all',
    cookie_reject_label: 'Reject non-essential',
    cookie_consent_days: '180',
    cookie_privacy_url: '/legal/privacy',
    cookie_policy_url: '/legal/cookies',
    cookie_terms_url: '/legal/terms',
  };
  const renderField = (key: string) => {
    const structured = structuredKeys.includes(key);
    const value = values[key] ?? (structured ? [] : '');
    const rendered = structured ? JSON.stringify(value, null, 2) : String(value);
    const label = key.replace(/_/g, ' ');
    const options = selectFields[key];
    if (options) {
      const current = rendered || selectDefaults[key] || '';
      return `<label class="setting-field"><span>${label}</span><select name="${key}">${options
        .map(
          ([option, text]) =>
            `<option value="${option}"${option === current ? ' selected' : ''}>${text}</option>`,
        )
        .join('')}</select></label>`;
    }
    const longText =
      structured || ['site_description', 'whatsapp_message', 'cookie_banner_text', 'chairman_bio', 'chairman_expertise'].includes(key);
    const placeholder = placeholders[key] ? ` placeholder="${escapeHtml(placeholders[key])}"` : '';
    return `<label class="setting-field"${longText ? ' data-wide' : ''}><span>${label}</span><textarea name="${key}" rows="${structured ? 6 : ['cookie_banner_text', 'chairman_bio'].includes(key) ? 4 : 2}"${placeholder}>${escapeHtml(rendered)}</textarea></label>`;
  };
  const grouped = new Set(settingGroups.flatMap(([, , keys]) => keys));
  const leftovers = platformSettingKeys.filter((key) => !grouped.has(key));
  const sections = [
    ...settingGroups,
    ...(leftovers.length ? [['Other settings', '', leftovers] as [string, string, string[]]] : []),
  ];
  const fields = sections
    .map(
      ([title, help, keys], index) =>
        `<fieldset class="flow-card settings-section"><legend data-step="${index + 1}">${title}</legend>${help ? `<p class="muted">${help}</p>` : ''}<div class="settings-grid">${keys
          .filter((key) => platformSettingKeys.includes(key))
          .map(renderField)
          .join('')}</div></fieldset>`,
    )
    .join('');
  return c.html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Platform settings</title><link rel="stylesheet" href="/static/css/site.css"><link rel="stylesheet" href="/static/css/dashboard.css"></head><body><main class="admin"><p class="eyebrow">STAFF WORKSPACE</p><h1>Platform settings</h1><nav class="admin-nav"><a href="/dashboard">Overview</a><a href="/dashboard/settings/ui">Platform settings</a><a href="/dashboard/pages/ui">Pages</a><a href="/dashboard/forms/ui">Forms</a><a href="/dashboard/audit/ui">Audit log</a><a href="/admin/change-password">Change password</a><a href="/admin/logout">Sign out</a></nav><p class="setting-help">Edit branding, contact channels, GA4, typography, colours, navigation and structured homepage/geo sections. Changes appear on the public site after you save.</p><form id="settings-form" class="flow" data-flow><div class="flow-bar"><h2>Platform settings</h2><span class="flow-state" aria-live="polite">All changes saved</span><button type="submit">Save platform settings</button></div>${fields}<p id="settings-notice" role="status" aria-live="polite"></p></form><section class="ws-card"><h2>Custom content</h2><p><a href="/dashboard/pages/ui">Manage pages</a> · <a href="/dashboard/forms/ui">Manage custom forms</a></p></section></main><script src="/static/js/dashboard-settings.js" defer></script></body></html>`,
  );
});

export default admin;
