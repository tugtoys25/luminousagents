import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import type { Env } from '../env';
import { staffAuth, requireRole, type StaffIdentity } from '../auth/staff-session';
import { hashPassword, issueResetToken, passwordPolicyError } from '../auth/password';
import { slugify } from '../domain/opportunities/slug';
import { scanR2Document, ScannerError } from '../security/malware-scanner';
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
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Staff dashboard · Casinos of Mayfair</title><link rel="stylesheet" href="/static/css/site.css"><link rel="stylesheet" href="/static/css/dashboard.css"></head><body><main class="admin"><p class="eyebrow">STAFF WORKSPACE</p><h1>Platform dashboard</h1><p class="muted">Signed in as ${escape(staff.displayName || staff.email)} · ${escape(staff.role)}</p><nav class="admin-nav"><a href="/dashboard">Overview</a><a href="/dashboard/opportunities/ui">Opportunity CMS</a><a href="/dashboard/buyers/ui">Buyer access</a><a href="/dashboard/enquiries/ui">Enquiries</a><a href="/dashboard/tasks/ui">Tasks</a><a href="/dashboard/notifications/ui">Notifications</a><a href="/dashboard/nda-requests/ui">NDA requests</a><a href="/dashboard/access-grants/ui">Access grants</a><a href="/dashboard/nda-templates/ui">NDA templates</a><a href="/dashboard/audit">Audit log</a>${staff.role === 'super_admin' ? '<a href="/dashboard/staff/ui">Staff accounts</a>' : ''}<a href="/dashboard/settings/ui">Platform settings</a><a href="/dashboard/pages/ui">Pages</a><a href="/dashboard/forms/ui">Forms</a><a href="/admin/change-password">Change password</a><a href="/">View public site</a><a href="/admin/logout">Sign out</a></nav><section class="metric-grid" aria-label="Key numbers"><a class="metric" href="/dashboard/opportunities/ui"><span class="muted">Total records</span><strong>${counts?.total ?? 0}</strong><small>Opportunities you can access</small></a><a class="metric" href="/dashboard/opportunities/ui" data-tone="${(counts?.pending ?? 0) > 0 ? 'warn' : 'ok'}"><span class="muted">Awaiting review</span><strong>${counts?.pending ?? 0}</strong><small>${(counts?.pending ?? 0) > 0 ? 'Content waiting for a decision' : 'Nothing waiting'}</small></a><a class="metric" href="/dashboard/opportunities/ui" data-tone="ok"><span class="muted">Published &amp; approved</span><strong>${counts?.published ?? 0}</strong><small>Visible on the public site</small></a></section><h2>Quick actions</h2><section class="quick-grid" aria-label="Quick actions"><a class="quick-card" href="/dashboard/opportunities/ui"><strong>Opportunity CMS</strong><span>Create, edit, review and publish listings.</span></a><a class="quick-card" href="/dashboard/nda-requests/ui"><strong>NDA requests</strong><span>Review requests and grant time-limited access.</span></a><a class="quick-card" href="/dashboard/buyers/ui"><strong>Buyer access</strong><span>Approve registrations and manage accounts.</span></a><a class="quick-card" href="/dashboard/tasks/ui"><strong>Tasks</strong><span>Assign and track operational follow-ups.</span></a><a class="quick-card" href="/dashboard/pages/ui"><strong>Pages</strong><span>Write and publish SEO-friendly content pages.</span></a><a class="quick-card" href="/dashboard/settings/ui"><strong>Platform settings</strong><span>Branding, contact channels and navigation.</span></a></section><div class="dash-cols"><section class="ws-card"><h2>Needs content review</h2>${pendingRows ? `<ul class="review-list">${pendingRows}</ul>` : '<p class="empty-state">No records awaiting review.</p>'}</section><section><h2>Recently updated opportunities</h2><div class="overflow-x-auto"><table><thead><tr><th>Title</th><th>Country</th><th>Lifecycle</th><th>Review</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="5">No records yet.</td></tr>'}</tbody></table></div></section></div></main></body></html>`,
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
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Opportunity CMS · Casinos of Mayfair</title><link rel="stylesheet" href="/static/css/site.css"><link rel="stylesheet" href="/static/css/dashboard.css"></head><body><main class="admin"><p class="eyebrow">STAFF WORKSPACE</p><h1>Opportunity CMS</h1><nav class="admin-nav"><a href="/dashboard">Overview</a><a href="/dashboard/opportunities/ui">Opportunity CMS</a><a href="/dashboard/buyers/ui">Buyer access</a><a href="/dashboard/nda-requests/ui">NDA requests</a><a href="/dashboard/access-grants/ui">Access grants</a><a href="/admin/logout">Sign out</a></nav><p class="muted">All legacy records start private. Approval and publication are separate actions.</p><div class="cms-layout"><aside class="cms-list-panel" aria-label="Opportunities"><div class="cms-filters"><label class="span-all">Search <input id="cms-search" type="search" maxlength="100" placeholder="Title, country or label"></label><label>Review <select id="cms-review"><option value="pending">Pending</option><option value="approved">Approved</option><option value="rejected">Rejected</option><option value="">All</option></select></label><span></span><button id="cms-refresh" type="button">Refresh</button></div><ul id="cms-list" class="cms-list" aria-live="polite">Loading…</ul></aside><div class="cms-editor-col"><form id="cms-form" class="flow" data-flow data-serp-path="/opportunities/your-listing"><div class="flow-bar"><h2 id="cms-form-title">Create opportunity</h2><span class="flow-badges" id="cms-flow-badges"></span><span class="flow-state" aria-live="polite">All changes saved</span><button id="cms-new" type="button">New</button><button type="submit">Save draft</button></div><input type="hidden" name="id"><fieldset class="flow-card"><legend data-step="1">The opportunity</legend><div class="flow-grid"><label class="span-2">Title <input name="title" minlength="3" maxlength="180" required></label><label>Country <input name="country" maxlength="100"></label><label>Type <select name="opportunityType"><option value="casino-hotel">Casino &amp; hotel</option><option value="casino">Casino</option><option value="hotel">Hotel</option><option value="resort">Resort</option><option value="gaming-venue">Gaming venue</option><option value="other">Other</option></select></label><label>Classification <select name="classification"><option value="confidential">Confidential</option><option value="public">Public (requires review)</option><option value="off_market">Off market</option><option value="sold">Sold</option><option value="under_offer">Under offer</option><option value="on_hold">On hold</option></select></label><label>Assigned broker <select name="assignedBrokerId"><option value="">Unassigned</option></select></label><label>Price text <input name="priceText" maxlength="180"></label><label>Availability <input name="availability" maxlength="300"></label></div></fieldset><fieldset class="flow-card"><legend data-step="2">Summary and detail</legend><div class="flow-grid"><label class="span-2">Summary <textarea name="summary" maxlength="1000"></textarea></label><label class="span-2">Labels, comma separated <input name="labels" maxlength="400" placeholder="Premium, Freehold, Resort"></label><label class="span-2">Body HTML (staff-only editing; sanitisation review required) <textarea name="bodyHtml" maxlength="20000"></textarea></label></div></fieldset><fieldset class="flow-card"><legend data-step="3">Search appearance</legend><p class="muted">How this listing can appear in search results. Leave blank to use the title and summary.</p><div class="flow-grid"><label class="span-2">SEO title <input name="seoTitle" maxlength="180"></label><label class="span-2">SEO description <textarea name="seoDescription" maxlength="320"></textarea></label></div></fieldset></form><section id="cms-review-actions" class="ws-card" hidden><h3>Review &amp; publication</h3><p class="muted">Approval and publication are separate decisions. Both are audited and need a reason.</p><label>Reason <textarea id="cms-reason" minlength="3" maxlength="500"></textarea></label><div class="btn-row"><button id="cms-approve" type="button">Approve content</button><button id="cms-reject" type="button">Reject content</button></div><label><input id="cms-publish" type="checkbox"> Make public after approval (only after authority, accuracy and rights checks)</label><div class="btn-row"><button id="cms-publish-button" type="button">Publish approved record</button></div></section><section id="cms-media-panel" class="ws-card" hidden><h3>Listing images</h3><p class="muted">JPG or PNG up to 8 MiB. Images stay private until the listing is approved, published and classified public.</p><form id="cms-media-form" class="flow-grid"><label>Cover image <input type="file" name="file" accept="image/jpeg,image/png" required></label><label>Alternative text <input name="altText" maxlength="240" required></label><div class="span-2"><button type="submit">Upload image</button></div></form><ul id="cms-media-list" class="media-list"></ul></section><p id="cms-notice" role="status" aria-live="polite"></p></div></div></main><script src="/static/js/dashboard-opportunities.js" defer></script></body></html>`,
    ),
);

admin.get('/opportunities', async (c) => {
  const q = c.req.query('q')?.trim().slice(0, 100) ?? '';
  const status = c.req.query('review') ?? '';
  const validStatus = ['pending', 'approved', 'rejected'].includes(status) ? status : '';
  const staff = c.get('staff');
  const brokerOnly = staff.role === 'broker' ? 1 : 0;
  const result = await c.env.DB.prepare(
    `SELECT id, title, country, lifecycle, content_review_status AS reviewStatus, public_visibility AS publicVisibility, assigned_broker_id AS assignedBrokerId, updated_at AS updatedAt FROM opportunities WHERE (? = '' OR title LIKE ? OR country LIKE ?) AND (? = '' OR content_review_status = ?) AND (? = 0 OR assigned_broker_id = ?) ORDER BY updated_at DESC LIMIT 100`,
  )
    .bind(q, `%${q}%`, `%${q}%`, validStatus, validStatus, brokerOnly, staff.id)
    .all();
  return c.json({ data: result.results ?? [], limit: 100 });
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
    "INSERT INTO opportunities (id, slug, title, country, opportunity_type, classification, labels_json, price_text, lifecycle, content_review_status, summary, body_html, availability, public_visibility, seo_title, seo_description, assigned_broker_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', 'pending', ?, ?, ?, 0, ?, ?, ?, ?, ?)",
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

admin.get('/opportunities/:id', async (c) => {
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
    summary: 'summary',
    bodyHtml: 'body_html',
    availability: 'availability',
    seoTitle: 'seo_title',
    seoDescription: 'seo_description',
    assignedBrokerId: 'assigned_broker_id',
  };
  const sets = Object.entries(input).map(([key]) => `${mapping[key]} = ?`);
  const values = Object.entries(input).map(([key, value]) =>
    key === 'labels' ? JSON.stringify(value) : value,
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
    lifecycle,
    publicVisibility,
    changeReason,
    cachePurge,
  });
  return c.json({ data: { id: existing.id, lifecycle, publicVisibility, cachePurge } });
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
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Buyer access · Casinos of Mayfair</title><link rel="stylesheet" href="/static/css/site.css"><link rel="stylesheet" href="/static/css/dashboard.css"></head><body><main class="admin"><p class="eyebrow">STAFF WORKSPACE</p><h1>Buyer registrations</h1><nav class="admin-nav"><a href="/dashboard">Overview</a><a href="/dashboard/opportunities/ui">Opportunity CMS</a><a href="/dashboard/nda-requests/ui">NDA requests</a><a href="/dashboard/access-grants/ui">Access grants</a><a href="/dashboard/buyers/ui">Buyer access</a><a href="/admin/logout">Sign out</a></nav><p class="muted">New registrations remain invited until an administrator approves them. Activating an account allows email and password sign-in but does not grant confidential data-room access.</p><p id="notice" role="status"></p><section id="buyers">Loading registrations…</section></main><script src="/static/js/dashboard-buyers.js" defer></script></body></html>`,
  ),
);

admin.get('/buyers', requireRole('admin', 'super_admin'), async (c) => {
  const result = await c.env.DB.prepare(
    "SELECT u.id, u.email, u.display_name AS displayName, u.status, u.created_at AS createdAt, p.company_name AS companyName, p.role_title AS roleTitle FROM users u LEFT JOIN buyer_profiles p ON p.user_id = u.id WHERE u.user_type = 'buyer' ORDER BY CASE u.status WHEN 'invited' THEN 0 WHEN 'active' THEN 1 ELSE 2 END, u.created_at DESC LIMIT 300",
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
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NDA review · Casinos of Mayfair</title><link rel="stylesheet" href="/static/css/site.css"><link rel="stylesheet" href="/static/css/dashboard.css"></head><body><main class="admin"><p class="eyebrow">STAFF WORKSPACE</p><h1>NDA request review</h1><nav class="admin-nav"><a href="/dashboard">Overview</a><a href="/dashboard/tasks/ui">Tasks</a><a href="/dashboard/notifications/ui">Notifications</a><a href="/dashboard/audit">Audit log</a><a href="/admin/logout">Sign out</a></nav><p class="muted">Review requests and record a reason. Approval grants time-limited data-room access; it is not a legal opinion or an electronic signature.</p><label>Filter <select id="status-filter"><option value="pending">Pending</option><option value="approved">Approved</option><option value="rejected">Rejected</option><option value="revoked">Revoked</option><option value="">All statuses</option></select></label><p id="notice" role="status"></p><section id="requests" aria-live="polite">Loading requests…</section></main><script src="/static/js/dashboard-nda.js" defer></script></body></html>`,
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
      "SELECT n.id, n.status, n.acceptance_name AS acceptanceName, n.accepted_at AS acceptedAt, n.review_reason AS reviewReason, n.created_at AS createdAt, u.email AS buyerEmail, u.display_name AS buyerName, o.title AS opportunityTitle FROM nda_requests n JOIN users u ON u.id = n.user_id JOIN opportunities o ON o.id = n.opportunity_id WHERE (? = '' OR n.status = ?) AND (? = 0 OR o.assigned_broker_id = ?) ORDER BY n.created_at DESC LIMIT 100",
    )
      .bind(valid, valid, brokerOnly, staff.id)
      .all();
    return c.json({ data: result.results ?? [] });
  },
);

admin.patch(
  '/nda-requests/:id/review',
  requireRole('admin', 'publisher', 'super_admin'),
  async (c) => {
    const parsed = z
      .object({
        decision: z.enum(['approved', 'rejected']),
        reason: z.string().trim().min(3).max(1000),
        accessDays: z.number().int().min(1).max(90).default(30),
        tier: z.union([z.literal(1), z.literal(2)]).default(2),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'Provide a decision and review reason.' } },
        422,
      );
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
      ![1, 2].includes(tier)
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
    try {
      await c.env.DB.batch([
        c.env.DB.prepare(
          "INSERT INTO documents (id, opportunity_id, r2_key, filename, content_type, byte_size, tier, uploaded_by, created_at, sha256, scan_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')",
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
          scanStatus: 'pending',
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
            message: 'Choose a JPG or PNG up to 8 MiB and provide descriptive alternative text.',
          },
        },
        422,
      );

    const contentType = upload.type;
    const bytes = new Uint8Array(await upload.arrayBuffer());
    const jpeg =
      contentType === 'image/jpeg' &&
      bytes.length >= 3 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff;
    const png =
      contentType === 'image/png' &&
      bytes.length >= 8 &&
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
        (value, index) => bytes[index] === value,
      );
    if (!jpeg && !png)
      return c.json(
        {
          error: {
            code: 'INVALID_FILE_SIGNATURE',
            message: 'Image bytes do not match JPEG or PNG.',
          },
        },
        415,
      );

    const hash = await crypto.subtle.digest('SHA-256', bytes);
    const sha256 = [...new Uint8Array(hash)]
      .map((value) => value.toString(16).padStart(2, '0'))
      .join('');
    const mediaId = id();
    const key = `opportunities/${opportunityId}/media/${mediaId}.${jpeg ? 'jpg' : 'png'}`;
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
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Staff tasks · Casinos of Mayfair</title><link rel="stylesheet" href="/static/css/site.css"><link rel="stylesheet" href="/static/css/dashboard.css"></head><body><main class="admin"><p class="eyebrow">STAFF WORKSPACE</p><h1>Task management</h1><nav class="admin-nav"><a href="/dashboard">Overview</a><a href="/dashboard/opportunities/ui">Opportunity CMS</a><a href="/dashboard/buyers/ui">Buyer access</a><a href="/dashboard/enquiries/ui">Enquiries</a><a href="/dashboard/nda-requests/ui">NDA requests</a><a href="/dashboard/notifications/ui">Notifications</a><a href="/dashboard/audit">Audit log</a><a href="/admin/logout">Sign out</a></nav><p class="muted">Create and assign operational follow-ups. Avoid putting sensitive buyer or deal information in task descriptions.</p><form id="task-create" class="task-form"><label>Task title<input name="title" minlength="3" maxlength="180" required></label><label>Priority<select name="priority"><option value="normal">Normal</option><option value="low">Low</option><option value="high">High</option><option value="urgent">Urgent</option></select></label><label>Due date<input name="dueAt" type="datetime-local"></label><label>Assignee user ID (optional)<input name="assignedTo" placeholder="Staff user UUID"></label><label class="full-row">Description<textarea name="description" maxlength="4000"></textarea></label><button type="submit">Create task</button></form><p id="task-notice" class="notice" role="status"></p><section id="task-list" class="task-list" aria-live="polite"><p>Loading tasks…</p></section></main><script src="/static/js/dashboard-tasks.js" defer></script></body></html>`,
    );
  },
);

admin.get('/notifications/ui', requireRole('admin', 'auditor', 'super_admin'), async (c) => {
  return c.html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Notification operations · Casinos of Mayfair</title><link rel="stylesheet" href="/static/css/site.css"><link rel="stylesheet" href="/static/css/dashboard.css"></head><body><main class="admin"><p class="eyebrow">STAFF WORKSPACE</p><h1>Notification operations</h1><nav class="admin-nav"><a href="/dashboard">Overview</a><a href="/dashboard/tasks/ui">Tasks</a><a href="/dashboard/notifications/jobs">Notification job API</a><a href="/dashboard/audit">Audit log</a><a href="/admin/logout">Sign out</a></nav><p class="muted">Delivery status only. Payloads and one-time sign-in codes are never exposed here.</p><p id="notice" role="status"></p><section id="jobs">Loading notification jobs…</section></main><script src="/static/js/dashboard-notifications.js" defer></script></body></html>`,
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

admin.get('/audit', requireRole('admin', 'auditor', 'super_admin'), async (c) => {
  const result = await c.env.DB.prepare(
    'SELECT a.id, a.action, a.entity_type AS entityType, a.entity_id AS entityId, a.details_json AS details, a.created_at AS createdAt, u.email AS actorEmail FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id ORDER BY a.created_at DESC LIMIT 200',
  ).all();
  return c.json({ data: result.results ?? [], limit: 200 });
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
        'ga4_id',
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
      'JSON arrays of objects. Invalid JSON is flagged before you save.',
      ['header_navigation', 'footer_navigation', 'homepage_sections', 'geo_sections'],
    ],
  ];
  const selectFields: Record<string, Array<[string, string]>> = {
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
    cookie_banner_enabled: 'on',
    cookie_banner_position: 'bottom-left',
  };
  const placeholders: Record<string, string> = {
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
      structured || ['site_description', 'whatsapp_message', 'cookie_banner_text'].includes(key);
    const placeholder = placeholders[key] ? ` placeholder="${escapeHtml(placeholders[key])}"` : '';
    return `<label class="setting-field"${longText ? ' data-wide' : ''}><span>${label}</span><textarea name="${key}" rows="${structured ? 6 : key === 'cookie_banner_text' ? 4 : 2}"${placeholder}>${escapeHtml(rendered)}</textarea></label>`;
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
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Platform settings</title><link rel="stylesheet" href="/static/css/site.css"><link rel="stylesheet" href="/static/css/dashboard.css"></head><body><main class="admin"><p class="eyebrow">STAFF WORKSPACE</p><h1>Platform settings</h1><nav class="admin-nav"><a href="/dashboard">Overview</a><a href="/dashboard/settings/ui">Platform settings</a><a href="/dashboard/pages/ui">Pages</a><a href="/dashboard/forms/ui">Forms</a><a href="/dashboard/audit">Audit log</a><a href="/admin/change-password">Change password</a><a href="/admin/logout">Sign out</a></nav><p class="setting-help">Edit branding, contact channels, GA4, typography, colours, navigation and structured homepage/geo sections. Values are stored in D1 and applied to public pages where supported. JSON fields must contain valid JSON; navigation and sections should be arrays of objects.</p><form id="settings-form" class="flow" data-flow><div class="flow-bar"><h2>Platform settings</h2><span class="flow-state" aria-live="polite">All changes saved</span><button type="submit">Save platform settings</button></div>${fields}<p id="settings-notice" role="status" aria-live="polite"></p></form><section class="ws-card"><h2>Custom content</h2><p><a href="/dashboard/pages/ui">Manage pages</a> · <a href="/dashboard/forms/ui">Manage custom forms</a></p></section></main><script src="/static/js/dashboard-settings.js" defer></script></body></html>`,
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
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length > 60)
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
      ['header_navigation', 'footer_navigation', 'geo_sections', 'homepage_sections'].includes(
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
      ['contact_email', 'contact_email_chairman'].includes(key) &&
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
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Managed pages</title><link rel="stylesheet" href="/static/css/site.css"><link rel="stylesheet" href="/static/css/dashboard.css"></head><body><main class="admin"><h1>Managed pages</h1><nav class="admin-nav"><a href="/dashboard">Overview</a><a href="/dashboard/settings/ui">Settings</a><a href="/dashboard/pages/ui">Pages</a><a href="/dashboard/forms/ui">Forms</a><a href="/admin/logout">Sign out</a></nav><p>Create SEO-friendly content pages. Content is rendered as escaped plain text; HTML is not executed.</p><div class="cms-layout"><aside class="cms-list-panel" aria-label="Pages"><h2>Your pages</h2><ul id="managed-pages"></ul><h2>Built-in site pages</h2><p class="muted">Privacy, terms, About and similar pages ship with default text. Customise one, set it to Published, and your text replaces the default.</p><ul id="builtin-pages"></ul></aside><div class="cms-editor-col"><form id="managed-page-form" class="flow" data-flow data-serp-path="/pages/{slug}"><div class="flow-bar"><h2 id="page-form-title">New page</h2><span class="flow-state" aria-live="polite">All changes saved</span><button id="page-new" type="button">New page</button><button type="submit">Save page</button></div><input type="hidden" name="id"><fieldset class="flow-card"><legend data-step="1">The page</legend><div class="flow-grid"><label class="span-2">Title <input name="title" minlength="3" maxlength="180" required></label><label>Slug <input name="slug" pattern="[a-z0-9-]+" maxlength="100" required></label><label>Status <select name="status"><option value="draft">Draft</option><option value="published">Published</option><option value="archived">Archived</option></select></label><label class="span-2">Description <textarea name="description" maxlength="500"></textarea></label></div></fieldset><fieldset class="flow-card"><legend data-step="2">Content</legend><label>Body (plain text; HTML is not executed) <textarea name="bodyMarkdown" rows="12" maxlength="20000" required></textarea></label></fieldset><fieldset class="flow-card"><legend data-step="3">Search appearance</legend><div class="flow-grid"><label class="span-2">SEO title <input name="seoTitle" maxlength="180"></label><label class="span-2">SEO description <input name="seoDescription" maxlength="320"></label></div></fieldset></form><p id="page-notice" role="status"></p></div></div></main><script src="/static/js/dashboard-pages.js" defer></script></body></html>`,
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
  ).all();
  return c.json({ data: r.results ?? [] });
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
  return c.json({ data: { id: pageId, slug: d.slug, status: d.status } });
});

admin.get('/forms/ui', requireRole('admin', 'super_admin', 'editor'), (c) =>
  c.html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Managed forms</title><link rel="stylesheet" href="/static/css/site.css"><link rel="stylesheet" href="/static/css/dashboard.css"></head><body><main class="admin"><h1>Managed forms</h1><nav class="admin-nav"><a href="/dashboard">Overview</a><a href="/dashboard/settings/ui">Settings</a><a href="/dashboard/pages/ui">Pages</a><a href="/dashboard/forms/ui">Forms</a><a href="/admin/logout">Sign out</a></nav><p>Define form fields as JSON array, e.g. [{"name":"name","label":"Full name","type":"text","required":true},{"name":"email","label":"Email","type":"email","required":true}]. Submissions are saved in D1; published forms can optionally be associated with a listing using its slug.</p><form id="managed-form-form" class="flow" data-flow><input type="hidden" name="id"><label>Title <input name="title" minlength="3" maxlength="180" required></label><label>Slug <input name="slug" pattern="[a-z0-9-]+" maxlength="100" required></label><label>Description <textarea name="description" maxlength="500"></textarea></label><label>Fields JSON <textarea name="fieldsJson" rows="8" required>[{"name":"name","label":"Full name","type":"text","required":true},{"name":"email","label":"Business email","type":"email","required":true},{"name":"message","label":"How can we help?","type":"textarea","required":true}]</textarea></label><label>Status <select name="status"><option value="draft">Draft</option><option value="published">Published</option><option value="archived">Archived</option></select></label><label><input type="checkbox" name="notificationEnabled" checked> Notify staff by email on submission</label><button>Save form</button></form><p id="form-notice" role="status"></p><ul id="managed-forms"></ul><h2>Form submissions</h2><p>Submissions are shown newest first. Contact and listing details are confidential; use them only for the requested business purpose.</p><div class="enq-bar"><label>Status <select id="sub-status"><option value="">All</option><option value="new">New</option><option value="in_progress">In progress</option><option value="closed">Closed</option><option value="spam">Spam</option></select></label><label>Search <input id="sub-q" type="search" maxlength="100" placeholder="Search submitted details" autocomplete="off"></label><a id="sub-export" class="button secondary" href="/dashboard/form-submissions/export.csv" download>Export CSV</a></div><section id="managed-submissions" aria-live="polite">Loading submissions…</section></main><script src="/static/js/dashboard-forms.js" defer></script></body></html>`,
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
const csvCell = (value: unknown): string => {
  let text = String(value ?? '');
  // Neutralise spreadsheet formula injection from public input.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
};
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
  return new Response(`﻿${lines.join('\r\n')}\r\n`, {
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

/* ---------------------------------------------------------------- staff accounts (super administrators only) */
const staffRoles = ['super_admin', 'admin', 'editor', 'broker', 'publisher', 'auditor'] as const;

admin.get('/staff/ui', requireRole('super_admin'), async (c) =>
  c.html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Staff accounts · Casinos of Mayfair</title><link rel="stylesheet" href="/static/css/site.css"><link rel="stylesheet" href="/static/css/dashboard.css"></head><body><main class="admin"><p class="eyebrow">STAFF WORKSPACE</p><h1>Staff accounts</h1><nav class="admin-nav"><a href="/dashboard">Overview</a><a href="/dashboard/buyers/ui">Buyer access</a><a href="/dashboard/audit">Audit log</a></nav><p class="muted">Only super administrators can create staff, change roles or suspend access. Leave the temporary password blank to email the person a set-password link.</p><form id="staff-create" class="buyer-provision"><label>Full name <input name="displayName" minlength="2" maxlength="120" required></label><label>Work email <input name="email" type="email" maxlength="254" required></label><label>Role <select name="role"><option value="admin">admin</option><option value="editor">editor</option><option value="broker">broker</option><option value="publisher">publisher</option><option value="auditor">auditor</option><option value="super_admin">super_admin</option></select></label><label>Temporary password (optional, min 12 characters) <input name="temporaryPassword" type="password" autocomplete="new-password" minlength="12" maxlength="200"></label><button type="submit">Create staff account</button></form><p id="notice" role="status"></p><section id="staff-list">Loading staff…</section></main><script src="/static/js/dashboard-staff.js" defer></script></body></html>`,
  ),
);

admin.get('/staff', requireRole('super_admin'), async (c) => {
  const result = await c.env.DB.prepare(
    "SELECT id, email, display_name AS displayName, role, status, created_at AS createdAt, CASE WHEN password_hash IS NULL THEN 0 ELSE 1 END AS hasPassword FROM users WHERE user_type = 'staff' ORDER BY created_at LIMIT 300",
  ).all();
  return c.json({
    data: (result.results ?? []).map((r) => ({ ...r, hasPassword: r['hasPassword'] === 1 })),
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
    })
    .refine((v) => v.role || v.status)
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'Choose a role or status.' } },
      422,
    );
  const target = c.req.param('id');
  if (target === c.get('staff').id)
    return c.json(
      {
        error: {
          code: 'SELF_CHANGE_BLOCKED',
          message: 'You cannot change your own role or status.',
        },
      },
      409,
    );
  const user = await c.env.DB.prepare(
    "SELECT id, role, status FROM users WHERE id = ? AND user_type = 'staff'",
  )
    .bind(target)
    .first<{ id: string; role: string; status: string }>();
  if (!user)
    return c.json({ error: { code: 'NOT_FOUND', message: 'Staff account not found.' } }, 404);
  const role = parsed.data.role ?? user.role;
  const status = parsed.data.status ?? user.status;
  const timestamp = now();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE users SET role = ?, status = ?, updated_at = ? WHERE id = ? AND user_type = 'staff'",
    ).bind(role, status, timestamp, user.id),
    c.env.DB.prepare(
      'UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND (? != ? OR ? != ?)',
    ).bind(timestamp, user.id, status, 'active', role, user.role),
  ]);
  await audit(c, 'staff.updated', 'user', user.id, {
    from: { role: user.role, status: user.status },
    to: { role, status },
  });
  return c.json({ data: { id: user.id, role, status } });
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
