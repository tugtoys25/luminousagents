import { requireRole } from '../../auth/staff-session';
import { z } from 'zod';
import { Hono } from 'hono';
import { findSubmission, listForms, querySubmissions, type SubmissionFilters, updateSubmission, upsertForm } from '../repos/forms-repo';
import { type AdminApp, audit, csvCell, id, now } from '../shared';

const admin = new Hono<AdminApp>();

const submissionStatuses = ['new', 'in_progress', 'closed', 'spam'] as const;

function submissionFilters(c: {
  req: { query(key: string): string | undefined };
}): SubmissionFilters {
  const status = c.req.query('status') ?? '';
  const safeStatus = (submissionStatuses as readonly string[]).includes(status) ? status : '';
  const form = (c.req.query('form') ?? '').slice(0, 100);
  const q = (c.req.query('q') ?? '').trim().slice(0, 100);
  const like = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  return [safeStatus, safeStatus, form, form, q, like];
}

admin.get('/forms/ui', requireRole('admin', 'super_admin', 'editor'), (c) =>
  c.html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Managed forms</title><link rel="stylesheet" href="/static/css/site.css"><link rel="stylesheet" href="/static/css/dashboard.css"></head><body><main class="admin"><h1>Managed forms</h1><nav class="admin-nav"><a href="/dashboard">Overview</a><a href="/dashboard/settings/ui">Settings</a><a href="/dashboard/pages/ui">Pages</a><a href="/dashboard/forms/ui">Forms</a><a href="/admin/logout">Sign out</a></nav><p>Build a form by adding the fields you need below. Submissions are saved and listed further down; published forms can optionally be associated with a listing using its slug.</p><form id="managed-form-form" class="flow" data-flow><input type="hidden" name="id"><label>Title <input name="title" minlength="3" maxlength="180" required></label><label>Slug <input name="slug" pattern="[a-z0-9-]+" maxlength="100" required></label><label>Description <textarea name="description" maxlength="500"></textarea></label><label>Fields JSON <textarea name="fieldsJson" rows="8" required>[{"name":"name","label":"Full name","type":"text","required":true},{"name":"email","label":"Business email","type":"email","required":true},{"name":"message","label":"How can we help?","type":"textarea","required":true}]</textarea></label><label>Status <select name="status"><option value="draft">Draft</option><option value="published">Published</option><option value="archived">Archived</option></select></label><label><input type="checkbox" name="notificationEnabled" checked> Notify staff by email on submission</label><button>Save form</button></form><p id="form-notice" role="status"></p><ul id="managed-forms"></ul><h2>Form submissions</h2><p>Submissions are shown newest first. Contact and listing details are confidential; use them only for the requested business purpose.</p><div class="enq-bar"><label>Status <select id="sub-status"><option value="">All</option><option value="new">New</option><option value="in_progress">In progress</option><option value="closed">Closed</option><option value="spam">Spam</option></select></label><label>Search <input id="sub-q" type="search" maxlength="100" placeholder="Search submitted details" autocomplete="off"></label><a id="sub-export" class="button secondary" href="/dashboard/form-submissions/export.csv" download>Export CSV</a></div><section id="managed-submissions" aria-live="polite">Loading submissions…</section></main><script src="/static/js/dashboard-forms.js" defer></script></body></html>`,
  ),
);

admin.get('/forms', requireRole('admin', 'super_admin', 'editor'), async (c) => {
  return c.json({ data: await listForms(c.env.DB) });
});

admin.get(
  '/form-submissions',
  requireRole('admin', 'super_admin', 'editor', 'broker', 'auditor'),
  async (c) => {
    const rowsAll = await querySubmissions(c.env.DB, submissionFilters(c), 200);
    return c.json({
      data: rowsAll.map((row) => {
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
  const exportRows = await querySubmissions(c.env.DB, submissionFilters(c), 5000);
  const rows = exportRows.map((row) => {
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
    const existing = await findSubmission(c.env.DB, c.req.param('id'));
    if (!existing)
      return c.json({ error: { code: 'NOT_FOUND', message: 'Submission not found.' } }, 404);
    const stamp = now();
    await updateSubmission(c.env.DB, existing.id, parsed.data, stamp);
    await audit(c, 'managed_form.submission_updated', 'managed_form_submission', existing.id, {
      from: existing.status,
      status: parsed.data.status,
      noteChanged: parsed.data.internalNote !== undefined,
    });
    return c.json({
      data: {
        id: existing.id,
        status: parsed.data.status ?? existing.status,
        updatedAt: stamp,
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
    await upsertForm(
      c.env.DB,
      formId,
      {
        slug: d.slug,
        title: d.title,
        description: d.description,
        fieldsJson: JSON.stringify(validFields.data),
        notificationEnabled: d.notificationEnabled,
        status: d.status,
      },
      staff.id,
      timestamp,
    );
  } catch {
    return c.json(
      { error: { code: 'SLUG_CONFLICT', message: 'That slug is already in use.' } },
      409,
    );
  }
  await audit(c, 'managed_form.saved', 'managed_form', formId, { slug: d.slug, status: d.status });
  return c.json({ data: { id: formId, slug: d.slug, status: d.status, url: `/forms/${d.slug}` } });
});

export default admin;
