import { requireRole } from '../../auth/staff-session';
import { STATIC_PAGES, staticPageSlug } from '../../web/static-pages';
import { z } from 'zod';
import { Hono } from 'hono';
import { deletePage, findPage, findPageSlugById, listPages, setPageStatus, upsertPage } from '../repos/pages-repo';
import { type AdminApp, audit, id, now } from '../shared';

const admin = new Hono<AdminApp>();

admin.get('/pages/ui', requireRole('admin', 'super_admin', 'editor'), (c) =>
  c.html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pages · Luminous Agents</title><link rel="stylesheet" href="/static/css/site.css"><link rel="stylesheet" href="/static/css/dashboard.css"></head><body><main class="admin"><p class="eyebrow">STAFF WORKSPACE</p><h1>Pages</h1><nav class="admin-nav"><a href="/dashboard">Overview</a><a href="/dashboard/settings/ui">Settings</a><a href="/dashboard/pages/ui">Pages</a><a href="/dashboard/forms/ui">Forms</a><a href="/admin/logout">Sign out</a></nav><section id="pages-list-view"><p class="muted">Edit the text of built-in pages (About, Services, FAQ, legal notices) or add your own pages. A built-in page always keeps its address, for example /legal/privacy. New pages live under /pages/.</p><div class="dx-toolbar"><div class="dx-tabs" id="pg-tabs" role="tablist"><button type="button" class="dx-tab" role="tab" data-tab="all" aria-selected="true">All<span class="dx-count">0</span></button><button type="button" class="dx-tab" role="tab" data-tab="builtin" aria-selected="false">Built-in<span class="dx-count">0</span></button><button type="button" class="dx-tab" role="tab" data-tab="custom" aria-selected="false">My pages<span class="dx-count">0</span></button><button type="button" class="dx-tab" role="tab" data-tab="draft" aria-selected="false">Drafts<span class="dx-count">0</span></button></div><input class="dx-search" id="pg-search" type="search" placeholder="Search pages" aria-label="Search pages"><span class="dx-spacer"></span><button type="button" class="dx-btn dx-btn-primary" id="pg-new">New page</button></div><div id="pg-table" class="dx-table-wrap">Loading…</div></section><section id="pages-editor-view" hidden><div class="dx-editor-bar"><button type="button" class="dx-btn" id="pg-back">← All pages</button><h2 id="pg-heading">New page</h2><span class="dx-spacer"></span><a class="dx-btn" id="pg-view" target="_blank" rel="noopener" hidden>View live</a><button type="submit" form="pg-form" class="dx-btn dx-btn-primary">Save page</button></div><form id="pg-form" class="dx-editor"><input type="hidden" name="id"><div class="dx-editor-main"><div class="dx-card"><label class="dx-field">Title<input name="title" minlength="3" maxlength="180" required></label><label class="dx-field">Content<small>Plain text. Blank lines start a new paragraph. HTML is not executed.</small><textarea name="bodyMarkdown" rows="18" maxlength="20000" required></textarea></label></div><details class="dx-card"><summary>Search appearance (optional)</summary><div class="dx-form"><label class="dx-field">Page description<textarea name="description" maxlength="500" rows="2"></textarea></label><label class="dx-field">SEO title<input name="seoTitle" maxlength="180"></label><label class="dx-field">SEO description<input name="seoDescription" maxlength="320"></label></div></details></div><aside class="dx-editor-side"><div class="dx-card"><label class="dx-field">Status<select name="status"><option value="draft">Draft - not public</option><option value="published">Published - live</option><option value="archived">Archived - hidden</option></select></label><div class="dx-field"><span>Address</span><div id="pg-url" class="dx-url"></div><input name="slug" id="pg-slug" pattern="[a-z0-9]+(-[a-z0-9]+)*" maxlength="100" required><small id="pg-url-note"></small></div></div></aside></form></section></main><script src="/static/js/dashboard-kit.js" defer></script><script src="/static/js/dashboard-pages.js" defer></script></body></html>`,
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
  const rows = await listPages(c.env.DB);
  const builtIn = new Map(STATIC_PAGES.map(([path]) => [staticPageSlug(path), path]));
  return c.json({
    data: rows.map((row) => ({
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
    const existingSlug = await findPageSlugById(c.env.DB, d.id);
    if (existingSlug && existingSlug !== d.slug && (builtIn.has(existingSlug) || builtIn.has(d.slug)))
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
    await upsertPage(c.env.DB, pageId, d, staff.id, timestamp);
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
  const page = await findPage(c.env.DB, c.req.param('id'));
  if (!page) return c.json({ error: { code: 'NOT_FOUND', message: 'Page not found.' } }, 404);
  await setPageStatus(c.env.DB, page.id, body.data.status, c.get('staff').id, now());
  await audit(c, 'managed_page.status_changed', 'managed_page', page.id, {
    slug: page.slug,
    status: body.data.status,
  });
  return c.json({ data: { id: page.id, status: body.data.status } });
});

/** Deletes a custom page, or resets a built-in page back to its default text. */
admin.delete('/pages/:id', requireRole('admin', 'super_admin'), async (c) => {
  const page = await findPage(c.env.DB, c.req.param('id'));
  if (!page) return c.json({ error: { code: 'NOT_FOUND', message: 'Page not found.' } }, 404);
  await deletePage(c.env.DB, page.id);
  await audit(c, 'managed_page.deleted', 'managed_page', page.id, { slug: page.slug });
  return c.json({ data: { id: page.id, deleted: true } });
});

export default admin;
