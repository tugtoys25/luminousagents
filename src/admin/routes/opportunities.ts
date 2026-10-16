import { z } from 'zod';
import { requireRole } from '../../auth/staff-session';
import { slugify } from '../../domain/opportunities/slug';
import { Hono } from 'hono';
import {
  type AdminApp,
  audit,
  editorRoles,
  id,
  now,
  publisherRoles,
  purgeOpportunityPublicCache,
} from '../shared';

const admin = new Hono<AdminApp>();

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

export default admin;
