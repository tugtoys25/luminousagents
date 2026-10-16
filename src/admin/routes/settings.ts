import { requireRole } from '../../auth/staff-session';
import { z } from 'zod';
import { brandUrl, instagramUrl, linkedinUrl } from '../../web/branding';
import { Hono } from 'hono';
import { type AdminApp, id, now, platformSettingKeys } from '../shared';
import { listSettings, settingsAuditStatement, upsertSettingStatement } from '../repos/settings-repo';

const admin = new Hono<AdminApp>();

const brandImageKeys = [
  'apple_touch_icon_url',
  'icon_192_url',
  'icon_512_url',
  'og_image_url',
  'chairman_image_url',
];

admin.get('/settings', requireRole('admin', 'super_admin', 'editor'), async (c) => {
  const rows = await listSettings(c.env.DB);
  return c.json({
    data: rows.map((r) => ({
      key: r.key,
      value: JSON.parse(r.value),
      updatedAt: r.updatedAt,
    })),
  });
});

admin.put('/settings', requireRole('admin', 'super_admin'), async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length > 80)
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'Provide a settings object.' } },
      422,
    );
  const allowed = new Set(platformSettingKeys);
  const timestamp = now();
  const staff = c.get('staff');
  const statements = [] as D1PreparedStatement[];
  for (const [key, value] of Object.entries(body)) {
    if (!allowed.has(key))
      return c.json(
        { error: { code: 'UNKNOWN_SETTING', message: `Unsupported setting: ${key}` } },
        422,
      );
    if (typeof value === 'string' && value.length > 5000)
      return c.json(
        { error: { code: 'VALUE_TOO_LONG', message: `Setting ${key} is too long.` } },
        422,
      );
    if (
      ['header_navigation', 'footer_explore_navigation', 'footer_navigation', 'geo_sections', 'homepage_sections'].includes(
        key,
      ) &&
      (!Array.isArray(value) || value.length > 50)
    )
      return c.json(
        {
          error: {
            code: 'INVALID_JSON_SETTING',
            message: `${key} must be an array with at most 50 items.`,
          },
        },
        422,
      );
    if (key === 'ga4_id' && value && (typeof value !== 'string' || !/^G-[A-Z0-9]+$/.test(value)))
      return c.json(
        { error: { code: 'INVALID_GA4_ID', message: 'GA4 ID must use the G-XXXXXXXX format.' } },
        422,
      );
    if (
      key === 'notification_email' &&
      value &&
      (typeof value !== 'string' || !z.string().email().safeParse(value).success)
    )
      return c.json(
        {
          error: {
            code: 'INVALID_NOTIFICATION_EMAIL',
            message: 'Notification email must be a valid email address.',
          },
        },
        422,
      );
    if (key === 'cookie_banner_enabled' && value && !['on', 'off'].includes(String(value)))
      return c.json(
        { error: { code: 'INVALID_COOKIE_SETTING', message: 'Banner must be on or off.' } },
        422,
      );
    if (
      key === 'cookie_banner_position' &&
      value &&
      !['bottom-left', 'bottom', 'center'].includes(String(value))
    )
      return c.json(
        { error: { code: 'INVALID_COOKIE_SETTING', message: 'Unknown banner position.' } },
        422,
      );
    if (
      key === 'cookie_consent_days' &&
      value &&
      !(/^\d{1,3}$/.test(String(value)) && Number(value) >= 1 && Number(value) <= 730)
    )
      return c.json(
        {
          error: {
            code: 'INVALID_COOKIE_SETTING',
            message: 'Consent lifetime must be 1 to 730 days.',
          },
        },
        422,
      );
    if (
      ['cookie_privacy_url', 'cookie_policy_url', 'cookie_terms_url'].includes(key) &&
      value &&
      (typeof value !== 'string' ||
        !((value.startsWith('/') && !value.startsWith('//')) || /^https:\/\//i.test(value)))
    )
      return c.json(
        { error: { code: 'INVALID_URL', message: `${key} must be a site-relative or HTTPS URL.` } },
        422,
      );
    if (
      ['cookie_banner_title', 'cookie_accept_label', 'cookie_reject_label'].includes(key) &&
      typeof value === 'string' &&
      value.length > (key === 'cookie_banner_title' ? 80 : 40)
    )
      return c.json({ error: { code: 'VALUE_TOO_LONG', message: `${key} is too long.` } }, 422);
    if (key === 'cookie_banner_text' && typeof value === 'string' && value.length > 600)
      return c.json(
        { error: { code: 'VALUE_TOO_LONG', message: 'Banner text is limited to 600 characters.' } },
        422,
      );
    if (
      ['contact_email', 'contact_email_chairman', 'email_widget_address'].includes(key) &&
      value &&
      (typeof value !== 'string' || !z.string().email().safeParse(value).success)
    )
      return c.json(
        {
          error: {
            code: 'INVALID_CONTACT_EMAIL',
            message: `${key} must be a valid email address.`,
          },
        },
        422,
      );
    if (
      ['contact_phone_mobile', 'contact_phone_office'].includes(key) &&
      value &&
      (typeof value !== 'string' || !/^[0-9+()\s-]{6,30}$/.test(value))
    )
      return c.json(
        { error: { code: 'INVALID_PHONE', message: `${key} must be a phone number.` } },
        422,
      );
    if (
      ['primary_color', 'accent_color', 'background_color'].includes(key) &&
      value &&
      (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value))
    )
      return c.json(
        { error: { code: 'INVALID_COLOR', message: `${key} must be a six-digit hex colour.` } },
        422,
      );
    if (
      ['logo_url', 'favicon_url', 'favicon_svg_url'].includes(key) &&
      value &&
      (typeof value !== 'string' || !(value.startsWith('/') || /^https:\/\//i.test(value)))
    )
      return c.json(
        { error: { code: 'INVALID_URL', message: `${key} must be a site-relative or HTTPS URL.` } },
        422,
      );
    if (brandImageKeys.includes(key) && value && (typeof value !== 'string' || !brandUrl(value)))
      return c.json(
        {
          error: {
            code: 'INVALID_URL',
            message: `${key} must be a site path starting with / (for example /media/12) or an https:// address, with no spaces or quotes.`,
          },
        },
        422,
      );
    if (['logo_alt', 'chairman_image_alt'].includes(key) && typeof value === 'string' && value.length > 160)
      return c.json({ error: { code: 'VALUE_TOO_LONG', message: `${key} is limited to 160 characters.` } }, 422);
    if (key === 'instagram_url' && value && (typeof value !== 'string' || !instagramUrl(value)))
      return c.json(
        { error: { code: 'INVALID_INSTAGRAM_URL', message: 'Use an https://www.instagram.com/... address or a handle such as @yourname.' } },
        422,
      );
    if (key === 'linkedin_url' && value && (typeof value !== 'string' || !linkedinUrl(value)))
      return c.json(
        { error: { code: 'INVALID_LINKEDIN_URL', message: 'Use an https://www.linkedin.com/... address.' } },
        422,
      );
    if (
      ['chairman_name', 'chairman_title', 'chairman_languages'].includes(key) &&
      typeof value === 'string' &&
      value.length > 200
    )
      return c.json({ error: { code: 'VALUE_TOO_LONG', message: `${key} is limited to 200 characters.` } }, 422);
    if (['chairman_bio', 'chairman_expertise'].includes(key) && typeof value === 'string' && value.length > 4000)
      return c.json({ error: { code: 'VALUE_TOO_LONG', message: `${key} is limited to 4000 characters.` } }, 422);
    if (key === 'email_widget_enabled' && value && !['on', 'off'].includes(String(value)))
      return c.json(
        { error: { code: 'INVALID_EMAIL_WIDGET_SETTING', message: 'The email button must be on or off.' } },
        422,
      );
    if (key === 'email_widget_subject' && typeof value === 'string' && value.length > 120)
      return c.json({ error: { code: 'VALUE_TOO_LONG', message: 'The email subject is limited to 120 characters.' } }, 422);
    statements.push(upsertSettingStatement(c.env.DB, key, value, staff.id, timestamp));
  }
  if (statements.length)
    statements.push(
      settingsAuditStatement(c.env.DB, {
        auditId: id(),
        staffId: staff.id,
        requestId: c.get('requestId'),
        keys: Object.keys(body),
        timestamp,
      }),
    );
  if (statements.length) await c.env.DB.batch(statements);
  return c.json({ data: { saved: Object.keys(body).length, updatedAt: timestamp } });
});

export default admin;
