import type { Context } from 'hono';
import type { Env } from '../env';
import type { StaffIdentity } from '../auth/staff-session';
import { hashPassword, passwordPolicyError } from '../auth/password';
import { slugify } from '../domain/opportunities/slug';
import { hasIcoSignature, isSafeSvg } from '../security/svg-sanitizer';

export type AdminApp = { Bindings: Env; Variables: { requestId: string; staff: StaffIdentity } };

export const editorRoles = ['admin', 'editor', 'broker', 'super_admin'];
// Kept literal because scripts/role-matrix.mjs reads these lists; test/unit/permissions.test.ts
// proves they equal the permission map.

export const publisherRoles = ['admin', 'publisher', 'super_admin'];

export const now = () => new Date().toISOString();

export const id = () => crypto.randomUUID();

export function csvCell(value: unknown): string {
  const text = value == null ? '' : typeof value === 'string' ? value : String(value);
  // Prevent spreadsheet formula execution while preserving ordinary text.
  const safe = /^[\s]*[=+@]/.test(text) || /^[\s]*-/.test(text) ? `'${text}` : text;
  // Also neutralise a leading tab or carriage return.
  const guarded = /^[=+\-@\t\r]/.test(safe) ? `'${safe}` : safe;
  return `"${guarded.replace(/"/g, '""')}"`;
}

export const TEMP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/** 14 unambiguous characters from a CSPRNG (rejection sampling, no modulo bias). */
export function generateTemporaryPassword(): string {
  const limit = 256 - (256 % TEMP_ALPHABET.length);
  for (;;) {
    let out = '';
    while (out.length < 14) {
      for (const byte of crypto.getRandomValues(new Uint8Array(32))) {
        if (byte < limit && out.length < 14) out += TEMP_ALPHABET[byte % TEMP_ALPHABET.length];
      }
    }
    if (/[a-z]/i.test(out) && /[2-9]/.test(out)) return out;
  }
}

/** Sets a temporary password, forces a change at next sign-in and signs the person out everywhere. */
export async function issueTemporaryPassword(
  c: Context<{ Bindings: Env; Variables: { requestId: string; staff: StaffIdentity } }>,
  user: { id: string; email: string },
  kind: 'staff' | 'buyer',
  custom?: string,
): Promise<{ password: string } | { problem: string }> {
  if (custom) {
    const problem = passwordPolicyError(custom, user.email);
    if (problem) return { problem };
  }
  const password = custom || generateTemporaryPassword();
  const timestamp = now();
  await c.env.DB.batch([
    c.env.DB.prepare(
      'UPDATE users SET password_hash = ?, password_updated_at = ?, must_change_password = 1, failed_login_count = 0, locked_until = NULL, updated_at = ? WHERE id = ? AND user_type = ?',
    ).bind(await hashPassword(password), timestamp, timestamp, user.id, kind),
    c.env.DB.prepare(
      'UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
    ).bind(timestamp, user.id),
    c.env.DB.prepare(
      'UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL',
    ).bind(timestamp, user.id),
  ]);
  await audit(c, `${kind}.temporary_password_issued`, 'user', user.id, {
    generated: !custom,
  });
  return { password };
}

export async function purgeOpportunityPublicCache(
  env: Env,
  slug: string,
  country?: string | null,
): Promise<{ configured: boolean; purged: boolean }> {
  if (!env.CLOUDFLARE_ZONE_ID || !env.CLOUDFLARE_CACHE_PURGE_TOKEN || !env.PUBLIC_BASE_URL)
    return { configured: false, purged: false };
  const base = env.PUBLIC_BASE_URL.replace(/\/$/, '');
  const urls = new Set([
    `${base}/`,
    `${base}/casinos-for-sale`,
    `${base}/casino-hotels`,
    `${base}/archive`,
    `${base}/sitemap.xml`,
    `${base}/opportunities/${encodeURIComponent(slug)}`,
  ]);
  if (country) urls.add(`${base}/casinos-for-sale/${encodeURIComponent(slugify(country))}`);
  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(env.CLOUDFLARE_ZONE_ID)}/purge_cache`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.CLOUDFLARE_CACHE_PURGE_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ files: [...urls] }),
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!response.ok) return { configured: true, purged: false };
    const result = (await response.json().catch(() => null)) as { success?: boolean } | null;
    return { configured: true, purged: result?.success === true };
  } catch {
    return { configured: true, purged: false };
  }
}

export async function audit(
  c: Context<{ Bindings: Env; Variables: { requestId: string; staff: StaffIdentity } }>,
  action: string,
  entityType: string,
  entityId: string,
  details: Record<string, unknown> = {},
) {
  const staff = c.get('staff');
  await c.env.DB.prepare(
    'INSERT INTO audit_logs (id, actor_user_id, actor_type, action, entity_type, entity_id, request_id, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(
      id(),
      staff.id,
      'staff',
      action,
      entityType,
      entityId,
      c.get('requestId'),
      JSON.stringify(details),
      now(),
    )
    .run();
}

export function mediaSignatureMatches(type: string, b: Uint8Array): boolean {
  const starts = (...v: number[]) => v.every((x, i) => b[i] === x);
  if (type === 'image/jpeg') return starts(0xff, 0xd8, 0xff);
  if (type === 'image/png') return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  if (type === 'image/gif') return new TextDecoder().decode(b.slice(0, 6)).match(/^GIF8[79]a$/) !== null;
  if (type === 'image/webp') return b.length >= 12 && new TextDecoder().decode(b.slice(0, 4)) === 'RIFF' && new TextDecoder().decode(b.slice(8, 12)) === 'WEBP';
  if (type === 'image/x-icon') return hasIcoSignature(b);
  if (type === 'image/svg+xml') return isSafeSvg(b);
  if (type === 'application/pdf') return new TextDecoder().decode(b.slice(0, 5)) === '%PDF-';
  if (type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return starts(0x50, 0x4b, 0x03, 0x04) || starts(0x50, 0x4b, 0x05, 0x06) || starts(0x50, 0x4b, 0x07, 0x08);
  return false;
}

export const STAGE_SQL = `CASE WHEN lifecycle = 'published' AND public_visibility = 1 THEN 'live' WHEN lifecycle IN ('sold','off_market','archived','on_hold','under_offer') THEN 'closed' WHEN content_review_status = 'approved' THEN 'ready' WHEN lifecycle = 'in_review' THEN 'review' ELSE 'draft' END`;

export const platformSettingKeys = [
  'site_name',
  'site_description',
  'logo_url',
  'logo_text',
  'favicon_url',
  'favicon_svg_url',
  'ga4_id',
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
  'whatsapp_number',
  'whatsapp_message',
  'contact_phone_mobile',
  'contact_phone_office',
  'contact_email',
  'contact_email_chairman',
  'primary_color',
  'accent_color',
  'background_color',
  'font_family',
  'header_navigation',
  'footer_navigation',
  'geo_sections',
  'homepage_sections',
  'notification_email',
  'font_heading',
  'font_body',
  'logo_alt',
  // Branding, social, chairman profile and e-mail widget (PHP-edition parity).
  'apple_touch_icon_url',
  'icon_192_url',
  'icon_512_url',
  'og_image_url',
  'chairman_image_url',
  'chairman_image_alt',
  'email_widget_enabled',
  'email_widget_address',
  'email_widget_subject',
  'chairman_name',
  'chairman_title',
  'chairman_bio',
  'chairman_expertise',
  'chairman_languages',
  'instagram_url',
  'linkedin_url',
  'footer_explore_navigation',
];
