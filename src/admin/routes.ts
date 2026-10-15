import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import type { Env } from '../env';
import { hasIcoSignature, isSafeSvg, MAX_SVG_BYTES } from '../security/svg-sanitizer';
import { brandUrl, instagramUrl, linkedinUrl } from '../web/branding';
import { staffAuth, requireRole, type StaffIdentity, STAFF_COOKIE } from '../auth/staff-session';
import { checkLifecycleTransition, transitionMatrix } from '../domain/opportunities/lifecycle';
import {
  DUPLICATE_LEGACY_ID_SQL,
  DUPLICATE_SLUG_SQL,
  RECONCILIATION_CHECKS,
  RECONCILIATION_GROUPINGS,
  buildReconciliationSql,
} from '../domain/opportunities/reconciliation';
import { hashPassword, issueResetToken, passwordPolicyError, readCookie, sha256Hex } from '../auth/password';
import { slugify } from '../domain/opportunities/slug';
import {
  getScannerMode,
  scanR2Document,
  ScannerError,
  SCANNER_MODE_KEY,
  SCAN_SKIPPED_PROVIDER,
} from '../security/malware-scanner';
import { STATIC_PAGES, staticPageSlug } from '../web/static-pages';

const admin = new Hono<{ Bindings: Env; Variables: { requestId: string; staff: StaffIdentity } }>();
admin.use('*', staffAuth());
const editorRoles = ['admin', 'editor', 'broker', 'super_admin'];
const publisherRoles = ['admin', 'publisher', 'super_admin'];
const opportunityInput = z.object({
  title: z.string().trim().min(3).max(180),
  country: z.string().trim().max(100).optional().default(''),
  opportunityType: z
    .enum(['casino-hotel', 'casino', 'hotel', 'resort', 'gaming-venue', 'other'])
    .default('casino-hotel'),
  classification: z
    .enum(['confidential', 'public', 'off_market', 'sold', 'under_offer', 'on_hold'])
    .default('confidential'),
  labels: z.array(z.string().trim().min(1).max(32)).max(12).default([]),
  priceText: z.string().trim().max(180).optional().default(''),
  priceVisibility: z.boolean().optional().default(false),
  summary: z.string().trim().max(1000).optional().default(''),
  bodyHtml: z.string().max(20000).optional().default(''),
  availability: z.string().trim().max(300).optional().default(''),
  seoTitle: z.string().trim().max(180).optional().default(''),
  seoDescription: z.string().trim().max(320).optional().default(''),
  assignedBrokerId: z.string().uuid().nullable().optional(),
});
const publicationInput = z.object({
  lifecycle: z.enum([
    'draft',
    'in_review',
    'published',
    'on_hold',
    'under_offer',
    'sold',
    'off_market',
    'archived',
  ]),
  publicVisibility: z.boolean(),
  changeReason: z.string().trim().min(3).max(500),
});
const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const escapeHtml = (s: unknown) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
  );

function csvCell(value: unknown): string {
  const text = value == null ? '' : typeof value === 'string' ? value : String(value);
  // Prevent spreadsheet formula execution while preserving ordinary text.
  const safe = /^[\s]*[=+@]/.test(text) || /^[\s]*-/.test(text) ? `'${text}` : text;
  // Also neutralise a leading tab or carriage return.
  const guarded = /^[=+\-@\t\r]/.test(safe) ? `'${safe}` : safe;
  return `"${guarded.replace(/"/g, '""')}"`;
}

function parseCsvRows(source: string): string[][] | null {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell.length === 0) quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i += 1;
      row.push(cell); cell = '';
      if (row.some((value) => value.trim() !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (quoted) return null;
  row.push(cell);
  if (row.some((value) => value.trim() !== '')) rows.push(row);
  return rows;
}

const TEMP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
/** 14 unambiguous characters from a CSPRNG (rejection sampling, no modulo bias). */
function generateTemporaryPassword(): string {
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
async function issueTemporaryPassword(
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

async function purgeOpportunityPublicCache(
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

function hasExpectedFileSignature(contentType: string, bytes: Uint8Array): boolean {
  const starts = (...signature: number[]) =>
    signature.every((value, index) => bytes[index] === value);
  if (contentType === 'application/pdf')
    return bytes.length >= 5 && new TextDecoder().decode(bytes.slice(0, 5)) === '%PDF-';
  if (contentType === 'image/jpeg') return starts(0xff, 0xd8, 0xff);
  if (contentType === 'image/png') return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  // DOCX and XLSX are ZIP containers. This checks the container signature, not its internal structure or safety.
  if (
    contentType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    contentType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  )
    return (
      starts(0x50, 0x4b, 0x03, 0x04) ||
      starts(0x50, 0x4b, 0x05, 0x06) ||
      starts(0x50, 0x4b, 0x07, 0x08)
    );
  return false;
}

async function audit(
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

/** Browsers label .ico and .svg files inconsistently; settle the type from the extension for those two. */
function normalizeMediaType(name: string, declared: string): string {
  const lower = name.toLowerCase();
  const type = declared.toLowerCase();
  if (
    lower.endsWith('.ico') &&
    ['', 'application/octet-stream', 'image/x-ico', 'image/vnd.microsoft.icon', 'image/x-icon'].includes(type)
  )
    return 'image/x-icon';
  if (
    lower.endsWith('.svg') &&
    ['', 'image/svg+xml', 'text/xml', 'text/plain', 'application/xml'].includes(type)
  )
    return 'image/svg+xml';
  return type;
}

const mediaMimeExtensions = new Map<string, string>([
  ['image/jpeg', '.jpg'], ['image/png', '.png'], ['image/webp', '.webp'], ['image/gif', '.gif'],
  // Logos and favicons (PHP-edition parity): SVG is screened by isSafeSvg(); ICO by its header.
  ['image/svg+xml', '.svg'], ['image/x-icon', '.ico'],
  ['application/pdf', '.pdf'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx'],
]);
function mediaSignatureMatches(type: string, b: Uint8Array): boolean {
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

admin.get('/media/ui', requireRole('admin', 'editor', 'publisher', 'super_admin'), (c) => c.html(
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Media library · Casinos of Mayfair</title><link rel="stylesheet" href="/static/css/site.css"><link rel="stylesheet" href="/static/css/dashboard.css"><link rel="stylesheet" href="/static/css/dashboard-media.css"></head><body><main class="admin"><p class="eyebrow">STAFF WORKSPACE</p><h1>Media library</h1><nav class="admin-nav"><a href="/dashboard">Overview</a><a href="/dashboard/opportunities/ui">Opportunities</a><a href="/dashboard/media/ui" aria-current="page">Media library</a><a href="/dashboard/settings/ui">Settings</a><a href="/dashboard/pages/ui">Pages</a><a href="/admin/logout">Sign out</a></nav><p class="muted">Manage images and documents in one place. Public files are available to website pages; private files remain staff-only. Changing a file to public should only be done when you have rights to publish it and it contains no confidential information.</p><section class="ml-toolbar"><input id="ml-search" type="search" placeholder="Search filenames, captions or alt text" aria-label="Search media"><select id="ml-kind" aria-label="File type"><option value="all">All file types</option><option value="image">Images</option><option value="document">Documents</option></select><select id="ml-visibility" aria-label="Visibility"><option value="">All visibility</option><option value="public">Public</option><option value="private">Private</option></select><button id="ml-refresh" type="button">Refresh</button><label class="ml-upload">Upload files<input id="ml-upload" type="file" multiple accept="image/jpeg,image/png,image/webp,image/gif,image/svg+xml,image/x-icon,.svg,.ico,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"></label></section><p id="ml-notice" role="status" aria-live="polite"></p><section id="ml-grid" class="ml-grid" aria-live="polite"><p>Loading media…</p></section><dialog id="ml-edit" class="ml-edit"><form id="ml-edit-form" method="dialog"><h2>Edit media details</h2><input type="hidden" name="id"><label>Filename<input name="filename" maxlength="180" required></label><label>Alternative text (images)<input name="altText" maxlength="240"></label><label>Caption / notes<textarea name="caption" maxlength="500"></textarea></label><label>Folder<input name="folder" maxlength="80" pattern="[a-zA-Z0-9 _-]+" required></label><label>Custom public URL slug (optional)<input name="publicSlug" maxlength="100" pattern="[a-zA-Z0-9-]+" placeholder="e.g. london-casino-exterior"></label><label>Visibility<select name="visibility"><option value="private">Private — staff only</option><option value="public">Public — website accessible</option></select></label><p class="muted">Public URLs can be embedded in public pages. Do not publish confidential deal-room documents.</p><div class="ml-actions"><button type="button" id="ml-edit-cancel">Cancel</button><button type="submit">Save changes</button></div></form></dialog></main><script src="/static/js/dashboard-media.js" defer></script></body></html>`
));

admin.get('/media', requireRole('admin', 'editor', 'publisher', 'super_admin'), async (c) => {
  const q = (c.req.query('q') || '').trim().slice(0, 100).toLowerCase();
  const kind = c.req.query('type') || 'all';
  const visibility = c.req.query('visibility') || '';
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') || 60)));
  const clauses: string[] = [];
  const args: (string | number)[] = [];
  if (q) { clauses.push("(lower(filename) LIKE ? ESCAPE '\\' OR lower(alt_text) LIKE ? ESCAPE '\\' OR lower(caption) LIKE ? ESCAPE '\\')"); const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`; args.push(like, like, like); }
  if (kind === 'image') clauses.push("content_type LIKE 'image/%'");
  if (kind === 'document') clauses.push("content_type NOT LIKE 'image/%'");
  if (visibility === 'public' || visibility === 'private') { clauses.push('visibility = ?'); args.push(visibility); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = await c.env.DB.prepare(`SELECT id, filename, content_type AS contentType, byte_size AS byteSize, alt_text AS altText, caption, folder, visibility, public_slug AS publicSlug, created_at AS createdAt FROM media_assets ${where} ORDER BY created_at DESC LIMIT ?`).bind(...args, limit).all();
  return c.json({ data: (rows.results || []).map((row) => ({ ...row, url: (row as { visibility: string }).visibility === 'public' ? `/media/${encodeURIComponent(String((row as { publicSlug?: string | null }).publicSlug || (row as { id: string }).id))}` : null })) });
});

admin.post('/media/upload', requireRole('admin', 'editor', 'publisher', 'super_admin'), async (c) => {
  const body = await c.req.parseBody({ all: true });
  const files = (Array.isArray(body.file) ? body.file : [body.file]).filter((f): f is File => f instanceof File && f.size > 0);
  if (!files.length) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Choose at least one file.' } }, 422);
  if (files.length > 10) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Upload up to 10 files at a time.' } }, 422);
  if (files.reduce((total, file) => total + file.size, 0) > 50 * 1024 * 1024) return c.json({ error: { code: 'REQUEST_TOO_LARGE', message: 'Keep the combined upload below 50 MiB.' } }, 413);
  const uploaded: Record<string, unknown>[] = [];
  for (const file of files) {
    if (file.size > 25 * 1024 * 1024) return c.json({ error: { code: 'FILE_TOO_LARGE', message: `${file.name} exceeds 25 MiB.` } }, 413);
    const type = normalizeMediaType(file.name, file.type);
    const ext = mediaMimeExtensions.get(type);
    if (type === 'image/svg+xml' && file.size > MAX_SVG_BYTES) return c.json({ error: { code: 'FILE_TOO_LARGE', message: `${file.name}: SVG files are limited to 512 KiB.` } }, 413);
    if (!ext) return c.json({ error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: `${file.name}: allowed types are JPEG, PNG, WebP, GIF, SVG, ICO, PDF, DOCX and XLSX.` } }, 415);
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (type === 'image/svg+xml' && !isSafeSvg(bytes)) return c.json({ error: { code: 'UNSAFE_SVG', message: `${file.name}: the SVG contains scripts, event handlers, external references, embedded documents or animation, which are not allowed.` } }, 415);
    if (!mediaSignatureMatches(type, bytes)) return c.json({ error: { code: 'INVALID_FILE_SIGNATURE', message: `${file.name}: file contents do not match the declared file type.` } }, 415);
    const mediaId = id();
    const timestamp = now();
    // eslint-disable-next-line no-control-regex -- intentionally strips control characters from filenames
    const safeName = file.name.replace(/[\\/\r\n\u0000-\u001f]/g, '_').slice(0, 180) || `file${ext}`;
    const key = `media/${mediaId}${ext}`;
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const sha256 = [...new Uint8Array(digest)].map((v) => v.toString(16).padStart(2, '0')).join('');
    // Images may be made public for site use; uploaded documents remain private until explicitly reviewed.
    const visibility = type.startsWith('image/') ? 'public' : 'private';
    await c.env.PRIVATE_FILES.put(key, bytes.buffer as ArrayBuffer, { httpMetadata: { contentType: type, cacheControl: 'private, no-store' }, customMetadata: { mediaId, sha256, originalName: safeName } });
    try {
      await c.env.DB.prepare('INSERT INTO media_assets (id, r2_key, filename, content_type, byte_size, sha256, folder, visibility, uploaded_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(mediaId, key, safeName, type, file.size, sha256, 'general', visibility, c.get('staff').id, timestamp, timestamp).run();
      await audit(c, 'media.uploaded', 'media_asset', mediaId, { contentType: type, byteSize: file.size, sha256 });
    } catch (error) { await c.env.PRIVATE_FILES.delete(key); throw error; }
    uploaded.push({ id: mediaId, filename: safeName, contentType: type, byteSize: file.size, visibility, url: visibility === 'public' ? `/media/${encodeURIComponent(mediaId)}` : null, createdAt: timestamp });
  }
  return c.json({ data: uploaded }, 201);
});

admin.patch('/media/:id', requireRole('admin', 'editor', 'publisher', 'super_admin'), async (c) => {
  const parsed = z.object({ filename: z.string().trim().min(1).max(180).optional(), altText: z.string().trim().max(240).optional(), caption: z.string().trim().max(500).optional(), folder: z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9 _-]+$/).optional(), publicSlug: z.string().trim().max(100).regex(/^[a-zA-Z0-9-]+$/).optional().or(z.literal('')), visibility: z.enum(['public', 'private']).optional() }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid media details.' } }, 422);
  const existing = await c.env.DB.prepare('SELECT id, content_type AS contentType, visibility, public_slug AS publicSlug FROM media_assets WHERE id = ?').bind(c.req.param('id')).first<{ id: string; contentType: string; visibility: string; publicSlug: string | null }>();
  if (!existing) return c.json({ error: { code: 'NOT_FOUND', message: 'Media item not found.' } }, 404);
  const patch = parsed.data;
  if (patch.publicSlug) {
    const duplicateSlug = await c.env.DB.prepare('SELECT id FROM media_assets WHERE (public_slug = ? OR id = ?) AND id != ? LIMIT 1').bind(patch.publicSlug, patch.publicSlug, existing.id).first();
    if (duplicateSlug) return c.json({ error: { code: 'SLUG_CONFLICT', message: 'That public URL slug is already in use.' } }, 409);
  }
  if (patch.publicSlug !== undefined && patch.publicSlug !== (existing.publicSlug ?? '') && existing.publicSlug) {
    const oldPath = `/media/${existing.publicSlug}`;
    const [settings, pages, forms, opportunities] = await Promise.all([
      c.env.DB.prepare('SELECT setting_key AS name FROM platform_settings WHERE value_json LIKE ? LIMIT 20').bind(`%${oldPath}%`).all<{ name: string }>(),
      c.env.DB.prepare("SELECT slug AS name FROM managed_pages WHERE body_markdown LIKE ? OR description LIKE ? OR seo_title LIKE ? OR seo_description LIKE ? LIMIT 20").bind(`%${oldPath}%`, `%${oldPath}%`, `%${oldPath}%`, `%${oldPath}%`).all<{ name: string }>(),
      c.env.DB.prepare("SELECT slug AS name FROM managed_forms WHERE fields_json LIKE ? OR description LIKE ? LIMIT 20").bind(`%${oldPath}%`, `%${oldPath}%`).all<{ name: string }>(),
      c.env.DB.prepare('SELECT slug AS name FROM opportunities WHERE body_html LIKE ? OR summary LIKE ? OR seo_title LIKE ? OR seo_description LIKE ? LIMIT 20').bind(`%${oldPath}%`, `%${oldPath}%`, `%${oldPath}%`, `%${oldPath}%`).all<{ name: string }>(),
    ]);
    const refs = [
      ...(settings.results ?? []).map((row) => `setting:${row.name}`),
      ...(pages.results ?? []).map((row) => `page:${row.name}`),
      ...(forms.results ?? []).map((row) => `form:${row.name}`),
      ...(opportunities.results ?? []).map((row) => `opportunity:${row.name}`),
    ];
    if (refs.length) return c.json({ error: { code: 'MEDIA_URL_IN_USE', message: 'This URL slug is referenced by managed content. Update those references before changing the slug.', references: refs.slice(0, 30) } }, 409);
  }
  if (patch.visibility === 'public' && existing.visibility !== 'public' && c.get('staff').role !== 'admin' && c.get('staff').role !== 'super_admin') return c.json({ error: { code: 'FORBIDDEN', message: 'Only administrators can publish media.' } }, 403);
  if (patch.visibility === 'public' && existing.visibility !== 'public' && !existing.contentType.startsWith('image/') && c.get('staff').role !== 'super_admin') return c.json({ error: { code: 'FORBIDDEN', message: 'Only a super administrator can publish document files. Review confidentiality and rights first.' } }, 403);
  const sets: string[] = []; const args: (string | number | null)[] = [];
  for (const [key, column] of [['filename','filename'],['altText','alt_text'],['caption','caption'],['folder','folder'],['publicSlug','public_slug'],['visibility','visibility']] as const) { const value = patch[key]; if (value !== undefined) { sets.push(`${column} = ?`); args.push(value === '' ? null : value); } }
  if (!sets.length) return c.json({ data: { id: existing.id } });
  sets.push('updated_at = ?'); args.push(now(), existing.id);
  await c.env.DB.prepare(`UPDATE media_assets SET ${sets.join(', ')} WHERE id = ?`).bind(...args).run();
  await audit(c, patch.visibility && patch.visibility !== existing.visibility ? 'media.visibility_changed' : 'media.updated', 'media_asset', existing.id, { fields: Object.keys(patch), previousVisibility: existing.visibility, visibility: patch.visibility ?? existing.visibility, publicSlug: patch.publicSlug ?? existing.publicSlug });
  return c.json({ data: { id: existing.id, ...patch, url: (patch.visibility || existing.visibility) === 'public' ? `/media/${encodeURIComponent((patch.publicSlug === undefined ? existing.publicSlug : patch.publicSlug) || existing.id)}` : null } });
});

admin.get('/media/:id/download', requireRole('admin', 'editor', 'publisher', 'super_admin'), async (c) => {
  const asset = await c.env.DB.prepare('SELECT r2_key AS r2Key, filename, content_type AS contentType FROM media_assets WHERE id = ?').bind(c.req.param('id')).first<{ r2Key: string; filename: string; contentType: string }>();
  if (!asset) return c.json({ error: { code: 'NOT_FOUND', message: 'Media item not found.' } }, 404);
  const object = await c.env.PRIVATE_FILES.get(asset.r2Key);
  if (!object) return c.json({ error: { code: 'NOT_FOUND', message: 'Stored file not found.' } }, 404);
  const headers = new Headers(); headers.set('Content-Type', asset.contentType); headers.set('Content-Disposition', `attachment; filename="${asset.filename.replace(/["\\\r\n]/g, '_')}"`); headers.set('Cache-Control', 'private, no-store'); headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(object.body, { headers });
});

admin.delete('/media/:id', requireRole('admin', 'super_admin'), async (c) => {
  const asset = await c.env.DB.prepare('SELECT id, r2_key AS r2Key, filename, public_slug AS publicSlug FROM media_assets WHERE id = ?').bind(c.req.param('id')).first<{ id: string; r2Key: string; filename: string; publicSlug: string | null }>();
  if (!asset) return c.json({ error: { code: 'NOT_FOUND', message: 'Media item not found.' } }, 404);
  const publicPaths = [`/media/${asset.id}`, ...(asset.publicSlug ? [`/media/${asset.publicSlug}`] : [])];
  const references: { type: string; name: string }[] = [];
  for (const path of publicPaths) {
    const settings = await c.env.DB.prepare('SELECT setting_key AS name FROM platform_settings WHERE value_json LIKE ? LIMIT 20').bind(`%${path}%`).all<{ name: string }>();
    for (const row of settings.results ?? []) references.push({ type: 'platform setting', name: row.name });
    const pages = await c.env.DB.prepare("SELECT slug AS name FROM managed_pages WHERE (body_markdown LIKE ? OR description LIKE ? OR seo_title LIKE ? OR seo_description LIKE ?) LIMIT 20").bind(`%${path}%`, `%${path}%`, `%${path}%`, `%${path}%`).all<{ name: string }>();
    for (const row of pages.results ?? []) references.push({ type: 'managed page', name: row.name });
    const forms = await c.env.DB.prepare("SELECT slug AS name FROM managed_forms WHERE (fields_json LIKE ? OR description LIKE ?) LIMIT 20").bind(`%${path}%`, `%${path}%`).all<{ name: string }>();
    for (const row of forms.results ?? []) references.push({ type: 'managed form', name: row.name });
    const opportunities = await c.env.DB.prepare('SELECT slug AS name FROM opportunities WHERE body_html LIKE ? OR summary LIKE ? OR seo_title LIKE ? OR seo_description LIKE ? LIMIT 20').bind(`%${path}%`, `%${path}%`, `%${path}%`, `%${path}%`).all<{ name: string }>();
    for (const row of opportunities.results ?? []) references.push({ type: 'opportunity', name: row.name });
  }
  const uniqueReferences = references.filter((reference, index, all) => all.findIndex((other) => other.type === reference.type && other.name === reference.name) === index);
  if (uniqueReferences.length) {
    return c.json({ error: { code: 'MEDIA_IN_USE', message: 'This media is referenced by managed content. Replace or unlink those references before deleting it.', references: uniqueReferences.slice(0, 30) } }, 409);
  }
  await c.env.DB.prepare('DELETE FROM media_assets WHERE id = ?').bind(asset.id).run();
  await c.env.PRIVATE_FILES.delete(asset.r2Key);
  await audit(c, 'media.deleted', 'media_asset', asset.id, { filename: asset.filename });
  return c.json({ data: { id: asset.id, deleted: true } });
});

admin.get('/', async (c) => {
  const staff = c.get('staff');
  const brokerOnly = staff.role === 'broker' ? 1 : 0;
  const [counts, pending, recent] = await Promise.all([
    c.env.DB.prepare(
      "SELECT COUNT(*) AS total, SUM(CASE WHEN content_review_status = 'pending' THEN 1 ELSE 0 END) AS pending, SUM(CASE WHEN lifecycle = 'published' AND public_visibility = 1 AND content_review_status = 'approved' THEN 1 ELSE 0 END) AS published FROM opportunities WHERE (? = 0 OR assigned_broker_id = ?)",
    )
      .bind(brokerOnly, staff.id)
      .first<{ total: number; pending: number; published: number }>(),
    c.env.DB.prepare(
      "SELECT id, title, country, legacy_status AS legacyStatus, updated_at AS updatedAt FROM opportunities WHERE content_review_status = 'pending' AND (? = 0 OR assigned_broker_id = ?) ORDER BY updated_at DESC LIMIT 8",
    )
      .bind(brokerOnly, staff.id)
      .all(),
    c.env.DB.prepare(
      'SELECT id, title, country, lifecycle, content_review_status AS reviewStatus, updated_at AS updatedAt FROM opportunities WHERE (? = 0 OR assigned_broker_id = ?) ORDER BY updated_at DESC LIMIT 10',
    )
      .bind(brokerOnly, staff.id)
      .all(),
  ]);
  const escape = (s: unknown) =>
    String(s ?? '').replace(
      /[&<>"']/g,
      (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
    );
  const toneFor = (value: unknown): string => {
    const v = String(value ?? '').toLowerCase();
    if (v === 'approved' || v === 'published') return 'ok';
    if (v === 'pending' || v === 'draft' || v === 'under_offer' || v === 'on_hold') return 'warn';
    if (v === 'rejected' || v === 'sold' || v === 'archived') return 'danger';
    return '';
  };
  const badge = (value: unknown) => {
    const tone = toneFor(value);
    return `<span class="ws-badge${tone ? ` ws-badge--${tone}` : ''}">${escape(String(value ?? '—').replace(/_/g, ' '))}</span>`;
  };
  const rows = (recent.results ?? [])
    .map((item) => {
      const row = item as Record<string, unknown>;
      return `<tr><td>${escape(row.title)}</td><td>${escape(row.country || '—')}</td><td>${badge(row.lifecycle)}</td><td>${badge(row.reviewStatus)}</td><td><a href="/dashboard/opportunities/ui?selected=${encodeURIComponent(String(row.id))}">Open</a></td></tr>`;
    })
    .join('');
  const pendingRows = (pending.results ?? [])
    .map((item) => {
      const row = item as Record<string, unknown>;
      return `<li><a href="/dashboard/opportunities/ui?selected=${encodeURIComponent(String(row.id))}">${escape(row.title)}</a><span class="ws-badge">${escape(row.country || 'Country not set')}</span></li>`;
    })
    .join('');
  return c.html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Staff dashboard · Casinos of Mayfair</title><link rel="stylesheet" href="/static/css/site.css"><link rel="stylesheet" href="/static/css/dashboard.css"></head><body><main class="admin"><p class="eyebrow">STAFF WORKSPACE</p><h1>Platform dashboard</h1><p class="muted">Signed in as ${escape(staff.displayName || staff.email)} · ${escape(staff.role)}</p><nav class="admin-nav"><a href="/dashboard">Overview</a><a href="/dashboard/opportunities/ui">Opportunity CMS</a><a href="/dashboard/opportunities/review-queue/ui">Needs review</a><a href="/dashboard/buyers/ui">Buyer access</a><a href="/dashboard/enquiries/ui">Enquiries</a><a href="/dashboard/tasks/ui">Tasks</a><a href="/dashboard/notifications/ui">Notifications</a><a href="/dashboard/nda-requests/ui">NDA requests</a><a href="/dashboard/access-grants/ui">Access grants</a><a href="/dashboard/documents/ui">Data room documents</a><a href="/dashboard/nda-templates/ui">NDA templates</a><a href="/dashboard/audit/ui">Audit log</a>${staff.role === 'super_admin' ? '<a href="/dashboard/staff/ui">Staff accounts</a><a href="/dashboard/sessions/ui">Staff sessions</a><a href="/dashboard/buyer-sessions/ui">Buyer sessions</a>' : ''}<a href="/dashboard/settings/ui">Platform settings</a><a href="/dashboard/pages/ui">Pages</a><a href="/dashboard/forms/ui">Forms</a><a href="/admin/change-password">Change password</a><a href="/">View public site</a><a href="/admin/logout">Sign out</a></nav><section class="metric-grid" aria-label="Key numbers"><a class="metric" href="/dashboard/opportunities/ui"><span class="muted">Total records</span><strong>${counts?.total ?? 0}</strong><small>Opportunities you can access</small></a><a class="metric" href="/dashboard/opportunities/ui" data-tone="${(counts?.pending ?? 0) > 0 ? 'warn' : 'ok'}"><span class="muted">Awaiting review</span><strong>${counts?.pending ?? 0}</strong><small>${(counts?.pending ?? 0) > 0 ? 'Content waiting for a decision' : 'Nothing waiting'}</small></a><a class="metric" href="/dashboard/opportunities/ui" data-tone="ok"><span class="muted">Published &amp; approved</span><strong>${counts?.published ?? 0}</strong><small>Visible on the public site</small></a></section><h2>Quick actions</h2><section class="quick-grid" aria-label="Quick actions"><a class="quick-card" href="/dashboard/opportunities/ui"><strong>Opportunity CMS</strong><span>Create, edit, review and publish listings.</span></a><a class="quick-card" href="/dashboard/nda-requests/ui"><strong>NDA requests</strong><span>Review requests and grant time-limited access.</span></a><a class="quick-card" href="/dashboard/buyers/ui"><strong>Buyer access</strong><span>Approve registrations and manage accounts.</span></a><a class="quick-card" href="/dashboard/tasks/ui"><strong>Tasks</strong><span>Assign and track operational follow-ups.</span></a><a class="quick-card" href="/dashboard/pages/ui"><strong>Pages</strong><span>Write and publish SEO-friendly content pages.</span></a><a class="quick-card" href="/dashboard/settings/ui"><strong>Platform settings</strong><span>Branding, contact channels and navigation.</span></a></section><div class="dash-cols"><section class="ws-card"><h2>Needs content review</h2>${pendingRows ? `<ul class="review-list">${pendingRows}</ul>` : '<p class="empty-state">No records awaiting review.</p>'}</section><section><h2>Recently updated opportunities</h2><div class="overflow-x-auto"><table><thead><tr><th>Title</th><th>Country</th><th>Lifecycle</th><th>Review</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="5">No records yet.</td></tr>'}</tbody></table></div></section></div></main></body></html>`,
  );
});

admin.get(
  '/brokers',
  requireRole('admin', 'editor', 'broker', 'publisher', 'super_admin'),
  async (c) => {
    const result = await c.env.DB.prepare(
      "SELECT id, display_name AS displayName, email FROM users WHERE user_type = 'staff' AND status = 'active' AND role = 'broker' ORDER BY display_name COLLATE NOCASE",
    ).all();
    return c.json({ data: result.results ?? [] });
  },
);

admin.get(
  '/opportunities/ui',
  requireRole('admin', 'editor', 'broker', 'publisher', 'super_admin'),
  async (c) =>
    c.html(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Opportunities · Casinos of Mayfair</title><link rel="stylesheet" href="/static/css/site.css"><link rel="stylesheet" href="/static/css/dashboard.css"></head><body><main class="admin" data-role="${c.get('staff').role}"><p class="eyebrow">STAFF WORKSPACE</p><h1>Opportunities</h1><nav class="admin-nav"><a href="/dashboard">Overview</a><a href="/dashboard/opportunities/review-queue/ui">Needs review</a><a href="/dashboard/buyers/ui">Buyer access</a><a href="/dashboard/nda-requests/ui">NDA requests</a><a href="/dashboard/access-grants/ui">Access grants</a><a href="/admin/logout">Sign out</a></nav><section id="op-list-view"><p class="muted">Every listing moves through three simple steps: <strong>Draft</strong>, <strong>Approved</strong>, <strong>Live</strong>. Use the buttons in each row, or open a listing to edit it.</p><div class="dx-toolbar"><div class="dx-tabs" id="op-tabs" role="tablist"><button type="button" class="dx-tab" role="tab" data-tab="all" aria-selected="false">All<span class="dx-count">0</span></button><button type="button" class="dx-tab" role="tab" data-tab="live" aria-selected="false">Live<span class="dx-count">0</span></button><button type="button" class="dx-tab" role="tab" data-tab="ready" aria-selected="false">Ready to publish<span class="dx-count">0</span></button><button type="button" class="dx-tab" role="tab" data-tab="review" aria-selected="false">In review<span class="dx-count">0</span></button><button type="button" class="dx-tab" role="tab" data-tab="draft" aria-selected="false">Drafts<span class="dx-count">0</span></button><button type="button" class="dx-tab" role="tab" data-tab="closed" aria-selected="false">Closed<span class="dx-count">0</span></button></div><input class="dx-search" id="op-search" type="search" maxlength="100" placeholder="Search title, country or address" aria-label="Search opportunities"><span class="dx-spacer"></span>${['admin','super_admin'].includes(c.get('staff').role) ? '<a class="dx-btn" href="/dashboard/opportunities/export.csv">Export CSV</a><button type="button" class="dx-btn" id="op-import">Import CSV</button><input type="file" id="op-import-file" accept="text/csv,.csv" hidden>' : ''}<a class="dx-btn dx-btn-primary" href="#new" id="op-new">New opportunity</a></div><div class="dx-bulkbar" id="op-bulk" hidden><span id="op-bulk-count"></span><button type="button" class="dx-btn dx-btn-sm dx-btn-primary" data-bulk="approved">Approve selected</button><button type="button" class="dx-btn dx-btn-sm dx-btn-ghost-danger" data-bulk="rejected">Reject selected</button><button type="button" class="dx-btn dx-btn-sm" data-bulk="clear">Clear</button></div><div id="op-table" class="dx-table-wrap">Loading…</div><div class="dx-pager" id="op-pager"></div></section><section id="op-editor-view" hidden><div class="dx-editor-bar"><a class="dx-btn" href="#list" id="op-back">← All opportunities</a><h2 id="op-heading">New opportunity</h2><span id="op-stage-badge"></span><span class="dx-spacer"></span><a class="dx-btn" id="op-view-live" target="_blank" rel="noopener" hidden>View live</a><button type="submit" form="op-form" class="dx-btn dx-btn-primary" id="op-save">Save draft</button><button type="button" class="dx-btn" id="op-save-publish" hidden>Save &amp; publish</button></div><p class="dx-note dx-note-warn" id="op-live-warning" hidden>This listing is live. Saving sends it back for approval and takes it off the website until it is published again. Publishers can use <strong>Save &amp; publish</strong> to keep it live.</p><form id="op-form" class="dx-editor"><input type="hidden" name="id"><div class="dx-editor-main"><div class="dx-card"><h3>The opportunity</h3><label class="dx-field">Title<input name="title" minlength="3" maxlength="180" required></label><div class="dx-row"><label class="dx-field">Country or region<input name="country" maxlength="100"></label><label class="dx-field">Type<select name="opportunityType"><option value="casino-hotel">Casino &amp; hotel</option><option value="casino">Casino</option><option value="hotel">Hotel</option><option value="resort">Resort</option><option value="gaming-venue">Gaming venue</option><option value="other">Other</option></select></label></div><div class="dx-row"><label class="dx-field">Price<input name="priceText" maxlength="180" placeholder="e.g. EUR 12,500,000"></label><label class="dx-field">Availability<input name="availability" maxlength="300" placeholder="e.g. Available now"></label></div><label class="dx-check"><input type="checkbox" name="priceVisibility"> Show the price publicly <small>(publishers only; otherwise it reads &quot;Price on request&quot;)</small></label></div><div class="dx-card"><h3>Description</h3><label class="dx-field">Short summary<small>Shown on the listing card. Up to 1,000 characters.</small><textarea name="summary" maxlength="1000" rows="4"></textarea></label><label class="dx-field">Highlights<small>Separate with commas, up to 12. Example: Freehold, Resort, Premium.</small><input name="labels" maxlength="400"></label><label class="dx-field">Full description<small>HTML allowed. Staff-only editing.</small><textarea name="bodyHtml" maxlength="20000" rows="12"></textarea></label></div><details class="dx-card"><summary>Search appearance (optional)</summary><div class="dx-form"><label class="dx-field">SEO title<input name="seoTitle" maxlength="180"></label><label class="dx-field">SEO description<textarea name="seoDescription" maxlength="320" rows="2"></textarea></label></div></details></div><aside class="dx-editor-side"><div class="dx-card" id="op-publish-card" hidden><h3>Publishing</h3><ol class="dx-steps" id="op-steps"><li data-step="draft">Draft saved</li><li data-step="approved">Approved</li><li data-step="live">Live on website</li></ol><p class="dx-secondary" id="op-publish-help"></p><div class="dx-stack" id="op-publish-actions"></div></div><div class="dx-card"><h3>Settings</h3><label class="dx-field">Visibility class<select name="classification"><option value="confidential">Confidential</option><option value="public">Public</option><option value="off_market">Off market</option><option value="under_offer">Under offer</option><option value="on_hold">On hold</option><option value="sold">Sold</option></select><small>Only Public listings can appear on the website.</small></label><label class="dx-field">Assigned broker<select name="assignedBrokerId"><option value="">Unassigned</option></select></label></div><div class="dx-card" id="op-media-card" hidden><h3>Images</h3><p class="dx-secondary">JPG, PNG, WebP or GIF up to 8 MiB. The first image is the cover.</p><div class="dx-form" id="op-media-form"><label class="dx-field">Image<input type="file" id="op-media-file" accept="image/jpeg,image/png,image/webp,image/gif"></label><label class="dx-field">Short description (for accessibility)<input id="op-alt-text" data-no-media-picker maxlength="240" placeholder="e.g. Hotel exterior at dusk"></label><button type="button" class="dx-btn" id="op-media-upload">Upload from this device</button></div><div class="dx-form dx-picker-block" id="op-lib-block"><label class="dx-field">Image from the Media library<input id="op-lib-url" readonly placeholder="No image chosen yet"></label><label class="dx-field">Short description (for accessibility)<input id="op-lib-alt" data-no-media-picker maxlength="240" placeholder="e.g. Hotel exterior at dusk"></label><button type="button" class="dx-btn" id="op-lib-add">Add chosen image to listing</button></div><ul class="dx-list" id="op-media-list"></ul></div><details class="dx-card" id="op-history-card" hidden><summary>Version history</summary><ul class="dx-list" id="op-history-list"></ul></details></aside></form></section></main><script src="/static/js/dashboard-kit.js" defer></script><script src="/static/js/dashboard-opportunities.js" defer></script></body></html>`,
    ),
);

admin.get('/opportunities/review-queue/ui', requireRole('admin', 'editor', 'broker', 'publisher', 'super_admin'), (c) => c.html(
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Needs review · Casinos of Mayfair</title><link rel="stylesheet" href="/static/css/site.css"><link rel="stylesheet" href="/static/css/dashboard.css"></head><body><main class="admin"><p class="eyebrow">STAFF WORKSPACE</p><h1>Needs review</h1><nav class="admin-nav"><a href="/dashboard">Overview</a><a href="/dashboard/opportunities/ui">Opportunity CMS</a><a href="/dashboard/opportunities/review-queue/ui" aria-current="page">Needs review</a><a href="/dashboard/audit/ui">Audit log</a></nav><p class="muted">Review pending content, missing information and listings whose verification is older than 180 days. This queue never publishes a listing.</p><p id="review-queue-notice" role="status" aria-live="polite">Loading review queue…</p><div class="overflow-x-auto"><table><thead><tr><th>Opportunity</th><th>Country</th><th>Status</th><th>Reasons</th><th>Last verified</th><th>Action</th></tr></thead><tbody id="review-queue-rows"></tbody></table></div></main><script src="/static/js/dashboard-review-queue.js" defer></script></body></html>`
));

admin.get('/opportunities/review-queue', requireRole('admin', 'editor', 'broker', 'publisher', 'super_admin'), async (c) => {
  const staff = c.get('staff');
  const rows = await c.env.DB.prepare(
    `SELECT id, title, country, price_text AS priceText, summary, lifecycle,
      content_review_status AS reviewStatus, public_visibility AS publicVisibility,
      classification, last_verified_at AS lastVerifiedAt, updated_at AS updatedAt,
      assigned_broker_id AS assignedBrokerId
     FROM opportunities
     WHERE (? = 0 OR assigned_broker_id = ?)
       AND (content_review_status = 'pending' OR country IS NULL OR trim(country) = ''
         OR trim(summary) = '' OR last_verified_at IS NULL OR last_verified_at < ?
         OR (trim(price_text) <> '' AND price_minor IS NULL AND currency IS NULL))
     ORDER BY CASE WHEN content_review_status = 'pending' THEN 0 ELSE 1 END, updated_at ASC
     LIMIT 250`,
  ).bind(staff.role === 'broker' ? 1 : 0, staff.id, new Date(Date.now() - 180 * 86400000).toISOString()).all<{
    id: string; title: string; country: string | null; priceText: string; summary: string;
    lifecycle: string; reviewStatus: string; publicVisibility: number; classification: string;
    lastVerifiedAt: string | null; updatedAt: string; assignedBrokerId: string | null;
  }>();
  const data = (rows.results ?? []).map((row) => {
    const reasons: string[] = [];
    if (row.reviewStatus === 'pending') reasons.push('content_review_pending');
    if (!row.country?.trim()) reasons.push('country_missing');
    if (!row.summary.trim()) reasons.push('summary_missing');
    if (!row.lastVerifiedAt) reasons.push('never_verified');
    else if (Date.parse(row.lastVerifiedAt) < Date.now() - 180 * 86400000) reasons.push('verification_stale');
    if (row.priceText.trim() && !row.priceText.match(/\d/) ) reasons.push('price_needs_review');
    if (row.lifecycle === 'published' && row.publicVisibility !== 1) reasons.push('published_but_private');
    if (row.publicVisibility === 1 && (row.classification !== 'public' || row.reviewStatus !== 'approved')) reasons.push('publication_invariant_violation');
    return { ...row, reasons };
  });
  c.header('Cache-Control', 'private, no-store');
  return c.json({ data, limit: 250, truncated: data.length === 250 });
});

const STAGE_SQL = `CASE WHEN lifecycle = 'published' AND public_visibility = 1 THEN 'live' WHEN lifecycle IN ('sold','off_market','archived','on_hold','under_offer') THEN 'closed' WHEN content_review_status = 'approved' THEN 'ready' WHEN lifecycle = 'in_review' THEN 'review' ELSE 'draft' END`;
const OPPORTUNITY_STAGES = ['live', 'ready', 'review', 'draft', 'closed'];

admin.get('/opportunities', requireRole('admin', 'editor', 'broker', 'publisher', 'auditor', 'super_admin'), async (c) => {
  const q = c.req.query('q')?.trim().slice(0, 100) ?? '';
  const stageParam = c.req.query('stage') ?? '';
  const stage = OPPORTUNITY_STAGES.includes(stageParam) ? stageParam : '';
  const reviewParam = c.req.query('review') ?? '';
  const review = ['pending', 'approved', 'rejected'].includes(reviewParam) ? reviewParam : '';
  const pageSize = Math.min(100, Math.max(5, Number.parseInt(c.req.query('pageSize') ?? '25', 10) || 25));
  const page = Math.max(1, Number.parseInt(c.req.query('page') ?? '1', 10) || 1);
  const staff = c.get('staff');
  const brokerOnly = staff.role === 'broker' ? 1 : 0;
  const like = `%${q}%`;
  const where = `(? = '' OR title LIKE ? OR country LIKE ? OR slug LIKE ?) AND (? = '' OR content_review_status = ?) AND (? = 0 OR assigned_broker_id = ?)`;
  const base = [q, like, like, like, review, review, brokerOnly, staff.id];
  const [rows, counts] = await Promise.all([
    c.env.DB.prepare(
      `SELECT * FROM (SELECT id, slug, title, country, opportunity_type AS opportunityType, price_text AS priceText, lifecycle, classification, content_review_status AS reviewStatus, public_visibility AS publicVisibility, assigned_broker_id AS assignedBrokerId, updated_at AS updatedAt, ${STAGE_SQL} AS stage FROM opportunities WHERE ${where}) WHERE (? = '' OR stage = ?) ORDER BY updatedAt DESC, title ASC LIMIT ? OFFSET ?`,
    )
      .bind(...base, stage, stage, pageSize, (page - 1) * pageSize)
      .all(),
    c.env.DB.prepare(
      `SELECT stage, COUNT(*) AS n FROM (SELECT ${STAGE_SQL} AS stage FROM opportunities WHERE ${where}) GROUP BY stage`,
    )
      .bind(...base)
      .all<{ stage: string; n: number }>(),
  ]);
  const byStage: Record<string, number> = { live: 0, ready: 0, review: 0, draft: 0, closed: 0 };
  for (const row of counts.results ?? []) byStage[row.stage] = row.n;
  const all = Object.values(byStage).reduce((sum, n) => sum + n, 0);
  c.header('Cache-Control', 'private, no-store');
  return c.json({
    data: rows.results ?? [],
    page,
    pageSize,
    total: stage ? (byStage[stage] ?? 0) : all,
    counts: { all, ...byStage },
  });
});

admin.post('/opportunities', requireRole(...editorRoles), async (c) => {
  const parsed = opportunityInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Check the opportunity fields.',
          fields: parsed.error.flatten().fieldErrors,
        },
      },
      422,
    );
  const input = parsed.data;
  if (input.priceVisibility && !publisherRoles.includes(c.get('staff').role)) return c.json({ error: { code: 'FORBIDDEN', message: 'Only authorized publishers may mark a price as public.' } }, 403);
  const opportunityId = id();
  const timestamp = now();
  const assignedBrokerId =
    input.assignedBrokerId ?? (c.get('staff').role === 'broker' ? c.get('staff').id : null);
  if (c.get('staff').role === 'broker' && assignedBrokerId !== c.get('staff').id)
    return c.json(
      {
        error: { code: 'FORBIDDEN', message: 'Brokers can only assign new records to themselves.' },
      },
      403,
    );
  if (assignedBrokerId && !['admin', 'super_admin', 'broker'].includes(c.get('staff').role))
    return c.json(
      {
        error: {
          code: 'FORBIDDEN',
          message: 'Only administrators can assign an opportunity to a broker.',
        },
      },
      403,
    );
  if (assignedBrokerId) {
    const broker = await c.env.DB.prepare(
      "SELECT id FROM users WHERE id = ? AND user_type = 'staff' AND role = 'broker' AND status = 'active'",
    )
      .bind(assignedBrokerId)
      .first();
    if (!broker)
      return c.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Assigned broker must be an active broker account.',
          },
        },
        422,
      );
  }
  let slug = slugify(input.title);
  const collision = await c.env.DB.prepare('SELECT 1 AS found FROM opportunities WHERE slug = ?')
    .bind(slug)
    .first();
  if (collision) slug = `${slug}-${opportunityId.slice(0, 8)}`;
  const record = {
    id: opportunityId,
    slug,
    title: input.title,
    country: input.country,
    opportunityType: input.opportunityType,
    classification: input.classification,
    labels: input.labels,
    priceText: input.priceText,
    priceVisibility: input.priceVisibility,
    lifecycle: 'draft',
    contentReviewStatus: 'pending',
    summary: input.summary,
    bodyHtml: input.bodyHtml,
    availability: input.availability,
    publicVisibility: 0,
    seoTitle: input.seoTitle,
    seoDescription: input.seoDescription,
    assignedBrokerId,
  };
  await c.env.DB.prepare(
    "INSERT INTO opportunities (id, slug, title, country, opportunity_type, classification, labels_json, price_text, price_visibility, lifecycle, content_review_status, summary, body_html, availability, public_visibility, seo_title, seo_description, assigned_broker_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 'pending', ?, ?, ?, 0, ?, ?, ?, ?, ?)",
  )
    .bind(
      opportunityId,
      slug,
      input.title,
      input.country,
      input.opportunityType,
      input.classification,
      JSON.stringify(input.labels),
      input.priceText,
      input.priceVisibility ? 1 : 0,
      input.summary,
      input.bodyHtml,
      input.availability,
      input.seoTitle,
      input.seoDescription,
      assignedBrokerId,
      timestamp,
      timestamp,
    )
    .run();
  await c.env.DB.prepare(
    'INSERT INTO opportunity_versions (id, opportunity_id, version_number, snapshot_json, changed_by, change_reason, created_at) VALUES (?, ?, 1, ?, ?, ?, ?)',
  )
    .bind(
      id(),
      opportunityId,
      JSON.stringify(record),
      c.get('staff').id,
      'Initial creation',
      timestamp,
    )
    .run();
  await audit(c, 'opportunity.created', 'opportunity', opportunityId, { slug });
  return c.json(
    { data: { id: opportunityId, slug, lifecycle: 'draft', contentReviewStatus: 'pending' } },
    201,
  );
});

admin.get('/opportunities/export.csv', requireRole('admin', 'super_admin'), async (c) => {
  const result = await c.env.DB.prepare(
    `SELECT id, legacy_id, slug, title, country, opportunity_type, classification, labels_json,
      price_text, price_visibility, lifecycle, content_review_status, legacy_status, summary,
      body_html, availability, points_json, public_visibility, last_verified_at, published_at,
      seo_title, seo_description, assigned_broker_id, created_at, updated_at
     FROM opportunities ORDER BY updated_at DESC`,
  ).all<Record<string, unknown>>();
  const columns = [
    'id','legacy_id','slug','title','country','opportunity_type','classification','labels_json',
    'price_text','price_visibility','lifecycle','content_review_status','legacy_status','summary',
    'body_html','availability','points_json','public_visibility','last_verified_at','published_at',
    'seo_title','seo_description','assigned_broker_id','created_at','updated_at',
  ];
  const rows = [columns, ...(result.results ?? []).map((row) => columns.map((key) => row[key]))];
  const csv = rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
  await audit(c, 'opportunity.exported', 'opportunity', 'all', { count: result.results?.length ?? 0, format: 'csv' });
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="casinos-of-mayfair-opportunities-${new Date().toISOString().slice(0,10)}.csv"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});

admin.post('/opportunities/bulk-review', requireRole(...publisherRoles), async (c) => {
  const schema = z.object({
    ids: z.array(z.string().trim().min(1).max(100)).min(1).max(50),
    decision: z.enum(['approved', 'rejected']),
    reason: z.string().trim().min(3).max(500),
  });
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Select 1–50 records and provide a review reason.' } }, 422);
  const ids = [...new Set(parsed.data.ids)];
  const timestamp = now();
  const outcomes: Array<{ id: string; status: string }> = [];
  for (const opportunityId of ids) {
    const existing = await c.env.DB.prepare('SELECT id, slug, country FROM opportunities WHERE id = ?')
      .bind(opportunityId).first<{ id: string; slug: string; country: string | null }>();
    if (!existing) { outcomes.push({ id: opportunityId, status: 'not_found' }); continue; }
    await c.env.DB.prepare(
      "UPDATE opportunities SET content_review_status = ?, last_verified_at = CASE WHEN ? = 'approved' THEN ? ELSE last_verified_at END, public_visibility = 0, updated_at = ? WHERE id = ?",
    ).bind(parsed.data.decision, parsed.data.decision, timestamp, timestamp, opportunityId).run();
    const cachePurge = await purgeOpportunityPublicCache(c.env, existing.slug, existing.country);
    await audit(c, `opportunity.review.${parsed.data.decision}`, 'opportunity', opportunityId, {
      reason: parsed.data.reason, bulk: true, cachePurge,
    });
    outcomes.push({ id: opportunityId, status: parsed.data.decision });
  }
  return c.json({ data: { outcomes, processed: outcomes.filter((item) => item.status !== 'not_found').length } });
});

admin.post('/opportunities/import.csv', requireRole('admin', 'super_admin'), async (c) => {
  const raw = await c.req.text();
  if (raw.length > 1_000_000) return c.json({ error: { code: 'IMPORT_TOO_LARGE', message: 'CSV import is limited to 1 MB.' } }, 413);
  const rows = parseCsvRows(raw);
  if (!rows || rows.length < 2) return c.json({ error: { code: 'INVALID_CSV', message: 'Provide a valid CSV with a header and at least one data row.' } }, 422);
  if (rows.length > 101) return c.json({ error: { code: 'IMPORT_TOO_MANY_ROWS', message: 'Import is limited to 100 opportunity rows per batch.' } }, 422);
  const headers = (rows[0] ?? []).map((header) => header.trim().replace(/^\uFEFF/, ''));
  if (new Set(headers).size !== headers.length || !headers.includes('id') || !headers.includes('title'))
    return c.json({ error: { code: 'INVALID_CSV_HEADER', message: 'CSV headers must be unique and include id and title.' } }, 422);
  const allowed = new Set(['id','legacy_id','slug','title','country','opportunity_type','classification','labels_json','price_text','price_visibility','lifecycle','content_review_status','legacy_status','summary','body_html','availability','points_json','public_visibility','last_verified_at','published_at','seo_title','seo_description','assigned_broker_id','created_at','updated_at']);
  const unknownHeaders = headers.filter((header) => !allowed.has(header));
  if (unknownHeaders.length) return c.json({ error: { code: 'INVALID_CSV_HEADER', message: `Unsupported columns: ${unknownHeaders.join(', ')}` } }, 422);
  const staff = c.get('staff');
  const staged: Array<{ existing: Record<string, unknown>; values: Record<string, unknown>; id: string; snapshot: Record<string, unknown>; version: number; updatedAt: string }> = [];
  const seen = new Set<string>();
  const allowedTypes = ['casino-hotel','casino','hotel','resort','gaming-venue','other'];
  const allowedClasses = ['confidential','public','off_market','sold','under_offer','on_hold'];
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const cells = rows[rowIndex];
    if (!cells) continue;
    if (cells.length !== headers.length) return c.json({ error: { code: 'INVALID_CSV_ROW', message: `Row ${rowIndex + 1} has ${cells.length} cells; expected ${headers.length}.` } }, 422);
    const row = Object.fromEntries(headers.map((header, index) => [header, cells[index]])) as Record<string, string>;
    const opportunityId = (row.id ?? '').trim();
    if (!opportunityId || seen.has(opportunityId)) return c.json({ error: { code: 'INVALID_CSV_ID', message: `Row ${rowIndex + 1} has a blank or duplicate ID.` } }, 422);
    seen.add(opportunityId);
    const existing = await c.env.DB.prepare('SELECT * FROM opportunities WHERE id = ?').bind(opportunityId).first<Record<string, unknown>>();
    if (!existing) return c.json({ error: { code: 'UNKNOWN_CSV_ID', message: `Row ${rowIndex + 1} references an unknown opportunity ID. Imports update existing records only.` } }, 422);
    const title = (row.title ?? '').trim();
    if (title.length < 3 || title.length > 180) return c.json({ error: { code: 'INVALID_CSV_TITLE', message: `Row ${rowIndex + 1} title must be 3–180 characters.` } }, 422);
    const get = (key: string, fallback: unknown) => Object.prototype.hasOwnProperty.call(row, key) ? row[key] : fallback;
    const type = String(get('opportunity_type', existing.opportunity_type));
    const classification = String(get('classification', existing.classification));
    if (!allowedTypes.includes(type) || !allowedClasses.includes(classification)) return c.json({ error: { code: 'INVALID_CSV_ENUM', message: `Row ${rowIndex + 1} has an unsupported opportunity type or classification.` } }, 422);
    let labels: unknown = get('labels_json', existing.labels_json);
    if (typeof labels === 'string') {
      try { labels = JSON.parse(labels); } catch { return c.json({ error: { code: 'INVALID_CSV_LABELS', message: `Row ${rowIndex + 1} labels_json must be a JSON array.` } }, 422); }
    }
    if (!Array.isArray(labels) || labels.length > 12 || labels.some((label) => typeof label !== 'string' || !label.trim() || label.length > 32))
      return c.json({ error: { code: 'INVALID_CSV_LABELS', message: `Row ${rowIndex + 1} labels_json must contain up to 12 non-empty strings of at most 32 characters.` } }, 422);
    const priceVisibilityText = String(get('price_visibility', existing.price_visibility));
    if (!['0','1'].includes(priceVisibilityText)) return c.json({ error: { code: 'INVALID_CSV_PRICE_VISIBILITY', message: `Row ${rowIndex + 1} price_visibility must be 0 or 1.` } }, 422);
    const fields: Record<string, unknown> = {
      title,
      country: String(get('country', existing.country ?? '')).slice(0,100),
      opportunity_type: type,
      classification,
      labels_json: JSON.stringify(labels),
      price_text: String(get('price_text', existing.price_text ?? '')).slice(0,180),
      price_visibility: Number(priceVisibilityText),
      summary: String(get('summary', existing.summary ?? '')).slice(0,1000),
      body_html: String(get('body_html', existing.body_html ?? '')).slice(0,20000),
      availability: String(get('availability', existing.availability ?? '')).slice(0,300),
      seo_title: String(get('seo_title', existing.seo_title ?? '')).slice(0,180),
      seo_description: String(get('seo_description', existing.seo_description ?? '')).slice(0,320),
    };
    const nextVersion = await c.env.DB.prepare('SELECT COALESCE(MAX(version_number), 0) + 1 AS next FROM opportunity_versions WHERE opportunity_id = ?').bind(opportunityId).first<{ next: number }>();
    const updatedAt = now();
    const snapshot = { ...existing, ...fields, slug: fields.title === existing.title ? existing.slug : slugify(String(fields.title)), lifecycle: 'draft', content_review_status: 'pending', public_visibility: 0, updated_at: updatedAt };
    // Never let imported title changes create duplicate slugs.
    const slugCollision = await c.env.DB.prepare('SELECT id FROM opportunities WHERE slug = ? AND id != ?').bind(snapshot.slug, opportunityId).first();
    if (slugCollision) snapshot.slug = `${slugify(String(fields.title))}-${opportunityId.slice(0,8)}`;
    staged.push({ existing, values: fields, id: opportunityId, snapshot, version: nextVersion?.next ?? 1, updatedAt });
  }
  // Prevalidate the whole CSV before any writes, then use one D1 batch for atomic updates/version/audit records.
  const statements = staged.flatMap((item) => {
    const fields = item.values;
    const columns = Object.keys(fields);
    const update = c.env.DB.prepare(`UPDATE opportunities SET ${columns.map((column) => `${column} = ?`).join(', ')}, slug = ?, lifecycle = 'draft', content_review_status = 'pending', public_visibility = 0, updated_at = ? WHERE id = ?`)
      .bind(...columns.map((column) => fields[column]), item.snapshot.slug, item.updatedAt, item.id);
    const version = c.env.DB.prepare('INSERT INTO opportunity_versions (id, opportunity_id, version_number, snapshot_json, changed_by, change_reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(id(), item.id, item.version, JSON.stringify(item.snapshot), staff.id, 'CSV import; returned to private draft for review', item.updatedAt);
    const auditLog = c.env.DB.prepare('INSERT INTO audit_logs (id, actor_user_id, actor_type, action, entity_type, entity_id, request_id, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id(), staff.id, 'staff', 'opportunity.imported', 'opportunity', item.id, c.get('requestId'), JSON.stringify({ source: 'csv', reviewReset: true }), item.updatedAt);
    return [update, version, auditLog];
  });
  await c.env.DB.batch(statements);
  const purges = await Promise.all(staged.map((item) => purgeOpportunityPublicCache(c.env, String(item.existing.slug), typeof item.existing.country === 'string' ? item.existing.country : null)));
  return c.json({ data: { imported: staged.length, resetToPrivateDraft: true, cachePurgesConfigured: purges.filter((item) => item.configured).length } });
});

admin.get('/opportunities/:id/versions', requireRole('admin', 'editor', 'broker', 'publisher', 'super_admin'), async (c) => {
  const staff = c.get('staff');
  const brokerOnly = staff.role === 'broker' ? 1 : 0;
  const owned = await c.env.DB.prepare('SELECT id FROM opportunities WHERE id = ? AND (? = 0 OR assigned_broker_id = ?)')
    .bind(c.req.param('id'), brokerOnly, staff.id).first();
  if (!owned) return c.json({ error: { code: 'NOT_FOUND', message: 'Opportunity not found.' } }, 404);
  const result = await c.env.DB.prepare(
    'SELECT id, version_number AS versionNumber, changed_by AS changedBy, change_reason AS changeReason, created_at AS createdAt FROM opportunity_versions WHERE opportunity_id = ? ORDER BY version_number DESC LIMIT 100',
  ).bind(c.req.param('id')).all();
  return c.json({ data: result.results ?? [] });
});

admin.post('/opportunities/:id/versions/:versionNumber/restore', requireRole(...editorRoles), async (c) => {
  const versionNumber = Number(c.req.param('versionNumber'));
  const restoreInput = z.object({ reason: z.string().trim().min(3).max(500) }).safeParse(await c.req.json().catch(() => null));
  if (!restoreInput.success) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Provide a restore reason of at least 3 characters.' } }, 422);
  if (!Number.isSafeInteger(versionNumber) || versionNumber < 1)
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid version number.' } }, 422);
  const staff = c.get('staff');
  const brokerOnly = staff.role === 'broker' ? 1 : 0;
  const existing = await c.env.DB.prepare('SELECT * FROM opportunities WHERE id = ? AND (? = 0 OR assigned_broker_id = ?)')
    .bind(c.req.param('id'), brokerOnly, staff.id).first<Record<string, unknown>>();
  if (!existing) return c.json({ error: { code: 'NOT_FOUND', message: 'Opportunity not found.' } }, 404);
  const version = await c.env.DB.prepare(
    'SELECT snapshot_json FROM opportunity_versions WHERE opportunity_id = ? AND version_number = ?',
  ).bind(existing.id, versionNumber).first<{ snapshot_json: string }>();
  if (!version) return c.json({ error: { code: 'NOT_FOUND', message: 'Version not found.' } }, 404);
  let snapshot: Record<string, unknown>;
  try { snapshot = JSON.parse(version.snapshot_json) as Record<string, unknown>; }
  catch { return c.json({ error: { code: 'VERSION_CORRUPT', message: 'This version cannot be restored because its snapshot is invalid.' } }, 409); }
  const editable = ['title','country','opportunity_type','classification','labels_json','price_text','price_visibility','summary','body_html','availability','seo_title','seo_description'];
  if (typeof snapshot.title !== 'string' || typeof snapshot.slug !== 'string')
    return c.json({ error: { code: 'VERSION_CORRUPT', message: 'This version is missing required opportunity fields.' } }, 409);
  const values = editable.map((key) => snapshot[key] ?? (key === 'price_visibility' ? 0 : key === 'labels_json' ? '[]' : ''));
  const timestamp = now();
  const assignments = editable.map((key) => `${key} = ?`).join(', ');
  // Restores content only; review and publication are deliberately reset to private/pending.
  let restoredSlug = snapshot.slug;
  const slugCollision = await c.env.DB.prepare('SELECT id FROM opportunities WHERE slug = ? AND id != ?').bind(restoredSlug, existing.id).first<{ id: string }>();
  if (slugCollision) restoredSlug = `${slugify(String(snapshot.title))}-${String(existing.id).slice(0, 8)}`;
  await c.env.DB.prepare(
    `UPDATE opportunities SET ${assignments}, slug = ?, lifecycle = 'draft', content_review_status = 'pending', public_visibility = 0, updated_at = ? WHERE id = ?`,
  ).bind(...values, restoredSlug, timestamp, existing.id).run();
  const restored = await c.env.DB.prepare('SELECT * FROM opportunities WHERE id = ?').bind(existing.id).first<Record<string, unknown>>();
  const next = await c.env.DB.prepare('SELECT COALESCE(MAX(version_number), 0) + 1 AS next FROM opportunity_versions WHERE opportunity_id = ?')
    .bind(existing.id).first<{ next: number }>();
  await c.env.DB.prepare(
    'INSERT INTO opportunity_versions (id, opportunity_id, version_number, snapshot_json, changed_by, change_reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).bind(id(), existing.id, next?.next ?? 1, JSON.stringify(restored), staff.id, `Restored version ${versionNumber}: ${restoreInput.data.reason}; returned to draft for review`, timestamp).run();
  const cachePurge = await purgeOpportunityPublicCache(c.env, String(existing.slug), typeof existing.country === 'string' ? existing.country : null);
  await audit(c, 'opportunity.version_restored', 'opportunity', String(existing.id), { restoredVersion: versionNumber, cachePurge });
  return c.json({ data: { opportunity: restored, restoredVersion: versionNumber, reviewStatus: 'pending', publicVisibility: false } });
});

admin.get('/opportunities/reconciliation', requireRole('admin', 'auditor', 'super_admin'), async (c) => {
  c.header('Cache-Control', 'private, no-store');
  const counts = (await c.env.DB.prepare(buildReconciliationSql()).first<Record<string, number>>()) ?? {};
  const groups: Record<string, Array<Record<string, unknown>>> = {};
  for (const grouping of RECONCILIATION_GROUPINGS) {
    const result = await c.env.DB.prepare(
      `SELECT ${grouping.column} AS value, COUNT(*) AS count FROM opportunities GROUP BY ${grouping.column} ORDER BY count DESC`,
    ).all<Record<string, unknown>>();
    groups[grouping.key] = result.results ?? [];
  }
  const duplicateLegacy = await c.env.DB.prepare(DUPLICATE_LEGACY_ID_SQL).first<{ n: number }>();
  const duplicateSlug = await c.env.DB.prepare(DUPLICATE_SLUG_SQL).first<{ n: number }>();
  const checks = RECONCILIATION_CHECKS.map((check) => ({
    key: check.key,
    label: check.label,
    severity: check.severity,
    count: Number(counts[check.key] ?? 0),
  }));
  const blockers = checks.filter((check) => check.severity === 'blocker' && check.count > 0);
  return c.json({
    data: {
      generatedAt: now(),
      total: Number(counts.total ?? 0),
      duplicateLegacyIds: Number(duplicateLegacy?.n ?? 0),
      duplicateSlugs: Number(duplicateSlug?.n ?? 0),
      checks,
      groups,
      publishable: blockers.length === 0 && Number(duplicateLegacy?.n ?? 0) === 0 && Number(duplicateSlug?.n ?? 0) === 0,
      blockers: blockers.map((check) => check.key),
    },
  });
});

admin.get('/opportunities/lifecycle-transitions', requireRole(...editorRoles, 'publisher', 'auditor'), (c) => {
  c.header('Cache-Control', 'private, no-store');
  return c.json({ data: { role: c.get('staff').role, transitions: transitionMatrix(c.get('staff').role) } });
});

admin.get('/opportunities/:id', requireRole('admin', 'editor', 'broker', 'publisher', 'auditor', 'super_admin'), async (c) => {
  const staff = c.get('staff');
  const brokerOnly = staff.role === 'broker' ? 1 : 0;
  const row = await c.env.DB.prepare(
    'SELECT * FROM opportunities WHERE id = ? AND (? = 0 OR assigned_broker_id = ?)',
  )
    .bind(c.req.param('id'), brokerOnly, staff.id)
    .first<Record<string, unknown>>();
  if (!row) return c.json({ error: { code: 'NOT_FOUND', message: 'Opportunity not found.' } }, 404);
  return c.json({ data: row });
});

admin.patch('/opportunities/:id', requireRole(...editorRoles), async (c) => {
  const parsed = opportunityInput.partial().safeParse(await c.req.json().catch(() => null));
  if (!parsed.success || Object.keys(parsed.data ?? {}).length === 0)
    return c.json(
      {
        error: { code: 'VALIDATION_ERROR', message: 'Provide at least one valid editable field.' },
      },
      422,
    );
  const staff = c.get('staff');
  const brokerOnly = staff.role === 'broker' ? 1 : 0;
  const existing = await c.env.DB.prepare(
    'SELECT * FROM opportunities WHERE id = ? AND (? = 0 OR assigned_broker_id = ?)',
  )
    .bind(c.req.param('id'), brokerOnly, staff.id)
    .first<Record<string, unknown>>();
  if (!existing)
    return c.json({ error: { code: 'NOT_FOUND', message: 'Opportunity not found.' } }, 404);
  const input = parsed.data;
  if (input.priceVisibility && !publisherRoles.includes(staff.role)) return c.json({ error: { code: 'FORBIDDEN', message: 'Only authorized publishers may mark a price as public.' } }, 403);
  const updatedAt = now();
  if (Object.prototype.hasOwnProperty.call(input, 'assignedBrokerId')) {
    const requested = input.assignedBrokerId ?? null;
    const current =
      typeof existing.assigned_broker_id === 'string' ? existing.assigned_broker_id : null;
    if (!['admin', 'super_admin'].includes(staff.role) && requested !== current)
      return c.json(
        { error: { code: 'FORBIDDEN', message: 'Only administrators can reassign a broker.' } },
        403,
      );
    if (requested) {
      const broker = await c.env.DB.prepare(
        "SELECT id FROM users WHERE id = ? AND user_type = 'staff' AND role = 'broker' AND status = 'active'",
      )
        .bind(requested)
        .first();
      if (!broker)
        return c.json(
          {
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Assigned broker must be an active broker account.',
            },
          },
          422,
        );
    }
  }
  const mapping: Record<string, string> = {
    title: 'title',
    country: 'country',
    opportunityType: 'opportunity_type',
    classification: 'classification',
    labels: 'labels_json',
    priceText: 'price_text',
    priceVisibility: 'price_visibility',
    summary: 'summary',
    bodyHtml: 'body_html',
    availability: 'availability',
    seoTitle: 'seo_title',
    seoDescription: 'seo_description',
    assignedBrokerId: 'assigned_broker_id',
  };
  const sets = Object.entries(input).map(([key]) => `${mapping[key]} = ?`);
  const values = Object.entries(input).map(([key, value]) =>
    key === 'labels' ? JSON.stringify(value) : key === 'priceVisibility' ? (value ? 1 : 0) : value,
  );
  if (input.title && input.title !== existing.title) {
    let slug = slugify(input.title);
    const found = await c.env.DB.prepare(
      'SELECT 1 AS found FROM opportunities WHERE slug = ? AND id != ?',
    )
      .bind(slug, existing.id)
      .first();
    if (found) slug = `${slug}-${String(existing.id).slice(0, 8)}`;
    sets.push('slug = ?');
    values.push(slug);
  }
  sets.push("content_review_status = 'pending'", 'public_visibility = 0', 'updated_at = ?');
  values.push(updatedAt, String(existing.id));
  await c.env.DB.prepare(`UPDATE opportunities SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run();
  const cachePurge = await purgeOpportunityPublicCache(
    c.env,
    String(existing.slug),
    typeof existing.country === 'string' ? existing.country : null,
  );
  const updated = await c.env.DB.prepare('SELECT * FROM opportunities WHERE id = ?')
    .bind(existing.id)
    .first<Record<string, unknown>>();
  const version = await c.env.DB.prepare(
    'SELECT COALESCE(MAX(version_number), 0) + 1 AS next FROM opportunity_versions WHERE opportunity_id = ?',
  )
    .bind(existing.id)
    .first<{ next: number }>();
  await c.env.DB.prepare(
    'INSERT INTO opportunity_versions (id, opportunity_id, version_number, snapshot_json, changed_by, change_reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(
      id(),
      existing.id,
      version?.next ?? 1,
      JSON.stringify(updated),
      c.get('staff').id,
      'Opportunity edited; sent back for content review',
      updatedAt,
    )
    .run();
  await audit(c, 'opportunity.updated', 'opportunity', String(existing.id), {
    fields: Object.keys(input),
    reviewReset: true,
    cachePurge,
  });
  return c.json({ data: updated });
});

admin.post('/opportunities/:id/verify', requireRole(...publisherRoles), async (c) => {
  const parsed = z.object({ reason: z.string().trim().min(3).max(500) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Provide a verification note of at least 3 characters.' } }, 422);
  const existing = await c.env.DB.prepare('SELECT id, title, assigned_broker_id AS assignedBrokerId FROM opportunities WHERE id = ?').bind(c.req.param('id')).first<{ id: string; title: string; assignedBrokerId: string | null }>();
  if (!existing) return c.json({ error: { code: 'NOT_FOUND', message: 'Opportunity not found.' } }, 404);
  const timestamp = now();
  await c.env.DB.prepare('UPDATE opportunities SET last_verified_at = ?, updated_at = ? WHERE id = ?').bind(timestamp, timestamp, existing.id).run();
  await audit(c, 'opportunity.verified', 'opportunity', existing.id, { reason: parsed.data.reason, verifiedAt: timestamp });
  c.header('Cache-Control', 'private, no-store');
  return c.json({ data: { id: existing.id, lastVerifiedAt: timestamp } });
});

admin.post('/opportunities/:id/publication', requireRole(...publisherRoles), async (c) => {
  const parsed = publicationInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Provide a valid lifecycle, visibility and change reason.',
        },
      },
      422,
    );
  const existing = await c.env.DB.prepare('SELECT * FROM opportunities WHERE id = ?')
    .bind(c.req.param('id'))
    .first<Record<string, unknown>>();
  if (!existing)
    return c.json({ error: { code: 'NOT_FOUND', message: 'Opportunity not found.' } }, 404);
  const { lifecycle, publicVisibility, changeReason } = parsed.data;
  const transition = checkLifecycleTransition(existing.lifecycle, lifecycle, c.get('staff').role);
  if (!transition.ok)
    return c.json(
      { error: { code: transition.code, message: transition.message, allowed: transition.allowed } },
      409,
    );
  if (
    publicVisibility &&
    (lifecycle !== 'published' ||
      existing.content_review_status !== 'approved' ||
      existing.classification !== 'public' ||
      !existing.last_verified_at)
  )
    return c.json(
      {
        error: {
          code: 'PUBLICATION_BLOCKED',
          message:
            'Public visibility requires public classification, approved content, published lifecycle and a verification timestamp.',
        },
      },
      409,
    );
  const timestamp = now();
  await c.env.DB.prepare(
    'UPDATE opportunities SET lifecycle = ?, public_visibility = ?, published_at = CASE WHEN ? = 1 THEN COALESCE(published_at, ?) ELSE published_at END, updated_at = ? WHERE id = ?',
  )
    .bind(
      lifecycle,
      publicVisibility ? 1 : 0,
      publicVisibility ? 1 : 0,
      timestamp,
      timestamp,
      existing.id,
    )
    .run();
  const cachePurge = await purgeOpportunityPublicCache(
    c.env,
    String(existing.slug),
    typeof existing.country === 'string' ? existing.country : null,
  );
  await audit(c, 'opportunity.publication_changed', 'opportunity', String(existing.id), {
    fromLifecycle: existing.lifecycle,
    lifecycle,
    publicVisibility,
    changeReason,
    cachePurge,
  });
  return c.json({ data: { id: existing.id, lifecycle, publicVisibility, cachePurge } });
});

admin.post(
  '/opportunities/:id/workflow',
  requireRole(...editorRoles, ...publisherRoles),
  async (c) => {
    const parsed = z
      .object({
        action: z.enum(['submit', 'approve', 'unapprove', 'publish', 'unpublish', 'archive', 'restore']),
        makePublic: z.boolean().optional(),
        reason: z.string().trim().max(500).optional(),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Choose a valid action.' } }, 422);
    const { action, makePublic } = parsed.data;
    const staff = c.get('staff');
    if (action !== 'submit' && !publisherRoles.includes(staff.role))
      return c.json({ error: { code: 'FORBIDDEN', message: 'Your role cannot perform this action.' } }, 403);
    const row = await c.env.DB.prepare(
      'SELECT id, slug, country, lifecycle, classification, content_review_status AS review, public_visibility AS vis, assigned_broker_id AS broker FROM opportunities WHERE id = ?',
    )
      .bind(c.req.param('id'))
      .first<{
        id: string;
        slug: string;
        country: string | null;
        lifecycle: string;
        classification: string;
        review: string;
        vis: number;
        broker: string | null;
      }>();
    if (!row || (staff.role === 'broker' && row.broker !== staff.id))
      return c.json({ error: { code: 'NOT_FOUND', message: 'Opportunity not found.' } }, 404);
    const conflict = (code: string, message: string) => c.json({ error: { code, message } }, 409);
    /** Every lifecycle change goes through the Sprint 32 state machine. */
    const hop = (from: string, to: string) => checkLifecycleTransition(from, to, staff.role);
    const timestamp = now();
    const live = row.lifecycle === 'published' && row.vis === 1;
    const closed = ['sold', 'off_market', 'archived', 'on_hold', 'under_offer'].includes(row.lifecycle);
    let statement: D1PreparedStatement;
    switch (action) {
      case 'submit': {
        if (live || row.review === 'approved')
          return conflict('ALREADY_REVIEWED', 'This listing is already approved.');
        const step = hop(row.lifecycle, 'in_review');
        if (!step.ok) return conflict(step.code, step.message);
        statement = c.env.DB.prepare(
          "UPDATE opportunities SET lifecycle = 'in_review', public_visibility = 0, updated_at = ? WHERE id = ?",
        ).bind(timestamp, row.id);
        break;
      }
      case 'approve':
        if (live) return conflict('ALREADY_LIVE', 'This listing is already live.');
        if (closed) return conflict('LISTING_CLOSED', 'Restore this listing before approving it.');
        statement = c.env.DB.prepare(
          "UPDATE opportunities SET content_review_status = 'approved', last_verified_at = ?, public_visibility = 0, updated_at = ? WHERE id = ?",
        ).bind(timestamp, timestamp, row.id);
        break;
      case 'unapprove': {
        let lifecycle = row.lifecycle;
        if (lifecycle === 'published') {
          const step = hop('published', 'in_review');
          if (!step.ok) return conflict(step.code, step.message);
          lifecycle = 'in_review';
        }
        statement = c.env.DB.prepare(
          "UPDATE opportunities SET content_review_status = 'pending', public_visibility = 0, lifecycle = ?, updated_at = ? WHERE id = ?",
        ).bind(lifecycle, timestamp, row.id);
        break;
      }
      case 'publish': {
        if (['sold', 'off_market', 'archived'].includes(row.lifecycle))
          return conflict('LISTING_CLOSED', 'Restore this listing before publishing it.');
        if (row.review !== 'approved')
          return conflict('NEEDS_APPROVAL', 'Approve this listing before publishing it.');
        if (row.classification !== 'public' && !makePublic)
          return conflict(
            'NOT_PUBLIC',
            `This listing is classified ${row.classification.replace('_', ' ')}. Publishing makes it visible to everyone.`,
          );
        // A draft must pass through "in review" first; both hops are checked.
        const route =
          row.lifecycle === 'draft' ? ['in_review', 'published'] : row.lifecycle === 'published' ? [] : ['published'];
        let from = row.lifecycle;
        for (const to of route) {
          const step = hop(from, to);
          if (!step.ok) return conflict(step.code, step.message);
          from = to;
        }
        statement = c.env.DB.prepare(
          "UPDATE opportunities SET lifecycle = 'published', public_visibility = 1, classification = 'public', last_verified_at = COALESCE(last_verified_at, ?), published_at = COALESCE(published_at, ?), updated_at = ? WHERE id = ?",
        ).bind(timestamp, timestamp, timestamp, row.id);
        break;
      }
      case 'unpublish': {
        if (row.lifecycle === 'published') {
          const step = hop('published', 'in_review');
          if (!step.ok) return conflict(step.code, step.message);
        }
        statement = c.env.DB.prepare(
          "UPDATE opportunities SET lifecycle = CASE WHEN lifecycle = 'published' THEN 'in_review' ELSE lifecycle END, public_visibility = 0, updated_at = ? WHERE id = ?",
        ).bind(timestamp, row.id);
        break;
      }
      case 'archive': {
        const step = hop(row.lifecycle, 'archived');
        if (!step.ok) return conflict(step.code, step.message);
        statement = c.env.DB.prepare(
          "UPDATE opportunities SET lifecycle = 'archived', public_visibility = 0, updated_at = ? WHERE id = ?",
        ).bind(timestamp, row.id);
        break;
      }
      default: {
        const target = hop(row.lifecycle, 'draft').ok ? 'draft' : 'in_review';
        const step = hop(row.lifecycle, target);
        if (!step.ok || row.lifecycle === target)
          return conflict('NOT_CLOSED', 'This listing does not need restoring.');
        statement = c.env.DB.prepare(
          'UPDATE opportunities SET lifecycle = ?, public_visibility = 0, updated_at = ? WHERE id = ?',
        ).bind(target, timestamp, row.id);
      }
    }
    await statement.run();
    const cachePurge = await purgeOpportunityPublicCache(c.env, row.slug, row.country);
    await audit(c, `opportunity.workflow.${action}`, 'opportunity', row.id, {
      reason: parsed.data.reason ?? null,
      fromLifecycle: row.lifecycle,
      fromReview: row.review,
      wasLive: live,
      cachePurge,
    });
    c.header('Cache-Control', 'private, no-store');
    const after = await c.env.DB.prepare(
      `SELECT lifecycle, classification, content_review_status AS reviewStatus, public_visibility AS publicVisibility, ${STAGE_SQL} AS stage FROM opportunities WHERE id = ?`,
    )
      .bind(row.id)
      .first();
    return c.json({ data: { id: row.id, ...after } });
  },
);

admin.delete('/opportunities/:id', requireRole('admin', 'super_admin'), async (c) => {
  const row = await c.env.DB.prepare('SELECT id, slug, title, country FROM opportunities WHERE id = ?')
    .bind(c.req.param('id'))
    .first<{ id: string; slug: string; title: string; country: string | null }>();
  if (!row) return c.json({ error: { code: 'NOT_FOUND', message: 'Opportunity not found.' } }, 404);
  const used = await c.env.DB.prepare(
    'SELECT (SELECT COUNT(*) FROM nda_requests WHERE opportunity_id = ?1) AS ndas, (SELECT COUNT(*) FROM access_grants WHERE opportunity_id = ?1) AS grants, (SELECT COUNT(*) FROM documents WHERE opportunity_id = ?1) AS docs, (SELECT COUNT(*) FROM managed_form_submissions WHERE opportunity_id = ?1) AS forms',
  )
    .bind(row.id)
    .first<{ ndas: number; grants: number; docs: number; forms: number }>();
  if (used && (used.ndas || used.grants || used.docs || used.forms))
    return c.json(
      {
        error: {
          code: 'HAS_RECORDS',
          message:
            'This listing has NDA requests, data-room documents or form submissions linked to it, so it cannot be deleted. Archive it instead.',
        },
      },
      409,
    );
  try {
    // Image files are left in storage: the media library is reference-aware and may share them.
    await c.env.DB.prepare('DELETE FROM opportunities WHERE id = ?').bind(row.id).run();
  } catch {
    return c.json(
      {
        error: {
          code: 'HAS_RECORDS',
          message: 'Other records still depend on this listing, so it cannot be deleted. Archive it instead.',
        },
      },
      409,
    );
  }
  const cachePurge = await purgeOpportunityPublicCache(c.env, row.slug, row.country);
  await audit(c, 'opportunity.deleted', 'opportunity', row.id, { title: row.title, slug: row.slug, cachePurge });
  return c.json({ data: { id: row.id, deleted: true } });
});

admin.post('/opportunities/:id/review', requireRole(...publisherRoles), async (c) => {
  const schema = z.object({
    decision: z.enum(['approved', 'rejected']),
    reason: z.string().trim().min(3).max(500),
    verifiedAt: z.string().datetime().optional(),
  });
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'Provide a review decision and reason.' } },
      422,
    );
  const existing = await c.env.DB.prepare(
    'SELECT id, slug, country FROM opportunities WHERE id = ?',
  )
    .bind(c.req.param('id'))
    .first<{ id: string; slug: string; country: string | null }>();
  if (!existing)
    return c.json({ error: { code: 'NOT_FOUND', message: 'Opportunity not found.' } }, 404);
  const timestamp = now();
  await c.env.DB.prepare(
    "UPDATE opportunities SET content_review_status = ?, last_verified_at = CASE WHEN ? = 'approved' THEN ? ELSE last_verified_at END, public_visibility = 0, updated_at = ? WHERE id = ?",
  )
    .bind(
      parsed.data.decision,
      parsed.data.decision,
      parsed.data.verifiedAt ?? timestamp,
      timestamp,
      c.req.param('id'),
    )
    .run();
  const cachePurge = await purgeOpportunityPublicCache(c.env, existing.slug, existing.country);
  await audit(c, `opportunity.review.${parsed.data.decision}`, 'opportunity', c.req.param('id'), {
    reason: parsed.data.reason,
    verifiedAt: parsed.data.verifiedAt ?? timestamp,
    cachePurge,
  });
  return c.json({
    data: {
      id: c.req.param('id'),
      reviewStatus: parsed.data.decision,
      publicVisibility: false,
      cachePurge,
    },
  });
});

const enquiryStatuses = ['new', 'assigned', 'in_progress', 'waiting', 'closed', 'spam'] as const;
admin.get(
  '/enquiries/ui',
  requireRole('admin', 'editor', 'broker', 'publisher', 'auditor', 'super_admin'),
  (c) =>
    c.html(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Enquiries · Casinos of Mayfair</title><link rel="stylesheet" href="/static/css/site.css"><link rel="stylesheet" href="/static/css/dashboard.css"></head><body><main class="admin"><p class="eyebrow">STAFF WORKSPACE</p><h1>Enquiries</h1><nav class="admin-nav"><a href="/dashboard">Overview</a><a href="/dashboard/enquiries/ui">Enquiries</a><a href="/dashboard/tasks/ui">Tasks</a><a href="/dashboard/forms/ui">Forms</a><a href="/dashboard/nda-requests/ui">NDA requests</a><a href="/admin/logout">Sign out</a></nav><p class="muted">Website contact enquiries and listing requests. Contact details are confidential; use them only to respond to the request.</p><div class="enq-bar"><label>Status <select id="enq-status"><option value="">All</option><option value="new">New</option><option value="assigned">Assigned</option><option value="in_progress">In progress</option><option value="waiting">Waiting</option><option value="closed">Closed</option><option value="spam">Spam</option></select></label><label>Search <input id="enq-q" type="search" maxlength="100" placeholder="Name, email or company" autocomplete="off"></label></div><p id="enq-notice" role="status"></p><div class="enq-layout"><section id="enq-list" aria-live="polite">Loading enquiries…</section><aside id="enq-detail" aria-live="polite"><p class="muted">Select an enquiry to see the full message, notes and actions.</p></aside></div></main><script src="/static/js/dashboard-enquiries.js" defer></script></body></html>`,
    ),
);
admin.get('/assignees', requireRole('admin', 'editor', 'super_admin'), async (c) => {
  const result = await c.env.DB.prepare(
    "SELECT id, display_name AS displayName, email, role FROM users WHERE user_type = 'staff' AND status = 'active' AND role IN ('admin','editor','broker','publisher','super_admin') ORDER BY display_name COLLATE NOCASE LIMIT 200",
  ).all();
  return c.json({ data: result.results ?? [] });
});
admin.get(
  '/enquiries',
  requireRole('admin', 'editor', 'broker', 'publisher', 'auditor', 'super_admin'),
  async (c) => {
    const status = c.req.query('status') ?? '';
    const q = (c.req.query('q') ?? '').trim().slice(0, 100);
    const safeStatus = (enquiryStatuses as readonly string[]).includes(status) ? status : '';
    const staff = c.get('staff');
    const brokerOnly = staff.role === 'broker' ? 1 : 0;
    const result = await c.env.DB.prepare(
      "SELECT e.id, e.name, e.email, e.company, e.message, e.status, e.assigned_to AS assignedTo, e.opportunity_id AS opportunityId, e.created_at AS createdAt, e.updated_at AS updatedAt, o.title AS opportunityTitle FROM enquiries e LEFT JOIN opportunities o ON o.id = e.opportunity_id WHERE (? = '' OR e.status = ?) AND (? = '' OR e.name LIKE ? OR e.email LIKE ? OR e.company LIKE ?) AND (? = 0 OR e.assigned_to = ?) ORDER BY e.created_at DESC LIMIT 100",
    )
      .bind(safeStatus, safeStatus, q, `%${q}%`, `%${q}%`, `%${q}%`, brokerOnly, staff.id)
      .all();
    return c.json({ data: result.results ?? [], limit: 100 });
  },
);
admin.get(
  '/enquiries/:id',
  requireRole('admin', 'editor', 'broker', 'publisher', 'auditor', 'super_admin'),
  async (c) => {
    const staff = c.get('staff');
    const brokerOnly = staff.role === 'broker' ? 1 : 0;
    const row = await c.env.DB.prepare(
      'SELECT * FROM enquiries WHERE id = ? AND (? = 0 OR assigned_to = ?)',
    )
      .bind(c.req.param('id'), brokerOnly, staff.id)
      .first<Record<string, unknown>>();
    if (!row) return c.json({ error: { code: 'NOT_FOUND', message: 'Enquiry not found.' } }, 404);
    const notes = await c.env.DB.prepare(
      'SELECT n.id, n.note, n.created_at AS createdAt, u.email AS authorEmail FROM enquiry_notes n JOIN users u ON u.id = n.author_id WHERE n.enquiry_id = ? ORDER BY n.created_at DESC LIMIT 100',
    )
      .bind(c.req.param('id'))
      .all();
    return c.json({ data: row, notes: notes.results ?? [] });
  },
);
admin.patch(
  '/enquiries/:id',
  requireRole('admin', 'editor', 'broker', 'super_admin'),
  async (c) => {
    const schema = z
      .object({
        status: z.enum(enquiryStatuses).optional(),
        assignedTo: z.string().uuid().nullable().optional(),
      })
      .refine((v) => Object.keys(v).length > 0);
    const parsed = schema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'Provide a valid status or assignee.' } },
        422,
      );
    const staff = c.get('staff');
    const brokerOnly = staff.role === 'broker' ? 1 : 0;
    const existing = await c.env.DB.prepare(
      'SELECT id, status, assigned_to AS assignedTo FROM enquiries WHERE id = ? AND (? = 0 OR assigned_to = ?)',
    )
      .bind(c.req.param('id'), brokerOnly, staff.id)
      .first<{ id: string; status: string; assignedTo: string | null }>();
    if (!existing)
      return c.json({ error: { code: 'NOT_FOUND', message: 'Enquiry not found.' } }, 404);
    if (staff.role === 'broker' && Object.prototype.hasOwnProperty.call(parsed.data, 'assignedTo'))
      return c.json(
        { error: { code: 'FORBIDDEN', message: 'Brokers cannot reassign enquiries.' } },
        403,
      );
    if (parsed.data.assignedTo) {
      const staffUser = await c.env.DB.prepare(
        "SELECT id FROM users WHERE id = ? AND user_type = 'staff' AND status = 'active'",
      )
        .bind(parsed.data.assignedTo)
        .first();
      if (!staffUser)
        return c.json(
          {
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Assignee must be an active staff member.',
            },
          },
          422,
        );
    }
    const sets: string[] = ['updated_at = ?'];
    const values: (string | null)[] = [now()];
    if (parsed.data.status) {
      sets.push('status = ?');
      values.push(parsed.data.status);
    }
    if (Object.prototype.hasOwnProperty.call(parsed.data, 'assignedTo')) {
      sets.push('assigned_to = ?');
      values.push(parsed.data.assignedTo ?? null);
    }
    values.push(existing.id);
    await c.env.DB.prepare(`UPDATE enquiries SET ${sets.join(', ')} WHERE id = ?`)
      .bind(...values)
      .run();
    await audit(c, 'enquiry.updated', 'enquiry', existing.id, {
      status: parsed.data.status,
      assignedTo: parsed.data.assignedTo,
    });
    return c.json({
      data: {
        id: existing.id,
        status: parsed.data.status ?? existing.status,
        assignedTo: Object.prototype.hasOwnProperty.call(parsed.data, 'assignedTo')
          ? (parsed.data.assignedTo ?? null)
          : existing.assignedTo,
      },
    });
  },
);
admin.post(
  '/enquiries/:id/notes',
  requireRole('admin', 'editor', 'broker', 'super_admin'),
  async (c) => {
    const parsed = z
      .object({ note: z.string().trim().min(2).max(3000) })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'Provide a note of 2 to 3000 characters.' } },
        422,
      );
    const staff = c.get('staff');
    const brokerOnly = staff.role === 'broker' ? 1 : 0;
    const found = await c.env.DB.prepare(
      'SELECT id FROM enquiries WHERE id = ? AND (? = 0 OR assigned_to = ?)',
    )
      .bind(c.req.param('id'), brokerOnly, staff.id)
      .first();
    if (!found) return c.json({ error: { code: 'NOT_FOUND', message: 'Enquiry not found.' } }, 404);
    const noteId = id();
    const timestamp = now();
    await c.env.DB.prepare(
      'INSERT INTO enquiry_notes (id, enquiry_id, author_id, note, created_at) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(noteId, c.req.param('id'), c.get('staff').id, parsed.data.note, timestamp)
      .run();
    await audit(c, 'enquiry.note_added', 'enquiry', c.req.param('id'), { noteId });
    return c.json({ data: { id: noteId, createdAt: timestamp } }, 201);
  },
);

admin.get('/buyers/ui', requireRole('admin', 'super_admin'), async (c) =>
  c.html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Buyer access · Casinos of Mayfair</title><link rel="stylesheet" href="/static/css/site.css"><link rel="stylesheet" href="/static/css/dashboard.css"></head><body><main class="admin"><p class="eyebrow">STAFF WORKSPACE</p><h1>Buyer access</h1><nav class="admin-nav"><a href="/dashboard">Overview</a><a href="/dashboard/opportunities/ui">Opportunity CMS</a><a href="/dashboard/nda-requests/ui">NDA requests</a><a href="/dashboard/access-grants/ui">Access grants</a><a href="/admin/logout">Sign out</a></nav><p class="muted">Approve new registrations, suspend access and reset passwords. Approving a buyer allows sign-in only; confidential data-room access still needs an approved NDA.</p><div class="dx-toolbar"><div class="dx-tabs" id="buyer-tabs" role="tablist"><button type="button" class="dx-tab" role="tab" data-tab="invited" aria-selected="false">Pending approval<span class="dx-count">0</span></button><button type="button" class="dx-tab" role="tab" data-tab="active" aria-selected="false">Active<span class="dx-count">0</span></button><button type="button" class="dx-tab" role="tab" data-tab="suspended" aria-selected="false">Suspended<span class="dx-count">0</span></button><button type="button" class="dx-tab" role="tab" data-tab="all" aria-selected="false">All<span class="dx-count">0</span></button></div><input class="dx-search" id="buyer-search" type="search" placeholder="Search" aria-label="Search"><span class="dx-spacer"></span><button type="button" class="dx-btn dx-btn-primary" id="buyer-add">Add buyer</button></div><div id="buyers" class="dx-table-wrap">Loading…</div></main><script src="/static/js/dashboard-kit.js" defer></script><script src="/static/js/dashboard-buyers.js" defer></script></body></html>`,
  ),
);

admin.get('/buyers', requireRole('admin', 'super_admin'), async (c) => {
  const result = await c.env.DB.prepare(
    "SELECT u.id, u.email, u.display_name AS displayName, u.status, u.created_at AS createdAt, p.company_name AS companyName, p.role_title AS roleTitle, u.must_change_password AS mustChange, CASE WHEN u.password_hash IS NULL THEN 0 ELSE 1 END AS hasPassword FROM users u LEFT JOIN buyer_profiles p ON p.user_id = u.id WHERE u.user_type = 'buyer' ORDER BY CASE u.status WHEN 'invited' THEN 0 WHEN 'active' THEN 1 ELSE 2 END, u.created_at DESC LIMIT 300",
  ).all();
  return c.json({ data: result.results ?? [] });
});

admin.patch('/buyers/:id', requireRole('admin', 'super_admin'), async (c) => {
  const parsed = z
    .object({ status: z.enum(['active', 'invited', 'suspended']) })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'Choose a valid buyer status.' } },
      422,
    );
  const user = await c.env.DB.prepare(
    "SELECT id, status FROM users WHERE id = ? AND user_type = 'buyer'",
  )
    .bind(c.req.param('id'))
    .first<{ id: string; status: string }>();
  if (!user) return c.json({ error: { code: 'NOT_FOUND', message: 'Buyer not found.' } }, 404);
  const timestamp = now();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE users SET status = ?, updated_at = ? WHERE id = ? AND user_type = 'buyer'",
    ).bind(parsed.data.status, timestamp, user.id),
    c.env.DB.prepare(
      "UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND ? != 'active'",
    ).bind(timestamp, user.id, parsed.data.status),
    c.env.DB.prepare(
      "INSERT INTO audit_logs (id, actor_user_id, actor_type, action, entity_type, entity_id, request_id, details_json, created_at) VALUES (?, ?, 'staff', 'buyer.status_changed', 'user', ?, ?, ?, ?)",
    ).bind(
      id(),
      c.get('staff').id,
      user.id,
      c.get('requestId'),
      JSON.stringify({ from: user.status, to: parsed.data.status }),
      timestamp,
    ),
  ]);
  return c.json({ data: { id: user.id, status: parsed.data.status } });
});

admin.post('/buyers/:id/temporary-password', requireRole('admin', 'super_admin'), async (c) => {
  const body = z
    .object({ password: z.string().max(200).optional() })
    .safeParse(await c.req.json().catch(() => ({})));
  if (!body.success)
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid password.' } }, 422);
  const user = await c.env.DB.prepare(
    "SELECT id, email, status FROM users WHERE id = ? AND user_type = 'buyer'",
  )
    .bind(c.req.param('id'))
    .first<{ id: string; email: string; status: string }>();
  if (!user) return c.json({ error: { code: 'NOT_FOUND', message: 'Buyer not found.' } }, 404);
  const result = await issueTemporaryPassword(c, user, 'buyer', body.data.password || undefined);
  if ('problem' in result)
    return c.json({ error: { code: 'WEAK_PASSWORD', message: result.problem } }, 422);
  c.header('Cache-Control', 'no-store');
  return c.json({
    data: { email: user.email, temporaryPassword: result.password, status: user.status },
  });
});

admin.post('/buyers/:id/reset-password', requireRole('admin', 'super_admin'), async (c) => {
  const user = await c.env.DB.prepare(
    "SELECT id, email FROM users WHERE id = ? AND user_type = 'buyer' AND status = 'active'",
  )
    .bind(c.req.param('id'))
    .first<{ id: string; email: string }>();
  if (!user)
    return c.json(
      { error: { code: 'NOT_FOUND', message: 'Active buyer account not found.' } },
      404,
    );
  const emailQueued = Boolean(await issueResetToken(c.env, user, 'reset', 'buyer'));
  await audit(c, 'buyer.password_reset_issued', 'user', user.id, { emailQueued });
  return c.json({ data: { emailQueued } });
});

admin.post('/buyers/provision', requireRole('admin', 'super_admin'), async (c) => {
  const parsed = z
    .object({
      email: z.string().trim().email().max(254),
      displayName: z.string().trim().min(2).max(120),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Provide a valid business email and full name.',
        },
      },
      422,
    );
  const email = parsed.data.email.toLowerCase();
  const existing = await c.env.DB.prepare(
    'SELECT id, user_type AS userType, status FROM users WHERE email = ? COLLATE NOCASE',
  )
    .bind(email)
    .first<{ id: string; userType: string; status: string }>();
  const timestamp = now();
  if (existing && existing.userType !== 'buyer')
    return c.json(
      { error: { code: 'ACCOUNT_CONFLICT', message: 'That email belongs to a staff account.' } },
      409,
    );
  if (existing && existing.status === 'active')
    return c.json(
      { error: { code: 'ALREADY_ACTIVE', message: 'An active buyer account already exists.' } },
      409,
    );
  if (existing && existing.status !== 'invited')
    return c.json(
      {
        error: {
          code: 'ACCOUNT_STATUS_BLOCKED',
          message: 'Suspended or deleted accounts require a separate administrative review.',
        },
      },
      409,
    );
  const buyerId = existing?.id ?? id();
  const auditDetails = JSON.stringify({ email, reactivated: Boolean(existing) });
  if (existing) {
    await c.env.DB.batch([
      c.env.DB.prepare(
        "UPDATE users SET display_name = ?, status = 'active', updated_at = ? WHERE id = ? AND user_type = 'buyer' AND status = 'invited'",
      ).bind(parsed.data.displayName, timestamp, buyerId),
      c.env.DB.prepare(
        "INSERT INTO audit_logs (id, actor_user_id, actor_type, action, entity_type, entity_id, request_id, details_json, created_at) SELECT ?, ?, 'staff', 'buyer.provisioned', 'user', ?, ?, ?, ? WHERE changes() > 0",
      ).bind(id(), c.get('staff').id, buyerId, c.get('requestId'), auditDetails, timestamp),
    ]);
    const activated = await c.env.DB.prepare(
      "SELECT id FROM users WHERE id = ? AND status = 'active' AND user_type = 'buyer'",
    )
      .bind(buyerId)
      .first();
    if (!activated)
      return c.json(
        {
          error: {
            code: 'ACCOUNT_STATUS_CONFLICT',
            message:
              'The buyer account changed during provisioning. Refresh and review its status.',
          },
        },
        409,
      );
  } else {
    await c.env.DB.batch([
      c.env.DB.prepare(
        "INSERT INTO users (id, email, display_name, user_type, role, status, created_at, updated_at) VALUES (?, ?, ?, 'buyer', 'buyer', 'active', ?, ?)",
      ).bind(buyerId, email, parsed.data.displayName, timestamp, timestamp),
      c.env.DB.prepare(
        "INSERT INTO audit_logs (id, actor_user_id, actor_type, action, entity_type, entity_id, request_id, details_json, created_at) VALUES (?, ?, 'staff', 'buyer.provisioned', 'user', ?, ?, ?, ?)",
      ).bind(id(), c.get('staff').id, buyerId, c.get('requestId'), auditDetails, timestamp),
    ]);
  }
  const inviteQueued = Boolean(
    await issueResetToken(c.env, { id: buyerId, email }, 'invite', 'buyer'),
  );
  return c.json(
    {
      data: {
        id: buyerId,
        email,
        displayName: parsed.data.displayName,
        status: 'active',
        signIn: 'password',
        inviteQueued,
      },
    },
    201,
  );
});

admin.get('/nda-templates/ui', requireRole('admin', 'super_admin'), async (c) =>
  c.html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NDA templates · Casinos of Mayfair</title><link rel="stylesheet" href="/static/css/site.css"><link rel="stylesheet" href="/static/css/dashboard.css"></head><body><main class="admin"><p class="eyebrow">STAFF WORKSPACE</p><h1>NDA template versions</h1><nav class="admin-nav"><a href="/dashboard">Overview</a><a href="/dashboard/nda-requests/ui">NDA requests</a><a href="/dashboard/access-grants/ui">Access grants</a><a href="/dashboard/nda-templates/ui">NDA templates</a><a href="/admin/logout">Sign out</a></nav><p class="muted">Template content is private in R2. Legal approval is required before activation. The seeded version is explicitly a draft and must not be treated as counsel-approved.</p><form id="nda-template-form" class="buyer-provision"><label>Template name <input name="name" value="Mayfair NDA Acknowledgement" minlength="3" maxlength="160" required></label><label>Template text <textarea name="content" minlength="100" maxlength="100000" required></textarea></label><label><input type="checkbox" name="activate"> Activate immediately (only if approved by counsel)</label><button type="submit">Create version</button></form><p id="nda-template-notice" role="status"></p><ul id="nda-template-list"></ul></main><script src="/static/js/dashboard-nda-templates.js" defer></script></body></html>`,
  ),
);

admin.get('/nda-templates', requireRole('admin', 'publisher', 'super_admin'), async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT id, name, version, r2_key AS r2Key, content_hash AS contentHash, status, created_at AS createdAt FROM nda_templates ORDER BY version DESC',
  ).all();
  return c.json({ data: rows.results ?? [] });
});

admin.post('/nda-templates', requireRole('admin', 'super_admin'), async (c) => {
  const parsed = z
    .object({
      name: z.string().trim().min(3).max(160),
      content: z.string().trim().min(100).max(100000),
      activate: z.boolean().default(false),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Provide a template name and content (100–100,000 characters).',
        },
      },
      422,
    );
  const latest = await c.env.DB.prepare(
    'SELECT COALESCE(MAX(version), 0) AS version FROM nda_templates WHERE name = ?',
  )
    .bind(parsed.data.name)
    .first<{ version: number }>();
  const version = (latest?.version ?? 0) + 1;
  const templateId = id();
  const timestamp = now();
  const bytes = new TextEncoder().encode(parsed.data.content);
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
  const r2Key = `nda/templates/${templateId}/v${version}.txt`;
  await c.env.PRIVATE_FILES.put(r2Key, bytes, {
    httpMetadata: { contentType: 'text/plain; charset=utf-8', cacheControl: 'private, no-store' },
    customMetadata: { contentHash: digest },
  });
  try {
    const statements = [];
    if (parsed.data.activate)
      statements.push(
        c.env.DB.prepare(
          "UPDATE nda_templates SET status = 'retired' WHERE status = 'active'",
        ).bind(),
      );
    statements.push(
      c.env.DB.prepare(
        'INSERT INTO nda_templates (id, name, version, r2_key, content_hash, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind(
        templateId,
        parsed.data.name,
        version,
        r2Key,
        digest,
        parsed.data.activate ? 'active' : 'draft',
        c.get('staff').id,
        timestamp,
      ),
    );
    statements.push(
      c.env.DB.prepare(
        "INSERT INTO audit_logs (id, actor_user_id, actor_type, action, entity_type, entity_id, request_id, details_json, created_at) VALUES (?, ?, 'staff', 'nda.template.created', 'nda_template', ?, ?, ?, ?)",
      ).bind(
        id(),
        c.get('staff').id,
        templateId,
        c.get('requestId'),
        JSON.stringify({
          name: parsed.data.name,
          version,
          contentHash: digest,
          activated: parsed.data.activate,
        }),
        timestamp,
      ),
    );
    await c.env.DB.batch(statements);
  } catch (error) {
    await c.env.PRIVATE_FILES.delete(r2Key);
    throw error;
  }
  return c.json(
    {
      data: {
        id: templateId,
        name: parsed.data.name,
        version,
        contentHash: digest,
        status: parsed.data.activate ? 'active' : 'draft',
      },
    },
    201,
  );
});

admin.post('/nda-templates/:id/activate', requireRole('admin', 'super_admin'), async (c) => {
  const template = await c.env.DB.prepare(
    'SELECT id, name, version, r2_key AS r2Key, content_hash AS contentHash, status FROM nda_templates WHERE id = ?',
  )
    .bind(c.req.param('id'))
    .first<{
      id: string;
      name: string;
      version: number;
      r2Key: string | null;
      contentHash: string;
      status: string;
    }>();
  if (!template)
    return c.json({ error: { code: 'NOT_FOUND', message: 'NDA template not found.' } }, 404);
  if (!template.r2Key)
    return c.json(
      {
        error: {
          code: 'SEED_TEMPLATE_NOT_MANAGED',
          message:
            'The bootstrap template is seeded from the repository. Create a managed version with approved content before activating a replacement.',
        },
      },
      409,
    );
  const object = await c.env.PRIVATE_FILES.get(template.r2Key);
  if (!object)
    return c.json(
      {
        error: {
          code: 'TEMPLATE_OBJECT_MISSING',
          message: 'Template content is missing from private storage.',
        },
      },
      409,
    );
  const content = await object.arrayBuffer();
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', content)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
  if (digest !== template.contentHash)
    return c.json(
      {
        error: {
          code: 'TEMPLATE_HASH_MISMATCH',
          message: 'Stored template content does not match its recorded hash.',
        },
      },
      409,
    );
  const timestamp = now();
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE nda_templates SET status = 'retired' WHERE status = 'active'").bind(),
    c.env.DB.prepare(
      "UPDATE nda_templates SET status = 'active' WHERE id = ? AND status IN ('draft','retired')",
    ).bind(template.id),
    c.env.DB.prepare(
      "INSERT INTO audit_logs (id, actor_user_id, actor_type, action, entity_type, entity_id, request_id, details_json, created_at) VALUES (?, ?, 'staff', 'nda.template.activated', 'nda_template', ?, ?, ?, ?)",
    ).bind(
      id(),
      c.get('staff').id,
      template.id,
      c.get('requestId'),
      JSON.stringify({ version: template.version, contentHash: digest }),
      timestamp,
    ),
  ]);
  return c.json({ data: { id: template.id, status: 'active', contentHash: digest } });
});

admin.get(
  '/nda-requests/ui',
  requireRole('admin', 'broker', 'publisher', 'super_admin'),
  async (c) => {
    return c.html(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NDA review · Casinos of Mayfair</title><link rel="stylesheet" href="/static/css/site.css"><link rel="stylesheet" href="/static/css/dashboard.css"></head><body><main class="admin"><p class="eyebrow">STAFF WORKSPACE</p><h1>NDA request review</h1><nav class="admin-nav"><a href="/dashboard">Overview</a><a href="/dashboard/tasks/ui">Tasks</a><a href="/dashboard/notifications/ui">Notifications</a><a href="/dashboard/audit/ui">Audit log</a><a href="/admin/logout">Sign out</a></nav><p class="muted">Review requests and record a reason. Approval grants time-limited data-room access; it is not a legal opinion or an electronic signature.</p><label>Filter <select id="status-filter"><option value="pending">Pending</option><option value="approved">Approved</option><option value="rejected">Rejected</option><option value="revoked">Revoked</option><option value="">All statuses</option></select></label><p id="notice" role="status"></p><section id="requests" aria-live="polite">Loading requests…</section></main><script src="/static/js/dashboard-nda.js" defer></script></body></html>`,
    );
  },
);

admin.get(
  '/nda-requests',
  requireRole('admin', 'broker', 'publisher', 'super_admin'),
  async (c) => {
    const status = c.req.query('status') ?? '';
    const valid = ['pending', 'approved', 'rejected', 'revoked'].includes(status) ? status : '';
    const staff = c.get('staff');
    const brokerOnly = staff.role === 'broker' ? 1 : 0;
    const result = await c.env.DB.prepare(
      "SELECT n.id, n.status, n.acceptance_name AS acceptanceName, n.accepted_at AS acceptedAt, n.review_reason AS reviewReason, CASE WHEN n.signed_pdf_r2_key IS NULL THEN 0 ELSE 1 END AS hasSignedPdf, n.created_at AS createdAt, u.email AS buyerEmail, u.display_name AS buyerName, o.title AS opportunityTitle FROM nda_requests n JOIN users u ON u.id = n.user_id JOIN opportunities o ON o.id = n.opportunity_id WHERE (? = '' OR n.status = ?) AND (? = 0 OR o.assigned_broker_id = ?) ORDER BY n.created_at DESC LIMIT 100",
    )
      .bind(valid, valid, brokerOnly, staff.id)
      .all();
    return c.json({ data: result.results ?? [] });
  },
);

admin.get('/nda-requests/:id/signed-pdf', requireRole('admin', 'publisher', 'super_admin'), async (c) => {
  const request = await c.env.DB.prepare('SELECT id, signed_pdf_r2_key AS r2Key, signed_pdf_sha256 AS sha256 FROM nda_requests WHERE id = ? LIMIT 1').bind(c.req.param('id')).first<{ id: string; r2Key: string | null; sha256: string | null }>();
  if (!request?.r2Key || !request.sha256) return c.json({ error: { code: 'NOT_FOUND', message: 'Signed NDA PDF not found.' } }, 404);
  const object = await c.env.PRIVATE_FILES.get(request.r2Key);
  if (!object || object.size > 10 * 1024 * 1024) return c.json({ error: { code: 'OBJECT_MISSING', message: 'Signed NDA PDF is unavailable.' } }, 404);
  const bytes = await object.arrayBuffer();
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (value) => value.toString(16).padStart(2, '0')).join('');
  if (hash !== request.sha256) return c.json({ error: { code: 'INTEGRITY_FAILURE', message: 'Signed NDA PDF integrity check failed.' } }, 409);
  await audit(c, 'nda.signed_pdf_downloaded', 'nda_request', request.id, { sha256: hash });
  return new Response(bytes, { headers: { 'Content-Type': 'application/pdf', 'Content-Length': String(bytes.byteLength), 'Content-Disposition': `attachment; filename="signed-nda-${request.id}.pdf"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
});

admin.patch(
  '/nda-requests/:id/review',
  requireRole('admin', 'publisher', 'super_admin'),
  async (c) => {
    const parsed = z
      .object({
        decision: z.enum(['approved', 'rejected']),
        reason: z.string().trim().min(3).max(1000),
        accessDays: z.number().int().min(1).max(90).default(30),
        tier: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(2),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'Provide a decision and review reason.' } },
        422,
      );
    if (parsed.data.tier === 3 && c.get('staff').role !== 'super_admin') {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Tier 3 access requires a super administrator.' } }, 403);
    }
    if (parsed.data.tier === 3 && parsed.data.reason.length < 20) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Tier 3 approval requires a detailed justification of at least 20 characters.' } }, 422);
    }
    const request = await c.env.DB.prepare(
      'SELECT id, user_id AS userId, opportunity_id AS opportunityId, status FROM nda_requests WHERE id = ?',
    )
      .bind(c.req.param('id'))
      .first<{ id: string; userId: string; opportunityId: string; status: string }>();
    if (!request)
      return c.json({ error: { code: 'NOT_FOUND', message: 'NDA request not found.' } }, 404);
    if (request.status !== 'pending')
      return c.json(
        { error: { code: 'CONFLICT', message: 'Only pending NDA requests can be reviewed.' } },
        409,
      );
    const timestamp = now();
    const grantId = id();
    const expiry = new Date(Date.now() + parsed.data.accessDays * 86400000).toISOString();
    const statements = [
      c.env.DB.prepare(
        'UPDATE nda_requests SET status = ?, review_reason = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ?',
      ).bind(
        parsed.data.decision,
        parsed.data.reason,
        c.get('staff').id,
        timestamp,
        timestamp,
        request.id,
      ),
    ];
    if (parsed.data.decision === 'approved')
      statements.push(
        c.env.DB.prepare(
          'INSERT INTO access_grants (id, user_id, opportunity_id, nda_request_id, tier, granted_by, granted_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        ).bind(
          grantId,
          request.userId,
          request.opportunityId,
          request.id,
          parsed.data.tier,
          c.get('staff').id,
          timestamp,
          expiry,
        ),
      );
    statements.push(
      c.env.DB.prepare(
        "INSERT INTO audit_logs (id, actor_user_id, actor_type, action, entity_type, entity_id, request_id, details_json, created_at) VALUES (?, ?, 'staff', ?, 'nda_request', ?, ?, ?, ?)",
      ).bind(
        id(),
        c.get('staff').id,
        `nda.${parsed.data.decision}`,
        request.id,
        c.get('requestId'),
        JSON.stringify({
          reason: parsed.data.reason,
          tier: parsed.data.tier,
          expiresAt: parsed.data.decision === 'approved' ? expiry : null,
        }),
        timestamp,
      ),
    );
    const decisionJobId = id();
    statements.push(
      c.env.DB.prepare(
        "INSERT INTO notification_jobs (id, job_type, payload_json, status, attempts, available_at, created_at, updated_at) VALUES (?, 'nda.decision', ?, 'queued', 0, ?, ?, ?)",
      ).bind(
        decisionJobId,
        JSON.stringify({ ndaRequestId: request.id }),
        timestamp,
        timestamp,
        timestamp,
      ),
    );
    await c.env.DB.batch(statements);
    try {
      await c.env.NOTIFICATIONS_QUEUE.send({ type: 'nda.decision', jobId: decisionJobId });
    } catch {
      /* The durable job row is picked up by scheduled recovery. */
    }
    return c.json({
      data: {
        id: request.id,
        status: parsed.data.decision,
        accessExpiresAt: parsed.data.decision === 'approved' ? expiry : null,
      },
    });
  },
);

admin.post(
  '/opportunities/:id/documents',
  requireRole('admin', 'editor', 'publisher', 'super_admin'),
  async (c) => {
    const opportunity = await c.env.DB.prepare('SELECT id FROM opportunities WHERE id = ?')
      .bind(c.req.param('id'))
      .first();
    if (!opportunity)
      return c.json({ error: { code: 'NOT_FOUND', message: 'Opportunity not found.' } }, 404);
    const body = await c.req.parseBody();
    const upload = body.file;
    const filename =
      typeof body.filename === 'string'
        ? body.filename.trim()
        : upload instanceof File
          ? upload.name
          : '';
    const tier = Number(body.tier ?? 2);
    if (
      !(upload instanceof File) ||
      upload.size < 1 ||
      upload.size > 20 * 1024 * 1024 ||
      !filename ||
      filename.length > 180 ||
      ![1, 2, 3].includes(tier)
    )
      return c.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Upload a file up to 20 MB with a valid filename and tier.',
          },
        },
        422,
      );
    if (tier === 3 && c.get('staff').role !== 'super_admin') return c.json({ error: { code: 'FORBIDDEN', message: 'Only a super administrator may upload tier-3 documents.' } }, 403);
    const allowed = new Map([
      ['application/pdf', '.pdf'],
      ['image/jpeg', '.jpg'],
      ['image/png', '.png'],
      ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
      ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx'],
    ]);
    const contentType = upload.type || 'application/octet-stream';
    if (!allowed.has(contentType))
      return c.json(
        {
          error: {
            code: 'UNSUPPORTED_MEDIA_TYPE',
            message: 'Only PDF, JPEG, PNG, DOCX and XLSX files are accepted.',
          },
        },
        415,
      );
    const bytes = new Uint8Array(await upload.arrayBuffer());
    if (!hasExpectedFileSignature(contentType, bytes))
      return c.json(
        {
          error: {
            code: 'INVALID_FILE_SIGNATURE',
            message: 'The file contents do not match the declared file type.',
          },
        },
        415,
      );
    // eslint-disable-next-line no-control-regex
    const safeFilename = filename.replace(/[\\/\r\n\u0000-\u001f]/g, '_').slice(0, 180);
    const digestBuffer = await crypto.subtle.digest('SHA-256', bytes);
    const sha256 = Array.from(new Uint8Array(digestBuffer), (value) =>
      value.toString(16).padStart(2, '0'),
    ).join('');
    const key = `opportunities/${c.req.param('id')}/documents/${crypto.randomUUID()}${allowed.get(contentType)}`;
    await c.env.PRIVATE_FILES.put(key, bytes.buffer as ArrayBuffer, {
      httpMetadata: { contentType, cacheControl: 'private, no-store' },
      customMetadata: { originalName: safeFilename, uploadedBy: c.get('staff').id },
    });
    const documentId = id();
    const timestamp = now();
    const scanSkipped = (await getScannerMode(c.env)) === 'disabled';
    try {
      await c.env.DB.batch([
        c.env.DB.prepare(
          'INSERT INTO documents (id, opportunity_id, r2_key, filename, content_type, byte_size, tier, uploaded_by, created_at, sha256, scan_status, scan_provider, scan_job_id, scan_verdict, scan_digest, scanned_at, scan_engine_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ).bind(
          documentId,
          c.req.param('id'),
          key,
          safeFilename,
          contentType,
          upload.size,
          tier,
          c.get('staff').id,
          timestamp,
          sha256,
          scanSkipped ? 'clean' : 'pending',
          scanSkipped ? SCAN_SKIPPED_PROVIDER : null,
          scanSkipped ? `skipped-${documentId}` : null,
          scanSkipped ? 'clean' : null,
          scanSkipped ? sha256 : null,
          scanSkipped ? timestamp : null,
          scanSkipped ? 'scanner-disabled' : null,
        ),
        c.env.DB.prepare(
          "INSERT INTO audit_logs (id, actor_user_id, actor_type, action, entity_type, entity_id, request_id, details_json, created_at) VALUES (?, ?, 'staff', 'document.uploaded', 'document', ?, ?, ?, ?)",
        ).bind(
          id(),
          c.get('staff').id,
          documentId,
          c.get('requestId'),
          JSON.stringify({
            opportunityId: c.req.param('id'),
            byteSize: upload.size,
            tier,
            contentType,
            scanSkipped,
          }),
          timestamp,
        ),
      ]);
    } catch (error) {
      await c.env.PRIVATE_FILES.delete(key);
      throw error;
    }
    return c.json(
      {
        data: {
          id: documentId,
          filename: safeFilename,
          contentType,
          byteSize: upload.size,
          tier,
          createdAt: timestamp,
          scanStatus: scanSkipped ? 'clean' : 'pending',
          scanSkipped,
        },
      },
      201,
    );
  },
);

admin.post(
  '/opportunities/:id/media',
  requireRole('admin', 'editor', 'broker', 'publisher', 'super_admin'),
  async (c) => {
    const opportunityId = c.req.param('id');
    const opportunity = await c.env.DB.prepare(
      'SELECT id, slug, country, public_visibility AS publicVisibility, assigned_broker_id AS assignedBrokerId FROM opportunities WHERE id = ?',
    )
      .bind(opportunityId)
      .first<{
        id: string;
        slug: string;
        country: string | null;
        publicVisibility: number;
        assignedBrokerId: string | null;
      }>();
    if (
      !opportunity ||
      (c.get('staff').role === 'broker' && opportunity.assignedBrokerId !== c.get('staff').id)
    )
      return c.json({ error: { code: 'NOT_FOUND', message: 'Opportunity not found.' } }, 404);

    const body = await c.req.parseBody();
    const upload = body.file;
    const altText = typeof body.altText === 'string' ? body.altText.trim() : '';
    if (
      !(upload instanceof File) ||
      upload.size < 1 ||
      upload.size > 8 * 1024 * 1024 ||
      altText.length < 3 ||
      altText.length > 240
    )
      return c.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Choose a JPG, PNG, WebP or GIF up to 8 MiB and provide descriptive alternative text.',
          },
        },
        422,
      );

    const contentType = upload.type;
    const bytes = new Uint8Array(await upload.arrayBuffer());
    // JPEG, PNG, WebP and GIF (PHP-edition parity); signatures are checked against the declared type.
    const listingImageExt: Record<string, string> = {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
      'image/gif': 'gif',
    };
    const imageExt = listingImageExt[contentType];
    if (!imageExt || !mediaSignatureMatches(contentType, bytes))
      return c.json(
        {
          error: {
            code: 'INVALID_FILE_SIGNATURE',
            message: 'Image bytes do not match JPEG, PNG, WebP or GIF.',
          },
        },
        415,
      );

    const hash = await crypto.subtle.digest('SHA-256', bytes);
    const sha256 = [...new Uint8Array(hash)]
      .map((value) => value.toString(16).padStart(2, '0'))
      .join('');
    const mediaId = id();
    const key = `opportunities/${opportunityId}/media/${mediaId}.${imageExt}`;
    const timestamp = now();
    await c.env.PRIVATE_FILES.put(key, bytes.buffer as ArrayBuffer, {
      httpMetadata: { contentType, cacheControl: 'private, no-store' },
      customMetadata: { sha256, mediaId },
    });
    const order = await c.env.DB.prepare(
      'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM opportunity_media WHERE opportunity_id = ?',
    )
      .bind(opportunityId)
      .first<{ next: number }>();
    try {
      await c.env.DB.batch([
        c.env.DB.prepare(
          "UPDATE opportunities SET content_review_status = 'pending', public_visibility = 0, updated_at = ? WHERE id = ? AND public_visibility = 1",
        ).bind(timestamp, opportunityId),
        c.env.DB.prepare(
          "INSERT INTO audit_logs (id, actor_user_id, actor_type, action, entity_type, entity_id, request_id, details_json, created_at) SELECT ?, ?, 'staff', 'opportunity.media_change_requires_review', 'opportunity', ?, ?, '{}', ? WHERE changes() > 0",
        ).bind(id(), c.get('staff').id, opportunityId, c.get('requestId'), timestamp),
        c.env.DB.prepare(
          'INSERT INTO opportunity_media (id, opportunity_id, r2_key, alt_text, sort_order, created_at, content_type, byte_size, sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ).bind(
          mediaId,
          opportunityId,
          key,
          altText,
          order?.next ?? 0,
          timestamp,
          contentType,
          upload.size,
          sha256,
        ),
        c.env.DB.prepare(
          "INSERT INTO audit_logs (id, actor_user_id, actor_type, action, entity_type, entity_id, request_id, details_json, created_at) VALUES (?, ?, 'staff', 'opportunity.media_uploaded', 'opportunity_media', ?, ?, ?, ?)",
        ).bind(
          id(),
          c.get('staff').id,
          mediaId,
          c.get('requestId'),
          JSON.stringify({ opportunityId, byteSize: upload.size, contentType, sha256 }),
          timestamp,
        ),
      ]);
    } catch (error) {
      await c.env.PRIVATE_FILES.delete(key);
      throw error;
    }
    const cachePurge = await purgeOpportunityPublicCache(
      c.env,
      opportunity.slug,
      opportunity.country,
    );
    return c.json(
      {
        data: {
          id: mediaId,
          opportunityId,
          altText,
          sortOrder: order?.next ?? 0,
          contentType,
          byteSize: upload.size,
          sha256,
          cachePurge,
        },
      },
      201,
    );
  },
);

admin.post(
  '/opportunities/:id/media/from-library',
  requireRole('admin', 'editor', 'broker', 'publisher', 'super_admin'),
  async (c) => {
    const opportunityId = c.req.param('id');
    const opportunity = await c.env.DB.prepare(
      'SELECT id, slug, country, assigned_broker_id AS assignedBrokerId FROM opportunities WHERE id = ?',
    )
      .bind(opportunityId)
      .first<{ id: string; slug: string; country: string | null; assignedBrokerId: string | null }>();
    if (
      !opportunity ||
      (c.get('staff').role === 'broker' && opportunity.assignedBrokerId !== c.get('staff').id)
    )
      return c.json({ error: { code: 'NOT_FOUND', message: 'Opportunity not found.' } }, 404);
    const body = z
      .object({
        mediaUrl: z.string().trim().max(300).optional(),
        assetId: z.string().trim().min(1).max(80).optional(),
        altText: z.string().trim().max(240).optional(),
      })
      .safeParse(await c.req.json().catch(() => null));
    // The shared Media picker returns a public URL such as /media/<slug-or-id>.
    const urlMatch = body.success ? body.data.mediaUrl?.match(/^\/media\/([^/?#]+)$/) : null;
    let lookup = body.success ? body.data.assetId : undefined;
    if (!lookup && urlMatch?.[1]) {
      try {
        lookup = decodeURIComponent(urlMatch[1]);
      } catch {
        lookup = undefined;
      }
    }
    if (!body.success || !lookup)
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Choose an image from the Media library.' } }, 422);
    const asset = await c.env.DB.prepare(
      "SELECT id, r2_key AS r2Key, content_type AS contentType, byte_size AS byteSize, alt_text AS altText, visibility FROM media_assets WHERE (id = ?1 OR public_slug = ?1) AND visibility = 'public'",
    )
      .bind(lookup)
      .first<{
        id: string;
        r2Key: string;
        contentType: string;
        byteSize: number;
        altText: string | null;
        visibility: string;
      }>();
    if (!asset)
      return c.json(
        { error: { code: 'NOT_FOUND', message: 'That image is not available. Make sure it is public in the Media library.' } },
        404,
      );
    if (asset.visibility !== 'public')
      return c.json(
        { error: { code: 'NOT_PUBLIC', message: 'Publish this image in the Media library before using it on a listing.' } },
        409,
      );
    const altText = (body.data.altText || asset.altText || '').trim();
    if (altText.length < 3 || altText.length > 240)
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'Describe the image in 3 to 240 characters.' } },
        422,
      );
    const attachExt: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
    const attachImageExt = attachExt[asset.contentType];
    if (!attachImageExt || asset.byteSize > 8 * 1024 * 1024)
      return c.json(
        { error: { code: 'UNSUPPORTED_IMAGE', message: 'Only JPG, PNG, WebP or GIF images up to 8 MiB can be added to a listing.' } },
        415,
      );
    const object = await c.env.PRIVATE_FILES.get(asset.r2Key);
    if (!object)
      return c.json({ error: { code: 'NOT_FOUND', message: 'The image file is missing from storage.' } }, 404);
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (!mediaSignatureMatches(asset.contentType, bytes))
      return c.json({ error: { code: 'INVALID_FILE_SIGNATURE', message: 'Image bytes do not match JPEG, PNG, WebP or GIF.' } }, 415);
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    const sha256 = [...new Uint8Array(hash)].map((value) => value.toString(16).padStart(2, '0')).join('');
    const mediaId = id();
    const key = `opportunities/${opportunityId}/media/${mediaId}.${attachImageExt}`;
    const timestamp = now();
    await c.env.PRIVATE_FILES.put(key, bytes.buffer as ArrayBuffer, {
      httpMetadata: { contentType: asset.contentType, cacheControl: 'private, no-store' },
      customMetadata: { sha256, mediaId, libraryAssetId: asset.id },
    });
    const order = await c.env.DB.prepare(
      'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM opportunity_media WHERE opportunity_id = ?',
    )
      .bind(opportunityId)
      .first<{ next: number }>();
    try {
      await c.env.DB.batch([
        // Same rule as an upload: changing the pictures of a live listing sends it back for approval.
        c.env.DB.prepare(
          "UPDATE opportunities SET content_review_status = 'pending', public_visibility = 0, updated_at = ? WHERE id = ? AND public_visibility = 1",
        ).bind(timestamp, opportunityId),
        c.env.DB.prepare(
          'INSERT INTO opportunity_media (id, opportunity_id, r2_key, alt_text, sort_order, created_at, content_type, byte_size, sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ).bind(mediaId, opportunityId, key, altText, order?.next ?? 0, timestamp, asset.contentType, bytes.length, sha256),
      ]);
    } catch (error) {
      await c.env.PRIVATE_FILES.delete(key);
      throw error;
    }
    await c.env.DB.prepare("UPDATE media_assets SET alt_text = ?, updated_at = ? WHERE id = ? AND (alt_text IS NULL OR alt_text = '')")
      .bind(altText, timestamp, asset.id)
      .run();
    await audit(c, 'opportunity.media_added_from_library', 'opportunity_media', mediaId, {
      opportunityId,
      libraryAssetId: asset.id,
      byteSize: bytes.length,
      sha256,
    });
    const cachePurge = await purgeOpportunityPublicCache(c.env, opportunity.slug, opportunity.country);
    return c.json({ data: { id: mediaId, opportunityId, altText, sortOrder: order?.next ?? 0, cachePurge } }, 201);
  },
);

admin.get(
  '/opportunities/:id/media',
  requireRole('admin', 'editor', 'broker', 'publisher', 'super_admin'),
  async (c) => {
    const result = await c.env.DB.prepare(
      'SELECT m.id, m.alt_text AS altText, m.sort_order AS sortOrder, m.content_type AS contentType, m.byte_size AS byteSize, m.sha256 FROM opportunity_media m JOIN opportunities o ON o.id = m.opportunity_id WHERE m.opportunity_id = ? AND (? = 0 OR o.assigned_broker_id = ?) ORDER BY m.sort_order, m.created_at',
    )
      .bind(c.req.param('id'), c.get('staff').role === 'broker' ? 1 : 0, c.get('staff').id)
      .all();
    return c.json({ data: result.results ?? [] });
  },
);

admin.delete(
  '/opportunities/:id/media/:mediaId',
  requireRole('admin', 'editor', 'broker', 'publisher', 'super_admin'),
  async (c) => {
    const media = await c.env.DB.prepare(
      'SELECT m.id, m.r2_key AS r2Key, o.slug, o.country, o.assigned_broker_id AS assignedBrokerId FROM opportunity_media m JOIN opportunities o ON o.id = m.opportunity_id WHERE m.id = ? AND m.opportunity_id = ?',
    )
      .bind(c.req.param('mediaId'), c.req.param('id'))
      .first<{
        id: string;
        r2Key: string;
        slug: string;
        country: string | null;
        assignedBrokerId: string | null;
      }>();
    if (
      !media ||
      (c.get('staff').role === 'broker' && media.assignedBrokerId !== c.get('staff').id)
    )
      return c.json({ error: { code: 'NOT_FOUND', message: 'Listing image not found.' } }, 404);
    const timestamp = now();
    await c.env.DB.batch([
      c.env.DB.prepare(
        "UPDATE opportunities SET content_review_status = 'pending', public_visibility = 0, updated_at = ? WHERE id = ? AND public_visibility = 1",
      ).bind(timestamp, c.req.param('id')),
      c.env.DB.prepare(
        "INSERT INTO audit_logs (id, actor_user_id, actor_type, action, entity_type, entity_id, request_id, details_json, created_at) SELECT ?, ?, 'staff', 'opportunity.media_change_requires_review', 'opportunity', ?, ?, '{}', ? WHERE changes() > 0",
      ).bind(id(), c.get('staff').id, c.req.param('id'), c.get('requestId'), timestamp),
      c.env.DB.prepare('DELETE FROM opportunity_media WHERE id = ?').bind(media.id),
      c.env.DB.prepare(
        "INSERT INTO audit_logs (id, actor_user_id, actor_type, action, entity_type, entity_id, request_id, details_json, created_at) VALUES (?, ?, 'staff', 'opportunity.media_deleted', 'opportunity_media', ?, ?, '{}', ?)",
      ).bind(id(), c.get('staff').id, media.id, c.get('requestId'), timestamp),
    ]);
    await c.env.PRIVATE_FILES.delete(media.r2Key);
    const cachePurge = await purgeOpportunityPublicCache(c.env, media.slug, media.country);
    return c.json({ data: { deleted: true, cachePurge } });
  },
);

admin.get('/documents/ui', requireRole('admin', 'editor', 'publisher', 'super_admin'), (c) => c.html(
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Data room documents · Casinos of Mayfair</title><link rel="stylesheet" href="/static/css/site.css"><link rel="stylesheet" href="/static/css/dashboard.css"></head><body><main class="admin"><p class="eyebrow">CONFIDENTIAL STAFF WORKSPACE</p><h1>Data room documents</h1><nav class="admin-nav"><a href="/dashboard">Overview</a><a href="/dashboard/opportunities/ui">Opportunity CMS</a><a href="/dashboard/nda-requests/ui">NDA requests</a><a href="/dashboard/access-grants/ui">Access grants</a><a href="/dashboard/documents/ui" aria-current="page">Data room documents</a><a href="/dashboard/audit/ui">Audit log</a></nav><p class="muted">Documents are stored in private R2. They are never publicly served. Files remain unavailable to buyers until a trusted scanner verifies the exact stored bytes as clean.</p><section id="scanner-panel" class="flow-card"><h2>Malware scanner</h2><p id="scanner-state" role="status" aria-live="polite">Loading scanner status…</p><form id="scanner-form" class="flow" hidden><label>Reason for this change<input name="reason" minlength="5" maxlength="500" required placeholder="e.g. Scanner server is not ready yet"></label><label id="scanner-release-label"><input type="checkbox" name="releasePending"> Also release documents already waiting for a scan</label><button type="submit" id="scanner-toggle">Switch scanner off</button><p id="scanner-notice" role="status" aria-live="polite"></p></form></section><form id="document-upload" class="flow"><label>Opportunity <select name="opportunityId" id="document-opportunity" required><option value="">Loading opportunities…</option></select></label><label>Document tier <select name="tier"><option value="1">Tier 1 — basic confidential</option><option value="2" selected>Tier 2 — confidential</option><option value="3">Tier 3 — highest confidentiality (super administrator only)</option></select></label><label>File (PDF, JPEG, PNG, DOCX or XLSX; max 20 MiB)<input type="file" name="file" accept="application/pdf,image/jpeg,image/png,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required></label><button type="submit">Upload private document</button><p id="document-upload-notice" role="status" aria-live="polite"></p></form><hr><label>Filter by opportunity <select id="document-filter"><option value="">All opportunities</option></select></label><p id="document-notice" role="status" aria-live="polite">Loading documents…</p><div class="overflow-x-auto"><table><thead><tr><th>Document</th><th>Opportunity</th><th>Tier</th><th>Scan</th><th>Created</th><th>Actions</th></tr></thead><tbody id="document-rows"></tbody></table></div></main><script src="/static/js/dashboard-documents.js" defer></script></body></html>`
));

admin.get('/documents', requireRole('admin', 'editor', 'publisher', 'super_admin'), async (c) => {
  const opportunityId = (c.req.query('opportunityId') ?? '').trim().slice(0, 100);
  const rows = await c.env.DB.prepare(
    `SELECT d.id, d.opportunity_id AS opportunityId, d.filename, d.content_type AS contentType,
      d.byte_size AS byteSize, d.tier, d.scan_status AS scanStatus, d.sha256,
      d.scan_provider AS scanProvider, d.scanned_at AS scannedAt, d.created_at AS createdAt,
      o.title AS opportunityTitle
     FROM documents d JOIN opportunities o ON o.id = d.opportunity_id
     WHERE (? = '' OR d.opportunity_id = ?)
     ORDER BY d.created_at DESC LIMIT 200`,
  ).bind(opportunityId, opportunityId).all();
  c.header('Cache-Control', 'private, no-store');
  return c.json({ data: rows.results ?? [], limit: 200 });
});

admin.get(
  '/scanner-settings',
  requireRole('admin', 'editor', 'publisher', 'super_admin'),
  async (c) => {
    const row = await c.env.DB.prepare(
      'SELECT updated_at AS updatedAt FROM platform_settings WHERE setting_key = ?',
    )
      .bind(SCANNER_MODE_KEY)
      .first<{ updatedAt: string }>();
    c.header('Cache-Control', 'private, no-store');
    return c.json({
      data: {
        mode: await getScannerMode(c.env),
        scannerConfigured: Boolean(
          c.env.MALWARE_SCANNER_API_URL &&
            c.env.MALWARE_SCANNER_API_TOKEN &&
            c.env.MALWARE_SCANNER_SIGNING_SECRET,
        ),
        updatedAt: row?.updatedAt ?? null,
      },
    });
  },
);

admin.put('/scanner-settings', requireRole('admin', 'super_admin'), async (c) => {
  const parsed = z
    .object({
      mode: z.enum(['enforced', 'disabled']),
      reason: z.string().trim().min(5).max(500),
      releasePending: z.boolean().optional().default(false),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Choose a scanner mode and give a reason of at least 5 characters.',
        },
      },
      422,
    );
  const staff = c.get('staff');
  const previous = await getScannerMode(c.env);
  const timestamp = now();
  const releasePending = parsed.data.mode === 'disabled' && parsed.data.releasePending;
  const pending = releasePending
    ? await c.env.DB.prepare("SELECT COUNT(*) AS total FROM documents WHERE scan_status = 'pending'").first<{
        total: number;
      }>()
    : null;
  const statements = [
    c.env.DB.prepare(
      'INSERT INTO platform_settings (setting_key,value_json,updated_by,updated_at) VALUES (?,?,?,?) ON CONFLICT(setting_key) DO UPDATE SET value_json=excluded.value_json,updated_by=excluded.updated_by,updated_at=excluded.updated_at',
    ).bind(SCANNER_MODE_KEY, JSON.stringify(parsed.data.mode), staff.id, timestamp),
  ];
  if (releasePending)
    statements.push(
      c.env.DB.prepare(
        "UPDATE documents SET scan_status = 'clean', scan_provider = ?, scan_job_id = 'skipped-' || id, scan_verdict = 'clean', scan_digest = sha256, scanned_at = ?, scan_engine_version = 'scanner-disabled' WHERE scan_status = 'pending'",
      ).bind(SCAN_SKIPPED_PROVIDER, timestamp),
    );
  statements.push(
    c.env.DB.prepare(
      "INSERT INTO audit_logs (id,actor_user_id,actor_type,action,entity_type,entity_id,request_id,details_json,created_at) VALUES (?,?,'staff','platform.scanner_mode_changed','platform_settings',?,?,?,?)",
    ).bind(
      id(),
      staff.id,
      SCANNER_MODE_KEY,
      c.get('requestId'),
      JSON.stringify({
        from: previous,
        to: parsed.data.mode,
        reason: parsed.data.reason,
        releasedPending: releasePending ? (pending?.total ?? 0) : 0,
      }),
      timestamp,
    ),
  );
  await c.env.DB.batch(statements);
  c.header('Cache-Control', 'private, no-store');
  return c.json({
    data: {
      mode: parsed.data.mode,
      updatedAt: timestamp,
      releasedPending: releasePending ? (pending?.total ?? 0) : 0,
    },
  });
});

admin.post('/documents/:id/scan', requireRole('admin', 'super_admin'), async (c) => {
  const document = await c.env.DB.prepare(
    'SELECT id, opportunity_id AS opportunityId, r2_key AS r2Key, content_type AS contentType, sha256, scan_status AS scanStatus FROM documents WHERE id = ?',
  )
    .bind(c.req.param('id'))
    .first<{
      id: string;
      opportunityId: string;
      r2Key: string;
      contentType: string;
      sha256: string;
      scanStatus: string;
    }>();
  if (!document)
    return c.json({ error: { code: 'NOT_FOUND', message: 'Document not found.' } }, 404);
  if (document.scanStatus !== 'pending')
    return c.json(
      { error: { code: 'CONFLICT', message: 'Only pending documents can be scanned.' } },
      409,
    );
  let result;
  try {
    result = await scanR2Document(c.env, {
      documentId: document.id,
      r2Key: document.r2Key,
      contentType: document.contentType,
      expectedSha256: document.sha256,
    });
  } catch (error) {
    const code = error instanceof ScannerError ? error.code : 'UNAVAILABLE';
    const status =
      code === 'NOT_CONFIGURED'
        ? 503
        : code === 'OBJECT_MISSING' || code === 'OBJECT_CHANGED'
          ? 409
          : 503;
    return c.json(
      {
        error: {
          code: `SCANNER_${code}`,
          message:
            code === 'OBJECT_CHANGED'
              ? 'Stored file bytes do not match the recorded digest; the file remains unavailable.'
              : code === 'OBJECT_MISSING'
                ? 'Stored file is missing; the file remains unavailable.'
                : 'A verified malware scan could not be completed; the file remains unavailable.',
        },
      },
      status,
    );
  }
  const scanStatus = result.verdict === 'clean' ? 'clean' : 'rejected';
  const timestamp = now();
  const update = c.env.DB.prepare(
    "UPDATE documents SET scan_status = ?, scan_provider = ?, scan_job_id = ?, scan_verdict = ?, scan_digest = ?, scanned_at = ?, scan_engine_version = ? WHERE id = ? AND scan_status = 'pending' AND sha256 = ?",
  ).bind(
    scanStatus,
    result.provider,
    result.reference,
    result.verdict,
    result.sha256,
    result.scannedAt,
    result.engineVersion,
    document.id,
    document.sha256,
  );
  const auditInsert = c.env.DB.prepare(
    "INSERT INTO audit_logs (id, actor_user_id, actor_type, action, entity_type, entity_id, request_id, details_json, created_at) SELECT ?, ?, 'staff', ?, 'document', ?, ?, ?, ? WHERE changes() > 0 AND EXISTS (SELECT 1 FROM documents WHERE id = ? AND scan_job_id = ? AND scan_status = ?)",
  ).bind(
    id(),
    c.get('staff').id,
    `document.scan.${scanStatus}`,
    document.id,
    c.get('requestId'),
    JSON.stringify({
      provider: result.provider,
      reference: result.reference,
      verdict: result.verdict,
      sha256: result.sha256,
      scannedAt: result.scannedAt,
      engineVersion: result.engineVersion,
      opportunityId: document.opportunityId,
      scanSkipped: result.provider === SCAN_SKIPPED_PROVIDER,
    }),
    timestamp,
    document.id,
    result.reference,
    scanStatus,
  );
  try {
    await c.env.DB.batch([update, auditInsert]);
  } catch {
    return c.json(
      {
        error: {
          code: 'SCAN_AUDIT_FAILED',
          message:
            'The scan result could not be recorded atomically; the file remains unavailable.',
        },
      },
      500,
    );
  }
  const saved = await c.env.DB.prepare(
    'SELECT scan_status AS scanStatus, scan_job_id AS scanJobId FROM documents WHERE id = ?',
  )
    .bind(document.id)
    .first<{ scanStatus: string; scanJobId: string | null }>();
  if (!saved || saved.scanJobId !== result.reference || saved.scanStatus !== scanStatus)
    return c.json(
      {
        error: {
          code: 'SCAN_STATE_CONFLICT',
          message: 'The document state changed during scanning; review is required.',
        },
      },
      409,
    );
  return c.json({
    data: {
      id: document.id,
      scanStatus,
      provider: result.provider,
      scanJobId: result.reference,
      sha256: result.sha256,
      scannedAt: result.scannedAt,
      engineVersion: result.engineVersion,
    },
  });
});

admin.patch('/documents/:id/scan-status', requireRole('admin', 'super_admin'), async (c) => {
  const parsed = z
    .object({
      status: z.enum(['clean', 'rejected']),
      reason: z.string().trim().min(5).max(1000),
      scannerReference: z.string().trim().min(1).max(300).optional(),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'Provide a status and a review reason.' } },
      422,
    );
  if (parsed.data.status === 'clean')
    return c.json(
      {
        error: {
          code: 'VERIFIED_SCAN_REQUIRED',
          message:
            'Use POST /dashboard/documents/:id/scan to scan the exact stored object and verify the signed provider result.',
        },
      },
      409,
    );
  const document = await c.env.DB.prepare(
    'SELECT id, opportunity_id AS opportunityId, scan_status AS scanStatus, sha256 FROM documents WHERE id = ?',
  )
    .bind(c.req.param('id'))
    .first<{ id: string; opportunityId: string; scanStatus: string; sha256: string }>();
  if (!document)
    return c.json({ error: { code: 'NOT_FOUND', message: 'Document not found.' } }, 404);
  const timestamp = now();
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE documents SET scan_status = ? WHERE id = ?').bind(
      parsed.data.status,
      document.id,
    ),
    c.env.DB.prepare(
      "INSERT INTO audit_logs (id, actor_user_id, actor_type, action, entity_type, entity_id, request_id, details_json, created_at) VALUES (?, ?, 'staff', ?, 'document', ?, ?, ?, ?)",
    ).bind(
      id(),
      c.get('staff').id,
      `document.scan.${parsed.data.status}`,
      document.id,
      c.get('requestId'),
      JSON.stringify({
        reason: parsed.data.reason,
        scannerReference: parsed.data.scannerReference ?? null,
        sha256: document.sha256,
        opportunityId: document.opportunityId,
      }),
      timestamp,
    ),
  ]);
  return c.json({
    data: { id: document.id, scanStatus: parsed.data.status, updatedAt: timestamp },
  });
});

admin.delete('/documents/:id', requireRole('admin', 'publisher', 'super_admin'), async (c) => {
  const doc = await c.env.DB.prepare(
    'SELECT id, r2_key AS r2Key, opportunity_id AS opportunityId FROM documents WHERE id = ?',
  )
    .bind(c.req.param('id'))
    .first<{ id: string; r2Key: string; opportunityId: string }>();
  if (!doc) return c.json({ error: { code: 'NOT_FOUND', message: 'Document not found.' } }, 404);
  await c.env.DB.prepare('DELETE FROM documents WHERE id = ?').bind(doc.id).run();
  await c.env.PRIVATE_FILES.delete(doc.r2Key);
  await audit(c, 'document.deleted', 'document', doc.id, { opportunityId: doc.opportunityId });
  return c.json({ data: { deleted: true } });
});

admin.get(
  '/tasks/ui',
  requireRole('admin', 'editor', 'broker', 'publisher', 'super_admin'),
  async (c) => {
    return c.html(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Staff tasks · Casinos of Mayfair</title><link rel="stylesheet" href="/static/css/site.css"><link rel="stylesheet" href="/static/css/dashboard.css"></head><body><main class="admin"><p class="eyebrow">STAFF WORKSPACE</p><h1>Task management</h1><nav class="admin-nav"><a href="/dashboard">Overview</a><a href="/dashboard/opportunities/ui">Opportunity CMS</a><a href="/dashboard/buyers/ui">Buyer access</a><a href="/dashboard/enquiries/ui">Enquiries</a><a href="/dashboard/nda-requests/ui">NDA requests</a><a href="/dashboard/notifications/ui">Notifications</a><a href="/dashboard/audit/ui">Audit log</a><a href="/admin/logout">Sign out</a></nav><p class="muted">Create and assign operational follow-ups. Avoid putting sensitive buyer or deal information in task descriptions.</p><form id="task-create" class="task-form"><label>Task title<input name="title" minlength="3" maxlength="180" required></label><label>Priority<select name="priority"><option value="normal">Normal</option><option value="low">Low</option><option value="high">High</option><option value="urgent">Urgent</option></select></label><label>Due date<input name="dueAt" type="datetime-local"></label><label>Assignee user ID (optional)<input name="assignedTo" placeholder="Staff user UUID"></label><label class="full-row">Description<textarea name="description" maxlength="4000"></textarea></label><button type="submit">Create task</button></form><p id="task-notice" class="notice" role="status"></p><section id="task-list" class="task-list" aria-live="polite"><p>Loading tasks…</p></section></main><script src="/static/js/dashboard-tasks.js" defer></script></body></html>`,
    );
  },
);

admin.get('/notifications/ui', requireRole('admin', 'auditor', 'super_admin'), async (c) => {
  return c.html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Notification operations · Casinos of Mayfair</title><link rel="stylesheet" href="/static/css/site.css"><link rel="stylesheet" href="/static/css/dashboard.css"></head><body><main class="admin"><p class="eyebrow">STAFF WORKSPACE</p><h1>Notification operations</h1><nav class="admin-nav"><a href="/dashboard">Overview</a><a href="/dashboard/tasks/ui">Tasks</a><a href="/dashboard/notifications/jobs">Notification job API</a><a href="/dashboard/audit/ui">Audit log</a><a href="/admin/logout">Sign out</a></nav><p class="muted">Delivery status only. Payloads and one-time sign-in codes are never exposed here.</p><p id="notice" role="status"></p><section id="jobs">Loading notification jobs…</section></main><script src="/static/js/dashboard-notifications.js" defer></script></body></html>`,
  );
});

admin.get(
  '/tasks',
  requireRole('admin', 'editor', 'broker', 'publisher', 'auditor', 'super_admin'),
  async (c) => {
    const status = c.req.query('status') ?? '';
    const assignedTo = c.req.query('assignedTo') ?? '';
    const validStatus = ['open', 'in_progress', 'blocked', 'done', 'cancelled'].includes(status)
      ? status
      : '';
    const staff = c.get('staff');
    const brokerOnly = staff.role === 'broker' ? 1 : 0;
    const result = await c.env.DB.prepare(
      `SELECT t.id, t.title, t.description, t.status, t.priority, t.due_at AS dueAt, t.assigned_to AS assignedTo, t.related_entity_type AS relatedEntityType, t.related_entity_id AS relatedEntityId, t.created_at AS createdAt, t.updated_at AS updatedAt, u.display_name AS assigneeName, u.email AS assigneeEmail FROM staff_tasks t LEFT JOIN users u ON u.id = t.assigned_to WHERE (? = '' OR t.status = ?) AND (? = '' OR t.assigned_to = ?) AND (? = 0 OR t.assigned_to = ?) ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, t.due_at IS NULL, t.due_at ASC, t.updated_at DESC LIMIT 200`,
    )
      .bind(validStatus, validStatus, assignedTo, assignedTo, brokerOnly, staff.id)
      .all();
    return c.json({ data: result.results ?? [], limit: 200 });
  },
);

admin.post(
  '/tasks',
  requireRole('admin', 'editor', 'broker', 'publisher', 'super_admin'),
  async (c) => {
    const parsed = z
      .object({
        title: z.string().trim().min(3).max(180),
        description: z.string().trim().max(4000).optional().default(''),
        priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
        dueAt: z.string().datetime().optional(),
        assignedTo: z.string().uuid().optional(),
        relatedEntityType: z
          .enum(['opportunity', 'enquiry', 'nda_request', 'access_grant'])
          .optional(),
        relatedEntityId: z.string().max(100).optional(),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'Check the task fields.' } },
        422,
      );
    const input = parsed.data;
    const staff = c.get('staff');
    if (staff.role === 'broker' && input.assignedTo && input.assignedTo !== staff.id)
      return c.json(
        { error: { code: 'FORBIDDEN', message: 'Brokers can only assign tasks to themselves.' } },
        403,
      );
    const taskAssignee = staff.role === 'broker' ? staff.id : (input.assignedTo ?? null);
    if (taskAssignee) {
      const assignee = await c.env.DB.prepare(
        "SELECT id FROM users WHERE id = ? AND user_type = 'staff' AND status = 'active'",
      )
        .bind(taskAssignee)
        .first();
      if (!assignee)
        return c.json(
          { error: { code: 'INVALID_ASSIGNEE', message: 'Choose an active staff member.' } },
          422,
        );
    }
    if (input.relatedEntityType && !input.relatedEntityId)
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'Related entity ID is required.' } },
        422,
      );
    const taskId = id();
    const timestamp = now();
    await c.env.DB.prepare(
      "INSERT INTO staff_tasks (id,title,description,status,priority,due_at,assigned_to,related_entity_type,related_entity_id,created_by,created_at,updated_at) VALUES (?,?,?,'open',?,?,?,?,?,?,?,?)",
    )
      .bind(
        taskId,
        input.title,
        input.description,
        input.priority,
        input.dueAt ?? null,
        taskAssignee,
        input.relatedEntityType ?? null,
        input.relatedEntityId ?? null,
        staff.id,
        timestamp,
        timestamp,
      )
      .run();
    await audit(c, 'task.created', 'staff_task', taskId, {
      priority: input.priority,
      assignedTo: taskAssignee,
    });
    return c.json(
      {
        data: {
          id: taskId,
          status: 'open',
          ...input,
          assignedTo: taskAssignee,
          createdAt: timestamp,
        },
      },
      201,
    );
  },
);

admin.patch(
  '/tasks/:id',
  requireRole('admin', 'editor', 'broker', 'publisher', 'super_admin'),
  async (c) => {
    const parsed = z
      .object({
        title: z.string().trim().min(3).max(180).optional(),
        description: z.string().trim().max(4000).optional(),
        status: z.enum(['open', 'in_progress', 'blocked', 'done', 'cancelled']).optional(),
        priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
        dueAt: z.string().datetime().nullable().optional(),
        assignedTo: z.string().uuid().nullable().optional(),
      })
      .refine((value) => Object.keys(value).length > 0)
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'Provide at least one valid task field.' } },
        422,
      );
    const staff = c.get('staff');
    const brokerOnly = staff.role === 'broker' ? 1 : 0;
    const current = await c.env.DB.prepare(
      'SELECT id, status, assigned_to AS assignedTo FROM staff_tasks WHERE id = ? AND (? = 0 OR assigned_to = ?)',
    )
      .bind(c.req.param('id'), brokerOnly, staff.id)
      .first<{ id: string; status: string; assignedTo: string | null }>();
    if (!current) return c.json({ error: { code: 'NOT_FOUND', message: 'Task not found.' } }, 404);
    const input = parsed.data;
    if (staff.role === 'broker' && input.assignedTo !== undefined && input.assignedTo !== staff.id)
      return c.json(
        { error: { code: 'FORBIDDEN', message: 'Brokers cannot reassign tasks.' } },
        403,
      );
    if (input.assignedTo) {
      const assignee = await c.env.DB.prepare(
        "SELECT id FROM users WHERE id = ? AND user_type = 'staff' AND status = 'active'",
      )
        .bind(input.assignedTo)
        .first();
      if (!assignee)
        return c.json(
          { error: { code: 'INVALID_ASSIGNEE', message: 'Choose an active staff member.' } },
          422,
        );
    }
    const timestamp = now();
    await c.env.DB.prepare(
      'UPDATE staff_tasks SET title=COALESCE(?,title), description=COALESCE(?,description), status=COALESCE(?,status), priority=COALESCE(?,priority), due_at=CASE WHEN ? = 1 THEN ? ELSE due_at END, assigned_to=CASE WHEN ? = 1 THEN ? ELSE assigned_to END, completed_at=CASE WHEN ? = 1 THEN ? WHEN ? = 1 THEN NULL ELSE completed_at END, updated_at=? WHERE id=?',
    )
      .bind(
        input.title ?? null,
        input.description ?? null,
        input.status ?? null,
        input.priority ?? null,
        Number(input.dueAt !== undefined),
        input.dueAt ?? null,
        Number(input.assignedTo !== undefined),
        input.assignedTo ?? null,
        Number(input.status === 'done'),
        timestamp,
        Number(input.status !== undefined && input.status !== 'done'),
        timestamp,
        c.req.param('id'),
      )
      .run();
    await audit(c, 'task.updated', 'staff_task', current.id, { fields: Object.keys(input) });
    return c.json({ data: { id: current.id, updatedAt: timestamp } });
  },
);

admin.get('/access-grants/ui', requireRole('admin', 'publisher', 'super_admin'), async (c) =>
  c.html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Data-room access · Casinos of Mayfair</title><link rel="stylesheet" href="/static/css/site.css"><link rel="stylesheet" href="/static/css/dashboard.css"></head><body><main class="admin"><p class="eyebrow">STAFF WORKSPACE</p><h1>Data-room access grants</h1><p class="muted">Access is time-limited, independent from account status and revocable. Every revocation requires a reason and is audited.</p><nav class="admin-nav"><a href="/dashboard">Overview</a><a href="/dashboard/nda-requests/ui">NDA requests</a><a href="/dashboard/access-grants/ui">Access grants</a><a href="/dashboard/buyers/ui">Buyer access</a><a href="/admin/logout">Sign out</a></nav><p id="notice" role="status"></p><section id="grants">Loading access grants…</section></main><script src="/static/js/dashboard-access-grants.js" defer></script></body></html>`,
  ),
);

admin.get(
  '/access-grants',
  requireRole('admin', 'publisher', 'auditor', 'super_admin'),
  async (c) => {
    const result = await c.env.DB.prepare(
      'SELECT g.id, g.tier, g.granted_at AS grantedAt, g.expires_at AS expiresAt, g.revoked_at AS revokedAt, u.email AS buyerEmail, u.display_name AS buyerName, o.title AS opportunityTitle FROM access_grants g JOIN users u ON u.id = g.user_id JOIN opportunities o ON o.id = g.opportunity_id ORDER BY CASE WHEN g.revoked_at IS NULL AND g.expires_at > ? THEN 0 ELSE 1 END, g.granted_at DESC LIMIT 300',
    )
      .bind(now())
      .all();
    return c.json({ data: result.results ?? [] });
  },
);

admin.post(
  '/access-grants/:id/revoke',
  requireRole('admin', 'publisher', 'super_admin'),
  async (c) => {
    const parsed = z
      .object({ reason: z.string().trim().min(3).max(1000) })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'A revocation reason is required.' } },
        422,
      );
    const grant = await c.env.DB.prepare(
      'SELECT id, revoked_at AS revokedAt, user_id AS userId, opportunity_id AS opportunityId FROM access_grants WHERE id = ?',
    )
      .bind(c.req.param('id'))
      .first<{ id: string; revokedAt: string | null; userId: string; opportunityId: string }>();
    if (!grant)
      return c.json({ error: { code: 'NOT_FOUND', message: 'Access grant not found.' } }, 404);
    if (grant.revokedAt)
      return c.json({ data: { id: grant.id, revoked: true, alreadyRevoked: true } });
    const timestamp = now();
    await c.env.DB.batch([
      c.env.DB.prepare(
        'UPDATE access_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL',
      ).bind(timestamp, grant.id),
      c.env.DB.prepare(
        "INSERT INTO audit_logs (id, actor_user_id, actor_type, action, entity_type, entity_id, request_id, details_json, created_at) VALUES (?, ?, 'staff', 'access_grant.revoked', 'access_grant', ?, ?, ?, ?)",
      ).bind(
        id(),
        c.get('staff').id,
        grant.id,
        c.get('requestId'),
        JSON.stringify({
          reason: parsed.data.reason,
          userId: grant.userId,
          opportunityId: grant.opportunityId,
        }),
        timestamp,
      ),
    ]);
    return c.json({ data: { id: grant.id, revoked: true, revokedAt: timestamp } });
  },
);

admin.get('/notifications/jobs', requireRole('admin', 'auditor', 'super_admin'), async (c) => {
  const result = await c.env.DB.prepare(
    'SELECT id, job_type AS jobType, status, attempts, available_at AS availableAt, created_at AS createdAt, updated_at AS updatedAt FROM notification_jobs ORDER BY created_at DESC LIMIT 100',
  ).all();
  return c.json({ data: result.results ?? [], limit: 100 });
});

admin.post('/notifications/jobs/:id/retry', requireRole('admin', 'super_admin'), async (c) => {
  const job = await c.env.DB.prepare(
    'SELECT id, job_type AS jobType, status FROM notification_jobs WHERE id = ?',
  )
    .bind(c.req.param('id'))
    .first<{ id: string; jobType: string; status: string }>();
  if (!job)
    return c.json({ error: { code: 'NOT_FOUND', message: 'Notification job not found.' } }, 404);
  if (job.status === 'sent' || job.status === 'processing')
    return c.json(
      { error: { code: 'CONFLICT', message: 'Only unsent jobs can be retried.' } },
      409,
    );
  const timestamp = now();
  await c.env.DB.prepare(
    "UPDATE notification_jobs SET status = 'queued', available_at = ?, updated_at = ? WHERE id = ?",
  )
    .bind(timestamp, timestamp, job.id)
    .run();
  await audit(c, 'notification.retry_requested', 'notification_job', job.id, {
    previousStatus: job.status,
  });
  try {
    await c.env.NOTIFICATIONS_QUEUE.send({ jobId: job.id, type: job.jobType });
  } catch {
    /* Scheduled recovery will re-enqueue due jobs. */
  }
  return c.json({ data: { id: job.id, status: 'queued' } });
});

admin.get('/audit/ui', requireRole('admin', 'auditor', 'super_admin'), async (c) =>
  c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Audit log · Casinos of Mayfair</title><link rel="stylesheet" href="/static/css/site.css"><link rel="stylesheet" href="/static/css/dashboard.css"></head><body><main class="admin"><p class="eyebrow">GOVERNANCE</p><h1>Audit log</h1><nav class="admin-nav"><a href="/dashboard">Overview</a><a href="/dashboard/opportunities/ui">Opportunity CMS</a><a href="/dashboard/nda-requests/ui">NDA requests</a><a href="/dashboard/staff/ui">Staff accounts</a><a href="/admin/logout">Sign out</a></nav><p class="muted">Read-only record of administrative and platform events. Filters are applied server-side; details are metadata, not a substitute for reviewing the underlying record.</p><form id="audit-filters" class="flow-grid"><label>Search <input id="audit-search" type="search" maxlength="100" placeholder="Action, entity ID or actor email"></label><label>Action contains <input id="audit-action" type="text" maxlength="100" placeholder="opportunity.updated"></label><label>Entity type <input id="audit-entity" type="text" maxlength="60" placeholder="opportunity"></label><label>From date <input id="audit-from" type="date"></label><label>To date <input id="audit-to" type="date"></label><div class="btn-row"><button type="submit">Apply filters</button><button id="audit-reset" type="button" class="secondary">Reset</button><button id="audit-export" type="button" class="secondary">Export filtered CSV</button></div></form><p class="muted">CSV export is limited to 5,000 matching events per download. Narrow the filters if the result is larger.</p><p id="audit-status" role="status" aria-live="polite">Loading audit events…</p><div class="overflow-x-auto"><table><thead><tr><th>When (UTC)</th><th>Actor</th><th>Action</th><th>Entity</th><th>Details</th></tr></thead><tbody id="audit-rows"><tr><td colspan="5">Loading…</td></tr></tbody></table></div><div class="btn-row"><button id="audit-prev" type="button" disabled>Previous</button><span id="audit-page">Page 1</span><button id="audit-next" type="button" disabled>Next</button></div></main><script src="/static/js/dashboard-audit.js" defer></script></body></html>`),
);

admin.get('/audit/export.csv', requireRole('admin', 'auditor', 'super_admin'), async (c) => {
  const query = c.req.query();
  const search = (query.search ?? '').trim().slice(0, 100);
  const action = (query.action ?? '').trim().slice(0, 100);
  const entityType = (query.entityType ?? '').trim().slice(0, 60);
  const from = query.from ?? '';
  const to = query.to ?? '';
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  const validDate = (value: string) => {
    if (!datePattern.test(value)) return false;
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  };
  if ((from && !validDate(from)) || (to && !validDate(to)) || (from && to && from > to))
    return c.json({ error: { code: 'INVALID_AUDIT_FILTER', message: 'Use valid dates and ensure the start date is not after the end date.' } }, 422);
  const where: string[] = [];
  const binds: string[] = [];
  if (search) { where.push('(a.action LIKE ? OR a.entity_id LIKE ? OR u.email LIKE ?)'); const term = `%${search}%`; binds.push(term, term, term); }
  if (action) { where.push('a.action LIKE ?'); binds.push(`%${action}%`); }
  if (entityType) { where.push('a.entity_type = ?'); binds.push(entityType); }
  if (from) { where.push('a.created_at >= ?'); binds.push(`${from}T00:00:00.000Z`); }
  if (to) { where.push('a.created_at < ?'); const next = new Date(`${to}T00:00:00.000Z`); next.setUTCDate(next.getUTCDate() + 1); binds.push(next.toISOString()); }
  const filterSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const result = await c.env.DB.prepare(
    `SELECT a.id, a.created_at AS createdAt, u.email AS actorEmail, a.actor_type AS actorType, a.action, a.entity_type AS entityType, a.entity_id AS entityId, a.request_id AS requestId, a.details_json AS details FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id${filterSql} ORDER BY a.created_at DESC, a.id DESC LIMIT 5001`,
  ).bind(...binds).all<{ id: string; createdAt: string; actorEmail: string | null; actorType: string; action: string; entityType: string; entityId: string; requestId: string | null; details: string | null }>();
  const rows = result.results ?? [];
  if (rows.length > 5000)
    return c.json({ error: { code: 'AUDIT_EXPORT_TOO_LARGE', message: 'More than 5,000 events match. Add filters and try again.' } }, 422);
  const cell = (value: unknown) => {
    let text = value == null ? '' : typeof value === 'string' ? value : String(value);
    if (/^[\s]*[=+@-]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const header = ['id', 'created_at_utc', 'actor_email', 'actor_type', 'action', 'entity_type', 'entity_id', 'request_id', 'details_json'];
  const csv = [header, ...rows.map((row) => [row.id, row.createdAt, row.actorEmail, row.actorType, row.action, row.entityType, row.entityId, row.requestId, row.details])]
    .map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n';
  await audit(c, 'audit.exported', 'audit_log', 'filtered', { count: rows.length, filters: { search: Boolean(search), action: Boolean(action), entityType: Boolean(entityType), from: from || null, to: to || null }, format: 'csv' });
  c.header('Cache-Control', 'private, no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Content-Type', 'text/csv; charset=utf-8');
  c.header('Content-Disposition', `attachment; filename="casinos-of-mayfair-audit-${new Date().toISOString().slice(0, 10)}.csv"`);
  return c.body(csv);
});

admin.get('/audit', requireRole('admin', 'auditor', 'super_admin'), async (c) => {
  const query = c.req.query();
  const pageRaw = Number(query.page ?? 1);
  const limitRaw = Number(query.limit ?? 50);
  const requestedPage = Number.isSafeInteger(pageRaw) ? Math.max(1, Math.min(10000, pageRaw)) : 1;
  const limit = Number.isSafeInteger(limitRaw) ? Math.max(1, Math.min(100, limitRaw)) : 50;
  const search = (query.search ?? '').trim().slice(0, 100);
  const action = (query.action ?? '').trim().slice(0, 100);
  const entityType = (query.entityType ?? '').trim().slice(0, 60);
  const from = query.from ?? '';
  const to = query.to ?? '';
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  const validDate = (value: string) => {
    if (!datePattern.test(value)) return false;
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  };
  if ((from && !validDate(from)) || (to && !validDate(to)) || (from && to && from > to))
    return c.json({ error: { code: 'INVALID_AUDIT_FILTER', message: 'Use valid dates and ensure the start date is not after the end date.' } }, 422);
  const where: string[] = [];
  const binds: (string | number)[] = [];
  if (search) { where.push('(a.action LIKE ? OR a.entity_id LIKE ? OR u.email LIKE ?)'); const term = `%${search}%`; binds.push(term, term, term); }
  if (action) { where.push('a.action LIKE ?'); binds.push(`%${action}%`); }
  if (entityType) { where.push('a.entity_type = ?'); binds.push(entityType); }
  if (from) { where.push('a.created_at >= ?'); binds.push(`${from}T00:00:00.000Z`); }
  if (to) { where.push('a.created_at < ?'); const next = new Date(`${to}T00:00:00.000Z`); next.setUTCDate(next.getUTCDate() + 1); binds.push(next.toISOString()); }
  const filterSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const count = await c.env.DB.prepare(`SELECT COUNT(*) AS total FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id${filterSql}`).bind(...binds).first<{ total: number }>();
  const total = count?.total ?? 0;
  const pages = Math.ceil(total / limit);
  const page = Math.min(requestedPage, Math.max(1, pages));
  const offset = (page - 1) * limit;
  const result = await c.env.DB.prepare(
    `SELECT a.id, a.action, a.entity_type AS entityType, a.entity_id AS entityId, a.details_json AS details, a.created_at AS createdAt, u.email AS actorEmail FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id${filterSql} ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?`,
  ).bind(...binds, limit, offset).all();
  c.header('Cache-Control', 'private, no-store');
  return c.json({ data: result.results ?? [], page, limit, total, pages });
});

const platformSettingKeys = [
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
const brandImageKeys = [
  'apple_touch_icon_url',
  'icon_192_url',
  'icon_512_url',
  'og_image_url',
  'chairman_image_url',
];
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
admin.get('/settings', requireRole('admin', 'super_admin', 'editor'), async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT setting_key AS key,value_json AS value,updated_at AS updatedAt FROM platform_settings ORDER BY setting_key',
  ).all<{ key: string; value: string; updatedAt: string }>();
  return c.json({
    data: (rows.results ?? []).map((r) => ({
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
    statements.push(
      c.env.DB.prepare(
        'INSERT INTO platform_settings (setting_key,value_json,updated_by,updated_at) VALUES (?,?,?,?) ON CONFLICT(setting_key) DO UPDATE SET value_json=excluded.value_json,updated_by=excluded.updated_by,updated_at=excluded.updated_at',
      ).bind(key, JSON.stringify(value), staff.id, timestamp),
    );
  }
  if (statements.length)
    statements.push(
      c.env.DB.prepare(
        "INSERT INTO audit_logs (id,actor_user_id,actor_type,action,entity_type,entity_id,request_id,details_json,created_at) VALUES (?,?,'staff','platform.settings_updated','platform_settings','global',?,?,?)",
      ).bind(
        id(),
        staff.id,
        c.get('requestId'),
        JSON.stringify({ keys: Object.keys(body) }),
        timestamp,
      ),
    );
  if (statements.length) await c.env.DB.batch(statements);
  return c.json({ data: { saved: Object.keys(body).length, updatedAt: timestamp } });
});

admin.get('/pages/ui', requireRole('admin', 'super_admin', 'editor'), (c) =>
  c.html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pages · Casinos of Mayfair</title><link rel="stylesheet" href="/static/css/site.css"><link rel="stylesheet" href="/static/css/dashboard.css"></head><body><main class="admin"><p class="eyebrow">STAFF WORKSPACE</p><h1>Pages</h1><nav class="admin-nav"><a href="/dashboard">Overview</a><a href="/dashboard/settings/ui">Settings</a><a href="/dashboard/pages/ui">Pages</a><a href="/dashboard/forms/ui">Forms</a><a href="/admin/logout">Sign out</a></nav><section id="pages-list-view"><p class="muted">Edit the text of built-in pages (About, Services, FAQ, legal notices) or add your own pages. A built-in page always keeps its address, for example /legal/privacy. New pages live under /pages/.</p><div class="dx-toolbar"><div class="dx-tabs" id="pg-tabs" role="tablist"><button type="button" class="dx-tab" role="tab" data-tab="all" aria-selected="true">All<span class="dx-count">0</span></button><button type="button" class="dx-tab" role="tab" data-tab="builtin" aria-selected="false">Built-in<span class="dx-count">0</span></button><button type="button" class="dx-tab" role="tab" data-tab="custom" aria-selected="false">My pages<span class="dx-count">0</span></button><button type="button" class="dx-tab" role="tab" data-tab="draft" aria-selected="false">Drafts<span class="dx-count">0</span></button></div><input class="dx-search" id="pg-search" type="search" placeholder="Search pages" aria-label="Search pages"><span class="dx-spacer"></span><button type="button" class="dx-btn dx-btn-primary" id="pg-new">New page</button></div><div id="pg-table" class="dx-table-wrap">Loading…</div></section><section id="pages-editor-view" hidden><div class="dx-editor-bar"><button type="button" class="dx-btn" id="pg-back">← All pages</button><h2 id="pg-heading">New page</h2><span class="dx-spacer"></span><a class="dx-btn" id="pg-view" target="_blank" rel="noopener" hidden>View live</a><button type="submit" form="pg-form" class="dx-btn dx-btn-primary">Save page</button></div><form id="pg-form" class="dx-editor"><input type="hidden" name="id"><div class="dx-editor-main"><div class="dx-card"><label class="dx-field">Title<input name="title" minlength="3" maxlength="180" required></label><label class="dx-field">Content<small>Plain text. Blank lines start a new paragraph. HTML is not executed.</small><textarea name="bodyMarkdown" rows="18" maxlength="20000" required></textarea></label></div><details class="dx-card"><summary>Search appearance (optional)</summary><div class="dx-form"><label class="dx-field">Page description<textarea name="description" maxlength="500" rows="2"></textarea></label><label class="dx-field">SEO title<input name="seoTitle" maxlength="180"></label><label class="dx-field">SEO description<input name="seoDescription" maxlength="320"></label></div></details></div><aside class="dx-editor-side"><div class="dx-card"><label class="dx-field">Status<select name="status"><option value="draft">Draft - not public</option><option value="published">Published - live</option><option value="archived">Archived - hidden</option></select></label><div class="dx-field"><span>Address</span><div id="pg-url" class="dx-url"></div><input name="slug" id="pg-slug" pattern="[a-z0-9]+(-[a-z0-9]+)*" maxlength="100" required><small id="pg-url-note"></small></div></div></aside></form></section></main><script src="/static/js/dashboard-kit.js" defer></script><script src="/static/js/dashboard-pages.js" defer></script></body></html>`,
  ),
);
admin.get('/pages/defaults', requireRole('admin', 'super_admin', 'editor'), (c) =>
  c.json({
    data: STATIC_PAGES.map(([path, title, description, , copy]) => ({
      path,
      slug: staticPageSlug(path),
      title,
      description,
      bodyMarkdown: copy,
    })),
  }),
);
admin.get('/pages', requireRole('admin', 'super_admin', 'editor'), async (c) => {
  const r = await c.env.DB.prepare(
    'SELECT id,slug,title,description,body_markdown AS bodyMarkdown,status,seo_title AS seoTitle,seo_description AS seoDescription,updated_at AS updatedAt FROM managed_pages ORDER BY updated_at DESC LIMIT 200',
  ).all<{ slug: string }>();
  const builtIn = new Map(STATIC_PAGES.map(([path]) => [staticPageSlug(path), path]));
  return c.json({
    data: (r.results ?? []).map((row) => ({
      ...row,
      isBuiltin: builtIn.has(row.slug),
      publicPath: builtIn.get(row.slug) ?? `/pages/${row.slug}`,
    })),
  });
});
admin.post('/pages', requireRole('admin', 'super_admin', 'editor'), async (c) => {
  const p = z
    .object({
      id: z.string().uuid().optional(),
      title: z.string().trim().min(3).max(180),
      slug: z
        .string()
        .trim()
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
        .max(100),
      description: z.string().max(500).default(''),
      bodyMarkdown: z.string().min(1).max(20000),
      status: z.enum(['draft', 'published', 'archived']),
      seoTitle: z.string().max(180).default(''),
      seoDescription: z.string().max(320).default(''),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!p.success)
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Check the page fields.' } }, 422);
  const d = p.data,
    staff = c.get('staff'),
    timestamp = now(),
    pageId = d.id ?? id();
  const builtIn = new Map(STATIC_PAGES.map(([path]) => [staticPageSlug(path), path]));
  if (d.id) {
    const existing = await c.env.DB.prepare('SELECT slug FROM managed_pages WHERE id = ?')
      .bind(d.id)
      .first<{ slug: string }>();
    if (existing && existing.slug !== d.slug && (builtIn.has(existing.slug) || builtIn.has(d.slug)))
      return c.json(
        {
          error: {
            code: 'SLUG_LOCKED',
            message: 'The address of a built-in page cannot be changed.',
          },
        },
        422,
      );
  }
  try {
    await c.env.DB.prepare(
      'INSERT INTO managed_pages (id,slug,title,description,body_markdown,status,seo_title,seo_description,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET slug=excluded.slug,title=excluded.title,description=excluded.description,body_markdown=excluded.body_markdown,status=excluded.status,seo_title=excluded.seo_title,seo_description=excluded.seo_description,updated_by=excluded.updated_by,updated_at=excluded.updated_at',
    )
      .bind(
        pageId,
        d.slug,
        d.title,
        d.description,
        d.bodyMarkdown,
        d.status,
        d.seoTitle,
        d.seoDescription,
        staff.id,
        staff.id,
        timestamp,
        timestamp,
      )
      .run();
  } catch {
    return c.json(
      { error: { code: 'SLUG_CONFLICT', message: 'That slug is already in use.' } },
      409,
    );
  }
  await audit(c, 'managed_page.saved', 'managed_page', pageId, { slug: d.slug, status: d.status });
  return c.json({
    data: {
      id: pageId,
      slug: d.slug,
      status: d.status,
      isBuiltin: builtIn.has(d.slug),
      publicPath: builtIn.get(d.slug) ?? `/pages/${d.slug}`,
    },
  });
});

admin.patch('/pages/:id/status', requireRole('admin', 'super_admin', 'editor'), async (c) => {
  const body = z
    .object({ status: z.enum(['draft', 'published', 'archived']) })
    .safeParse(await c.req.json().catch(() => null));
  if (!body.success)
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Choose a valid status.' } }, 422);
  const page = await c.env.DB.prepare('SELECT id, slug FROM managed_pages WHERE id = ?')
    .bind(c.req.param('id'))
    .first<{ id: string; slug: string }>();
  if (!page) return c.json({ error: { code: 'NOT_FOUND', message: 'Page not found.' } }, 404);
  await c.env.DB.prepare(
    'UPDATE managed_pages SET status = ?, updated_by = ?, updated_at = ? WHERE id = ?',
  )
    .bind(body.data.status, c.get('staff').id, now(), page.id)
    .run();
  await audit(c, 'managed_page.status_changed', 'managed_page', page.id, {
    slug: page.slug,
    status: body.data.status,
  });
  return c.json({ data: { id: page.id, status: body.data.status } });
});

/** Deletes a custom page, or resets a built-in page back to its default text. */
admin.delete('/pages/:id', requireRole('admin', 'super_admin'), async (c) => {
  const page = await c.env.DB.prepare('SELECT id, slug FROM managed_pages WHERE id = ?')
    .bind(c.req.param('id'))
    .first<{ id: string; slug: string }>();
  if (!page) return c.json({ error: { code: 'NOT_FOUND', message: 'Page not found.' } }, 404);
  await c.env.DB.prepare('DELETE FROM managed_pages WHERE id = ?').bind(page.id).run();
  await audit(c, 'managed_page.deleted', 'managed_page', page.id, { slug: page.slug });
  return c.json({ data: { id: page.id, deleted: true } });
});

admin.get('/forms/ui', requireRole('admin', 'super_admin', 'editor'), (c) =>
  c.html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Managed forms</title><link rel="stylesheet" href="/static/css/site.css"><link rel="stylesheet" href="/static/css/dashboard.css"></head><body><main class="admin"><h1>Managed forms</h1><nav class="admin-nav"><a href="/dashboard">Overview</a><a href="/dashboard/settings/ui">Settings</a><a href="/dashboard/pages/ui">Pages</a><a href="/dashboard/forms/ui">Forms</a><a href="/admin/logout">Sign out</a></nav><p>Build a form by adding the fields you need below. Submissions are saved and listed further down; published forms can optionally be associated with a listing using its slug.</p><form id="managed-form-form" class="flow" data-flow><input type="hidden" name="id"><label>Title <input name="title" minlength="3" maxlength="180" required></label><label>Slug <input name="slug" pattern="[a-z0-9-]+" maxlength="100" required></label><label>Description <textarea name="description" maxlength="500"></textarea></label><label>Fields JSON <textarea name="fieldsJson" rows="8" required>[{"name":"name","label":"Full name","type":"text","required":true},{"name":"email","label":"Business email","type":"email","required":true},{"name":"message","label":"How can we help?","type":"textarea","required":true}]</textarea></label><label>Status <select name="status"><option value="draft">Draft</option><option value="published">Published</option><option value="archived">Archived</option></select></label><label><input type="checkbox" name="notificationEnabled" checked> Notify staff by email on submission</label><button>Save form</button></form><p id="form-notice" role="status"></p><ul id="managed-forms"></ul><h2>Form submissions</h2><p>Submissions are shown newest first. Contact and listing details are confidential; use them only for the requested business purpose.</p><div class="enq-bar"><label>Status <select id="sub-status"><option value="">All</option><option value="new">New</option><option value="in_progress">In progress</option><option value="closed">Closed</option><option value="spam">Spam</option></select></label><label>Search <input id="sub-q" type="search" maxlength="100" placeholder="Search submitted details" autocomplete="off"></label><a id="sub-export" class="button secondary" href="/dashboard/form-submissions/export.csv" download>Export CSV</a></div><section id="managed-submissions" aria-live="polite">Loading submissions…</section></main><script src="/static/js/dashboard-forms.js" defer></script></body></html>`,
  ),
);
admin.get('/forms', requireRole('admin', 'super_admin', 'editor'), async (c) => {
  const r = await c.env.DB.prepare(
    'SELECT id,slug,title,description,fields_json AS fieldsJson,notification_enabled AS notificationEnabled,status,updated_at AS updatedAt FROM managed_forms ORDER BY updated_at DESC LIMIT 200',
  ).all();
  return c.json({ data: r.results ?? [] });
});
const submissionStatuses = ['new', 'in_progress', 'closed', 'spam'] as const;
const submissionSelect =
  's.id, s.data_json AS dataJson, s.status, s.internal_note AS internalNote, s.created_at AS createdAt, s.updated_at AS updatedAt, f.title AS formTitle, f.slug AS formSlug, o.title AS opportunityTitle';
const submissionFrom =
  'FROM managed_form_submissions s JOIN managed_forms f ON f.id = s.form_id LEFT JOIN opportunities o ON o.id = s.opportunity_id';
const submissionFilter =
  "WHERE (? = '' OR s.status = ?) AND (? = '' OR f.slug = ?) AND (? = '' OR s.data_json LIKE ? ESCAPE '\\')";
function submissionFilters(c: {
  req: { query(key: string): string | undefined };
}): [string, string, string, string, string, string] {
  const status = c.req.query('status') ?? '';
  const safeStatus = (submissionStatuses as readonly string[]).includes(status) ? status : '';
  const form = (c.req.query('form') ?? '').slice(0, 100);
  const q = (c.req.query('q') ?? '').trim().slice(0, 100);
  const like = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  return [safeStatus, safeStatus, form, form, q, like];
}
admin.get(
  '/form-submissions',
  requireRole('admin', 'super_admin', 'editor', 'broker', 'auditor'),
  async (c) => {
    const r = await c.env.DB.prepare(
      `SELECT ${submissionSelect} ${submissionFrom} ${submissionFilter} ORDER BY s.created_at DESC LIMIT 200`,
    )
      .bind(...submissionFilters(c))
      .all();
    return c.json({
      data: (r.results ?? []).map((row) => {
        let data: unknown = {};
        try {
          data = JSON.parse(String((row as Record<string, unknown>).dataJson ?? '{}'));
        } catch {
          /* keep empty object for a corrupt row */
        }
        const { dataJson: _raw, ...rest } = row as Record<string, unknown>;
        return { ...rest, data };
      }),
    });
  },
);
admin.get('/form-submissions/export.csv', requireRole('admin', 'super_admin'), async (c) => {
  const r = await c.env.DB.prepare(
    `SELECT ${submissionSelect} ${submissionFrom} ${submissionFilter} ORDER BY s.created_at DESC LIMIT 5000`,
  )
    .bind(...submissionFilters(c))
    .all<Record<string, unknown>>();
  const rows = (r.results ?? []).map((row) => {
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(String(row.dataJson ?? '{}')) as Record<string, unknown>;
    } catch {
      /* corrupt row exports with empty fields */
    }
    return { row, data };
  });
  const keys = [...new Set(rows.flatMap((x) => Object.keys(x.data)))].sort();
  const head = ['id', 'received_at', 'form', 'listing', 'status', 'internal_note', ...keys];
  const lines = [head.map(csvCell).join(',')];
  for (const { row, data } of rows)
    lines.push(
      [
        row.id,
        row.createdAt,
        row.formTitle,
        row.opportunityTitle ?? '',
        row.status,
        row.internalNote,
        ...keys.map((k) => data[k] ?? ''),
      ]
        .map(csvCell)
        .join(','),
    );
  await audit(c, 'managed_form.submissions_exported', 'managed_form_submission', 'export', {
    count: rows.length,
  });
  return new Response(`\uFEFF${lines.join('\r\n')}\r\n`, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="form-submissions-${now().slice(0, 10)}.csv"`,
      'cache-control': 'no-store',
    },
  });
});
admin.patch(
  '/form-submissions/:id',
  requireRole('admin', 'super_admin', 'editor', 'broker'),
  async (c) => {
    const parsed = z
      .object({
        status: z.enum(submissionStatuses).optional(),
        internalNote: z.string().trim().max(3000).optional(),
      })
      .refine((v) => Object.keys(v).length > 0)
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'Provide a valid status or note.' } },
        422,
      );
    const existing = await c.env.DB.prepare(
      'SELECT id, status FROM managed_form_submissions WHERE id = ?',
    )
      .bind(c.req.param('id'))
      .first<{ id: string; status: string }>();
    if (!existing)
      return c.json({ error: { code: 'NOT_FOUND', message: 'Submission not found.' } }, 404);
    const sets = ['updated_at = ?'];
    const values: string[] = [now()];
    if (parsed.data.status) {
      sets.push('status = ?');
      values.push(parsed.data.status);
    }
    if (parsed.data.internalNote !== undefined) {
      sets.push('internal_note = ?');
      values.push(parsed.data.internalNote);
    }
    await c.env.DB.prepare(`UPDATE managed_form_submissions SET ${sets.join(', ')} WHERE id = ?`)
      .bind(...values, existing.id)
      .run();
    await audit(c, 'managed_form.submission_updated', 'managed_form_submission', existing.id, {
      from: existing.status,
      status: parsed.data.status,
      noteChanged: parsed.data.internalNote !== undefined,
    });
    return c.json({
      data: {
        id: existing.id,
        status: parsed.data.status ?? existing.status,
        updatedAt: values[0],
      },
    });
  },
);
admin.post('/forms', requireRole('admin', 'super_admin', 'editor'), async (c) => {
  const p = z
    .object({
      id: z.string().uuid().optional(),
      title: z.string().trim().min(3).max(180),
      slug: z
        .string()
        .trim()
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
        .max(100),
      description: z.string().max(500).default(''),
      fieldsJson: z.string().max(10000),
      notificationEnabled: z.boolean().default(true),
      status: z.enum(['draft', 'published', 'archived']),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!p.success)
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Check the form fields.' } }, 422);
  let fields: unknown;
  try {
    fields = JSON.parse(p.data.fieldsJson);
  } catch {
    return c.json(
      { error: { code: 'INVALID_FIELDS_JSON', message: 'Fields must be valid JSON.' } },
      422,
    );
  }
  const fieldSchema = z
    .array(
      z.object({
        name: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
        label: z.string().min(1).max(80),
        type: z.enum(['text', 'email', 'tel', 'textarea', 'select']),
        required: z.boolean().optional(),
        options: z.array(z.string().max(80)).max(20).optional(),
      }),
    )
    .min(1)
    .max(20);
  const validFields = fieldSchema.safeParse(fields);
  if (!validFields.success)
    return c.json(
      {
        error: {
          code: 'INVALID_FIELDS',
          message: 'Each field needs a safe name, label, supported type and optional options.',
        },
      },
      422,
    );
  const d = p.data,
    staff = c.get('staff'),
    timestamp = now(),
    formId = d.id ?? id();
  try {
    await c.env.DB.prepare(
      'INSERT INTO managed_forms (id,slug,title,description,fields_json,notification_enabled,status,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET slug=excluded.slug,title=excluded.title,description=excluded.description,fields_json=excluded.fields_json,notification_enabled=excluded.notification_enabled,status=excluded.status,updated_by=excluded.updated_by,updated_at=excluded.updated_at',
    )
      .bind(
        formId,
        d.slug,
        d.title,
        d.description,
        JSON.stringify(validFields.data),
        d.notificationEnabled ? 1 : 0,
        d.status,
        staff.id,
        staff.id,
        timestamp,
        timestamp,
      )
      .run();
  } catch {
    return c.json(
      { error: { code: 'SLUG_CONFLICT', message: 'That slug is already in use.' } },
      409,
    );
  }
  await audit(c, 'managed_form.saved', 'managed_form', formId, { slug: d.slug, status: d.status });
  return c.json({ data: { id: formId, slug: d.slug, status: d.status, url: `/forms/${d.slug}` } });
});

/* ---------------------------------------------------------------- staff session security (super administrators only) */
admin.get('/sessions/ui', requireRole('super_admin'), async (c) =>
  c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Staff sessions · Casinos of Mayfair</title><link rel="stylesheet" href="/static/css/site.css"><link rel="stylesheet" href="/static/css/dashboard.css"></head><body><main class="admin"><p class="eyebrow">SECURITY OPERATIONS</p><h1>Staff sessions</h1><nav class="admin-nav"><a href="/dashboard">Overview</a><a href="/dashboard/staff/ui">Staff accounts</a><a href="/dashboard/sessions/ui">Staff sessions</a><a href="/dashboard/buyer-sessions/ui">Buyer sessions</a><a href="/dashboard/audit/ui">Audit log</a><a href="/admin/change-password">Change password</a><a href="/admin/logout">Sign out</a></nav><p class="muted">Review active staff sign-ins and revoke sessions that should no longer have access. Session tokens and cookie values are never displayed. Your current session cannot be revoked here.</p><p id="session-status" role="status" aria-live="polite">Loading sessions…</p><div class="overflow-x-auto"><table><thead><tr><th>Staff member</th><th>Role</th><th>Created (UTC)</th><th>Last activity (UTC)</th><th>Expires (UTC)</th><th>Status</th><th>Action</th></tr></thead><tbody id="session-rows"><tr><td colspan="7">Loading…</td></tr></tbody></table></div></main><script src="/static/js/dashboard-sessions.js" defer></script></body></html>`),
);

admin.get('/sessions', requireRole('super_admin'), async (c) => {
  const token = readCookie(c.req.header('cookie'), STAFF_COOKIE);
  const currentHash = token ? await sha256Hex(token) : '';
  const result = await c.env.DB.prepare(
    "SELECT s.id, s.user_id AS userId, s.created_at AS createdAt, s.last_seen_at AS lastSeenAt, s.expires_at AS expiresAt, u.email, u.display_name AS displayName, u.role, CASE WHEN s.token_hash = ? THEN 1 ELSE 0 END AS isCurrent FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.session_type = 'staff' AND s.revoked_at IS NULL AND s.expires_at > ? AND u.user_type = 'staff' AND u.status = 'active' ORDER BY s.last_seen_at DESC, s.id LIMIT 500",
  ).bind(currentHash, now()).all();
  c.header('Cache-Control', 'private, no-store');
  return c.json({ data: (result.results ?? []).map((row) => ({
    id: row['id'], userId: row['userId'], email: row['email'], displayName: row['displayName'], role: row['role'],
    createdAt: row['createdAt'], lastSeenAt: row['lastSeenAt'], expiresAt: row['expiresAt'], isCurrent: row['isCurrent'] === 1,
  })) });
});

admin.post('/sessions/:id/revoke', requireRole('super_admin'), async (c) => {
  const sessionId = c.req.param('id');
  if (!/^[0-9a-f-]{36}$/i.test(sessionId))
    return c.json({ error: { code: 'INVALID_SESSION_ID', message: 'Invalid session ID.' } }, 422);
  const token = readCookie(c.req.header('cookie'), STAFF_COOKIE);
  const currentHash = token ? await sha256Hex(token) : '';
  const session = await c.env.DB.prepare(
    "SELECT s.id, s.user_id AS userId, s.token_hash AS tokenHash, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.session_type = 'staff' AND s.revoked_at IS NULL AND u.user_type = 'staff'",
  ).bind(sessionId).first<{ id: string; userId: string; tokenHash: string; email: string }>();
  if (!session)
    return c.json({ error: { code: 'SESSION_NOT_FOUND', message: 'Active staff session not found.' } }, 404);
  if (session.tokenHash === currentHash)
    return c.json({ error: { code: 'CURRENT_SESSION_PROTECTED', message: 'Your current session cannot be revoked from this page. Sign out normally instead.' } }, 409);
  const timestamp = now();
  const changed = await c.env.DB.prepare(
    "UPDATE sessions SET revoked_at = ? WHERE id = ? AND session_type = 'staff' AND revoked_at IS NULL",
  ).bind(timestamp, session.id).run();
  if ((changed.meta?.changes ?? 0) !== 1)
    return c.json({ error: { code: 'SESSION_ALREADY_REVOKED', message: 'This session is no longer active.' } }, 409);
  await audit(c, 'staff.session_revoked', 'session', session.id, { targetUserId: session.userId, targetEmail: session.email });
  c.header('Cache-Control', 'private, no-store');
  return c.json({ data: { id: session.id, revoked: true } });
});

/* ---------------------------------------------------------------- buyer session security (super administrators only) */
admin.get('/buyer-sessions/ui', requireRole('super_admin'), async (c) =>
  c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Buyer sessions · Casinos of Mayfair</title><link rel="stylesheet" href="/static/css/site.css"><link rel="stylesheet" href="/static/css/dashboard.css"></head><body><main class="admin"><p class="eyebrow">SECURITY OPERATIONS</p><h1>Buyer sessions</h1><nav class="admin-nav"><a href="/dashboard">Overview</a><a href="/dashboard/buyers/ui">Buyer access</a><a href="/dashboard/sessions/ui">Staff sessions</a><a href="/dashboard/audit/ui">Audit log</a><a href="/admin/logout">Sign out</a></nav><p class="muted">Review active buyer sign-ins and revoke sessions when a buyer reports a lost device or suspicious activity. This page never displays session tokens. Revocation ends the selected session; it does not suspend the buyer account or change data-room grants.</p><p id="buyer-session-status" role="status" aria-live="polite">Loading sessions…</p><div class="overflow-x-auto"><table><thead><tr><th>Buyer</th><th>Account status</th><th>Created (UTC)</th><th>Last activity (UTC)</th><th>Expires (UTC)</th><th>Action</th></tr></thead><tbody id="buyer-session-rows"><tr><td colspan="6">Loading…</td></tr></tbody></table></div></main><script src="/static/js/dashboard-buyer-sessions.js" defer></script></body></html>`),
);

admin.get('/buyer-sessions', requireRole('super_admin'), async (c) => {
  const result = await c.env.DB.prepare(
    "SELECT s.id, s.user_id AS userId, s.created_at AS createdAt, s.last_seen_at AS lastSeenAt, s.expires_at AS expiresAt, u.email, u.display_name AS displayName, u.status AS accountStatus FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.session_type = 'buyer' AND s.revoked_at IS NULL AND s.expires_at > ? AND u.user_type = 'buyer' ORDER BY s.last_seen_at DESC, s.id LIMIT 500",
  ).bind(now()).all();
  c.header('Cache-Control', 'private, no-store');
  return c.json({ data: (result.results ?? []).map((row) => ({
    id: row['id'], userId: row['userId'], email: row['email'], displayName: row['displayName'],
    accountStatus: row['accountStatus'], createdAt: row['createdAt'], lastSeenAt: row['lastSeenAt'], expiresAt: row['expiresAt'],
  })) });
});

admin.post('/buyer-sessions/:id/revoke', requireRole('super_admin'), async (c) => {
  const sessionId = c.req.param('id');
  if (!/^[0-9a-f-]{36}$/i.test(sessionId))
    return c.json({ error: { code: 'INVALID_SESSION_ID', message: 'Invalid session ID.' } }, 422);
  const session = await c.env.DB.prepare(
    "SELECT s.id, s.user_id AS userId, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.session_type = 'buyer' AND s.revoked_at IS NULL AND u.user_type = 'buyer'",
  ).bind(sessionId).first<{ id: string; userId: string; email: string }>();
  if (!session)
    return c.json({ error: { code: 'SESSION_NOT_FOUND', message: 'Active buyer session not found.' } }, 404);
  const timestamp = now();
  const changed = await c.env.DB.prepare(
    "UPDATE sessions SET revoked_at = ? WHERE id = ? AND session_type = 'buyer' AND revoked_at IS NULL",
  ).bind(timestamp, session.id).run();
  if ((changed.meta?.changes ?? 0) !== 1)
    return c.json({ error: { code: 'SESSION_ALREADY_REVOKED', message: 'This session is no longer active.' } }, 409);
  await audit(c, 'buyer.session_revoked', 'session', session.id, { targetUserId: session.userId, targetEmail: session.email });
  c.header('Cache-Control', 'private, no-store');
  return c.json({ data: { id: session.id, revoked: true } });
});

/* ---------------------------------------------------------------- staff accounts (super administrators only) */
const staffRoles = ['super_admin', 'admin', 'editor', 'broker', 'publisher', 'auditor'] as const;

admin.get('/staff/ui', requireRole('super_admin'), async (c) =>
  c.html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Staff accounts · Casinos of Mayfair</title><link rel="stylesheet" href="/static/css/site.css"><link rel="stylesheet" href="/static/css/dashboard.css"></head><body><main class="admin"><p class="eyebrow">STAFF WORKSPACE</p><h1>Staff accounts</h1><nav class="admin-nav"><a href="/dashboard">Overview</a><a href="/dashboard/buyers/ui">Buyer access</a><a href="/dashboard/sessions/ui">Staff sessions</a><a href="/dashboard/audit/ui">Audit log</a></nav><p class="muted">Only super administrators can create staff, edit names and emails, change roles, set temporary passwords or suspend access. A temporary password forces the person to choose a new one at first sign-in.</p><div class="dx-toolbar"><div class="dx-tabs" id="staff-tabs" role="tablist"><button type="button" class="dx-tab" role="tab" data-tab="all" aria-selected="false">All<span class="dx-count">0</span></button><button type="button" class="dx-tab" role="tab" data-tab="active" aria-selected="false">Active<span class="dx-count">0</span></button><button type="button" class="dx-tab" role="tab" data-tab="suspended" aria-selected="false">Suspended<span class="dx-count">0</span></button></div><input class="dx-search" id="staff-search" type="search" placeholder="Search" aria-label="Search"><span class="dx-spacer"></span><button type="button" class="dx-btn dx-btn-primary" id="staff-add">Add staff</button></div><div id="staff-list" class="dx-table-wrap">Loading…</div></main><script src="/static/js/dashboard-kit.js" defer></script><script src="/static/js/dashboard-staff.js" defer></script></body></html>`,
  ),
);

admin.get('/staff', requireRole('super_admin'), async (c) => {
  const result = await c.env.DB.prepare(
    "SELECT id, email, display_name AS displayName, role, status, created_at AS createdAt, CASE WHEN password_hash IS NULL THEN 0 ELSE 1 END AS hasPassword, must_change_password AS mustChange FROM users WHERE user_type = 'staff' ORDER BY created_at LIMIT 300",
  ).all();
  return c.json({
    data: (result.results ?? []).map((r) => ({
      ...r,
      hasPassword: r['hasPassword'] === 1,
      mustChange: r['mustChange'] === 1,
      isSelf: r['id'] === c.get('staff').id,
    })),
  });
});

admin.post('/staff', requireRole('super_admin'), async (c) => {
  const parsed = z
    .object({
      email: z.string().trim().email().max(254),
      displayName: z.string().trim().min(2).max(120),
      role: z.enum(staffRoles),
      temporaryPassword: z.string().max(200).optional(),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'Provide a name, valid email and role.' } },
      422,
    );
  const email = parsed.data.email.toLowerCase();
  if (parsed.data.temporaryPassword) {
    const problem = passwordPolicyError(parsed.data.temporaryPassword, email);
    if (problem) return c.json({ error: { code: 'WEAK_PASSWORD', message: problem } }, 422);
  }
  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE')
    .bind(email)
    .first();
  if (existing)
    return c.json(
      {
        error: { code: 'ACCOUNT_CONFLICT', message: 'An account with that email already exists.' },
      },
      409,
    );
  const timestamp = now();
  const userId = id();
  const hash = parsed.data.temporaryPassword
    ? await hashPassword(parsed.data.temporaryPassword)
    : null;
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO users (id,email,display_name,user_type,role,status,password_hash,password_updated_at,must_change_password,created_at,updated_at) VALUES (?,?,?,'staff',?,'active',?,?,?,?,?)",
    ).bind(
      userId,
      email,
      parsed.data.displayName,
      parsed.data.role,
      hash,
      hash ? timestamp : null,
      hash ? 1 : 0,
      timestamp,
      timestamp,
    ),
  ]);
  await audit(c, 'staff.created', 'user', userId, {
    role: parsed.data.role,
    method: hash ? 'temporary_password' : 'invite',
  });
  const invited = hash
    ? false
    : Boolean(await issueResetToken(c.env, { id: userId, email }, 'invite', 'staff'));
  return c.json({ data: { id: userId, email, role: parsed.data.role, invited } }, 201);
});

admin.patch('/staff/:id', requireRole('super_admin'), async (c) => {
  const parsed = z
    .object({
      role: z.enum(staffRoles).optional(),
      status: z.enum(['active', 'suspended']).optional(),
      displayName: z.string().trim().min(2).max(120).optional(),
      email: z.string().trim().email().max(254).optional(),
    })
    .refine((v) => v.role || v.status || v.displayName || v.email)
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'Check the name, email, role and status.' } },
      422,
    );
  const target = c.req.param('id');
  const isSelf = target === c.get('staff').id;
  if (isSelf && (parsed.data.role || parsed.data.status || parsed.data.email))
    return c.json(
      {
        error: {
          code: 'SELF_CHANGE_BLOCKED',
          message:
            'You can only change your own name here. Ask another super administrator for role, status or email changes.',
        },
      },
      409,
    );
  const user = await c.env.DB.prepare(
    "SELECT id, email, display_name AS displayName, role, status FROM users WHERE id = ? AND user_type = 'staff'",
  )
    .bind(target)
    .first<{ id: string; email: string; displayName: string; role: string; status: string }>();
  if (!user)
    return c.json({ error: { code: 'NOT_FOUND', message: 'Staff account not found.' } }, 404);
  const role = parsed.data.role ?? user.role;
  const status = parsed.data.status ?? user.status;
  const displayName = parsed.data.displayName ?? user.displayName;
  const email = (parsed.data.email ?? user.email).toLowerCase();
  if (email !== user.email.toLowerCase()) {
    const taken = await c.env.DB.prepare(
      'SELECT id FROM users WHERE email = ? COLLATE NOCASE AND id != ?',
    )
      .bind(email, user.id)
      .first();
    if (taken)
      return c.json(
        {
          error: { code: 'ACCOUNT_CONFLICT', message: 'Another account already uses that email.' },
        },
        409,
      );
  }
  const timestamp = now();
  const securityChange =
    status !== user.status || role !== user.role || email !== user.email.toLowerCase();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE users SET role = ?, status = ?, display_name = ?, email = ?, updated_at = ? WHERE id = ? AND user_type = 'staff'",
    ).bind(role, status, displayName, email, timestamp, user.id),
    c.env.DB.prepare(
      'UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND ? = 1',
    ).bind(timestamp, user.id, securityChange ? 1 : 0),
  ]);
  await audit(c, 'staff.updated', 'user', user.id, {
    from: {
      role: user.role,
      status: user.status,
      email: user.email,
      displayName: user.displayName,
    },
    to: { role, status, email, displayName },
  });
  return c.json({ data: { id: user.id, role, status, displayName, email } });
});

admin.post('/staff/:id/temporary-password', requireRole('super_admin'), async (c) => {
  const body = z
    .object({ password: z.string().max(200).optional() })
    .safeParse(await c.req.json().catch(() => ({})));
  if (!body.success)
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid password.' } }, 422);
  if (c.req.param('id') === c.get('staff').id)
    return c.json(
      {
        error: {
          code: 'SELF_CHANGE_BLOCKED',
          message: 'Use Change password to update your own password.',
        },
      },
      409,
    );
  const user = await c.env.DB.prepare(
    "SELECT id, email FROM users WHERE id = ? AND user_type = 'staff'",
  )
    .bind(c.req.param('id'))
    .first<{ id: string; email: string }>();
  if (!user)
    return c.json({ error: { code: 'NOT_FOUND', message: 'Staff account not found.' } }, 404);
  const result = await issueTemporaryPassword(c, user, 'staff', body.data.password || undefined);
  if ('problem' in result)
    return c.json({ error: { code: 'WEAK_PASSWORD', message: result.problem } }, 422);
  c.header('Cache-Control', 'no-store');
  return c.json({ data: { email: user.email, temporaryPassword: result.password } });
});

admin.post('/staff/:id/reset-password', requireRole('super_admin'), async (c) => {
  const user = await c.env.DB.prepare(
    "SELECT id, email FROM users WHERE id = ? AND user_type = 'staff' AND status = 'active'",
  )
    .bind(c.req.param('id'))
    .first<{ id: string; email: string }>();
  if (!user)
    return c.json(
      { error: { code: 'NOT_FOUND', message: 'Active staff account not found.' } },
      404,
    );
  const emailQueued = Boolean(await issueResetToken(c.env, user, 'reset', 'staff'));
  await audit(c, 'staff.password_reset_issued', 'user', user.id, { emailQueued });
  return c.json({ data: { emailQueued } });
});

export default admin;
