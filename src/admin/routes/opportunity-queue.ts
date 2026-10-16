import { requireRole } from '../../auth/staff-session';
import { z } from 'zod';
import { slugify } from '../../domain/opportunities/slug';
import {
  buildReconciliationSql,
  DUPLICATE_LEGACY_ID_SQL,
  DUPLICATE_SLUG_SQL,
  RECONCILIATION_CHECKS,
  RECONCILIATION_GROUPINGS,
} from '../../domain/opportunities/reconciliation';
import { transitionMatrix } from '../../domain/opportunities/lifecycle';
import { Hono } from 'hono';
import {
  type AdminApp,
  audit,
  csvCell,
  editorRoles,
  id,
  now,
  publisherRoles,
  purgeOpportunityPublicCache,
  STAGE_SQL,
} from '../shared';

const admin = new Hono<AdminApp>();

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

const OPPORTUNITY_STAGES = ['live', 'ready', 'review', 'draft', 'closed'];

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

export default admin;
