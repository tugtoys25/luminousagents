import { requireRole } from '../../auth/staff-session';
import { isSafeSvg, MAX_SVG_BYTES } from '../../security/svg-sanitizer';
import { z } from 'zod';
import { Hono } from 'hono';
import { deleteMedia, findMedia, findMediaFile, findMediaForDelete, findPathReferences, insertMedia, listMedia, slugTaken, updateMedia } from '../repos/media-repo';
import { type AdminApp, audit, id, mediaSignatureMatches, now } from '../shared';

const admin = new Hono<AdminApp>();

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

admin.get('/media/ui', requireRole('admin', 'editor', 'publisher', 'super_admin'), (c) => c.html(
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Media library · Casinos of Mayfair</title><link rel="stylesheet" href="/static/css/site.css"><link rel="stylesheet" href="/static/css/dashboard.css"><link rel="stylesheet" href="/static/css/dashboard-media.css"></head><body><main class="admin"><p class="eyebrow">STAFF WORKSPACE</p><h1>Media library</h1><nav class="admin-nav"><a href="/dashboard">Overview</a><a href="/dashboard/opportunities/ui">Opportunities</a><a href="/dashboard/media/ui" aria-current="page">Media library</a><a href="/dashboard/settings/ui">Settings</a><a href="/dashboard/pages/ui">Pages</a><a href="/admin/logout">Sign out</a></nav><p class="muted">Manage images and documents in one place. Public files are available to website pages; private files remain staff-only. Changing a file to public should only be done when you have rights to publish it and it contains no confidential information.</p><section class="ml-toolbar"><input id="ml-search" type="search" placeholder="Search filenames, captions or alt text" aria-label="Search media"><select id="ml-kind" aria-label="File type"><option value="all">All file types</option><option value="image">Images</option><option value="document">Documents</option></select><select id="ml-visibility" aria-label="Visibility"><option value="">All visibility</option><option value="public">Public</option><option value="private">Private</option></select><button id="ml-refresh" type="button">Refresh</button><label class="ml-upload">Upload files<input id="ml-upload" type="file" multiple accept="image/jpeg,image/png,image/webp,image/gif,image/svg+xml,image/x-icon,.svg,.ico,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"></label></section><p id="ml-notice" role="status" aria-live="polite"></p><section id="ml-grid" class="ml-grid" aria-live="polite"><p>Loading media…</p></section><dialog id="ml-edit" class="ml-edit"><form id="ml-edit-form" method="dialog"><h2>Edit media details</h2><input type="hidden" name="id"><label>Filename<input name="filename" maxlength="180" required></label><label>Alternative text (images)<input name="altText" maxlength="240"></label><label>Caption / notes<textarea name="caption" maxlength="500"></textarea></label><label>Folder<input name="folder" maxlength="80" pattern="[a-zA-Z0-9 _-]+" required></label><label>Custom public URL slug (optional)<input name="publicSlug" maxlength="100" pattern="[a-zA-Z0-9-]+" placeholder="e.g. london-casino-exterior"></label><label>Visibility<select name="visibility"><option value="private">Private — staff only</option><option value="public">Public — website accessible</option></select></label><p class="muted">Public URLs can be embedded in public pages. Do not publish confidential deal-room documents.</p><div class="ml-actions"><button type="button" id="ml-edit-cancel">Cancel</button><button type="submit">Save changes</button></div></form></dialog></main><script src="/static/js/dashboard-media.js" defer></script></body></html>`
));

admin.get('/media', requireRole('admin', 'editor', 'publisher', 'super_admin'), async (c) => {
  const q = (c.req.query('q') || '').trim().slice(0, 100).toLowerCase();
  const kind = c.req.query('type') || 'all';
  const visibility = c.req.query('visibility') || '';
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') || 60)));
  const rows = await listMedia(c.env.DB, { q, kind, visibility, limit });
  return c.json({ data: rows.map((row) => ({ ...row, url: (row as { visibility: string }).visibility === 'public' ? `/media/${encodeURIComponent(String((row as { publicSlug?: string | null }).publicSlug || (row as { id: string }).id))}` : null })) });
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
      await insertMedia(c.env.DB, { id: mediaId, r2Key: key, filename: safeName, contentType: type, byteSize: file.size, sha256, visibility, uploadedBy: c.get('staff').id, timestamp });
      await audit(c, 'media.uploaded', 'media_asset', mediaId, { contentType: type, byteSize: file.size, sha256 });
    } catch (error) { await c.env.PRIVATE_FILES.delete(key); throw error; }
    uploaded.push({ id: mediaId, filename: safeName, contentType: type, byteSize: file.size, visibility, url: visibility === 'public' ? `/media/${encodeURIComponent(mediaId)}` : null, createdAt: timestamp });
  }
  return c.json({ data: uploaded }, 201);
});

admin.patch('/media/:id', requireRole('admin', 'editor', 'publisher', 'super_admin'), async (c) => {
  const parsed = z.object({ filename: z.string().trim().min(1).max(180).optional(), altText: z.string().trim().max(240).optional(), caption: z.string().trim().max(500).optional(), folder: z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9 _-]+$/).optional(), publicSlug: z.string().trim().max(100).regex(/^[a-zA-Z0-9-]+$/).optional().or(z.literal('')), visibility: z.enum(['public', 'private']).optional() }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid media details.' } }, 422);
  const existing = await findMedia(c.env.DB, c.req.param('id'));
  if (!existing) return c.json({ error: { code: 'NOT_FOUND', message: 'Media item not found.' } }, 404);
  const patch = parsed.data;
  if (patch.publicSlug) {
    if (await slugTaken(c.env.DB, patch.publicSlug, existing.id)) return c.json({ error: { code: 'SLUG_CONFLICT', message: 'That public URL slug is already in use.' } }, 409);
  }
  if (patch.publicSlug !== undefined && patch.publicSlug !== (existing.publicSlug ?? '') && existing.publicSlug) {
    const oldPath = `/media/${existing.publicSlug}`;
    const found = await findPathReferences(c.env.DB, oldPath);
    const refs = [
      ...found.settings.map((name) => `setting:${name}`),
      ...found.pages.map((name) => `page:${name}`),
      ...found.forms.map((name) => `form:${name}`),
      ...found.opportunities.map((name) => `opportunity:${name}`),
    ];
    if (refs.length) return c.json({ error: { code: 'MEDIA_URL_IN_USE', message: 'This URL slug is referenced by managed content. Update those references before changing the slug.', references: refs.slice(0, 30) } }, 409);
  }
  if (patch.visibility === 'public' && existing.visibility !== 'public' && c.get('staff').role !== 'admin' && c.get('staff').role !== 'super_admin') return c.json({ error: { code: 'FORBIDDEN', message: 'Only administrators can publish media.' } }, 403);
  if (patch.visibility === 'public' && existing.visibility !== 'public' && !existing.contentType.startsWith('image/') && c.get('staff').role !== 'super_admin') return c.json({ error: { code: 'FORBIDDEN', message: 'Only a super administrator can publish document files. Review confidentiality and rights first.' } }, 403);
  if (!(await updateMedia(c.env.DB, existing.id, patch, now()))) return c.json({ data: { id: existing.id } });
  await audit(c, patch.visibility && patch.visibility !== existing.visibility ? 'media.visibility_changed' : 'media.updated', 'media_asset', existing.id, { fields: Object.keys(patch), previousVisibility: existing.visibility, visibility: patch.visibility ?? existing.visibility, publicSlug: patch.publicSlug ?? existing.publicSlug });
  return c.json({ data: { id: existing.id, ...patch, url: (patch.visibility || existing.visibility) === 'public' ? `/media/${encodeURIComponent((patch.publicSlug === undefined ? existing.publicSlug : patch.publicSlug) || existing.id)}` : null } });
});

admin.get('/media/:id/download', requireRole('admin', 'editor', 'publisher', 'super_admin'), async (c) => {
  const asset = await findMediaFile(c.env.DB, c.req.param('id'));
  if (!asset) return c.json({ error: { code: 'NOT_FOUND', message: 'Media item not found.' } }, 404);
  const object = await c.env.PRIVATE_FILES.get(asset.r2Key);
  if (!object) return c.json({ error: { code: 'NOT_FOUND', message: 'Stored file not found.' } }, 404);
  const headers = new Headers(); headers.set('Content-Type', asset.contentType); headers.set('Content-Disposition', `attachment; filename="${asset.filename.replace(/["\\\r\n]/g, '_')}"`); headers.set('Cache-Control', 'private, no-store'); headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(object.body, { headers });
});

admin.delete('/media/:id', requireRole('admin', 'super_admin'), async (c) => {
  const asset = await findMediaForDelete(c.env.DB, c.req.param('id'));
  if (!asset) return c.json({ error: { code: 'NOT_FOUND', message: 'Media item not found.' } }, 404);
  const publicPaths = [`/media/${asset.id}`, ...(asset.publicSlug ? [`/media/${asset.publicSlug}`] : [])];
  const references: { type: string; name: string }[] = [];
  for (const path of publicPaths) {
    const found = await findPathReferences(c.env.DB, path);
    for (const name of found.settings) references.push({ type: 'platform setting', name });
    for (const name of found.pages) references.push({ type: 'managed page', name });
    for (const name of found.forms) references.push({ type: 'managed form', name });
    for (const name of found.opportunities) references.push({ type: 'opportunity', name });
  }
  const uniqueReferences = references.filter((reference, index, all) => all.findIndex((other) => other.type === reference.type && other.name === reference.name) === index);
  if (uniqueReferences.length) {
    return c.json({ error: { code: 'MEDIA_IN_USE', message: 'This media is referenced by managed content. Replace or unlink those references before deleting it.', references: uniqueReferences.slice(0, 30) } }, 409);
  }
  await deleteMedia(c.env.DB, asset.id);
  await c.env.PRIVATE_FILES.delete(asset.r2Key);
  await audit(c, 'media.deleted', 'media_asset', asset.id, { filename: asset.filename });
  return c.json({ data: { id: asset.id, deleted: true } });
});

export default admin;
