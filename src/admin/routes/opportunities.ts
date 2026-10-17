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
import {
  activeBrokerExists,
  deleteOpportunityRow,
  findForDelete,
  hasLinkedRecords,
  insertOpportunity,
  slugExists,
  updateOpportunity,
} from '../repos/opportunities-repo';
import {
  findOpportunityFull,
  findOpportunityScoped,
  insertVersion,
  nextVersion,
  slugTakenByOther,
} from '../repos/opportunity-lifecycle-repo';

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
    const broker = await activeBrokerExists(c.env.DB, assignedBrokerId);
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
  const collision = await slugExists(c.env.DB, slug);
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
  await insertOpportunity(c.env.DB, {
    id: opportunityId,
    slug,
    title: input.title,
    country: input.country,
    opportunityType: input.opportunityType,
    classification: input.classification,
    labels: input.labels,
    priceText: input.priceText,
    priceVisibility: input.priceVisibility,
    summary: input.summary,
    bodyHtml: input.bodyHtml,
    availability: input.availability,
    seoTitle: input.seoTitle,
    seoDescription: input.seoDescription,
    assignedBrokerId,
    timestamp,
  });
  await insertVersion(c.env.DB, {
    id: id(),
    opportunityId,
    versionNumber: 1,
    snapshotJson: JSON.stringify(record),
    changedBy: c.get('staff').id,
    reason: 'Initial creation',
    timestamp,
  });
  await audit(c, 'opportunity.created', 'opportunity', opportunityId, { slug });
  return c.json(
    { data: { id: opportunityId, slug, lifecycle: 'draft', contentReviewStatus: 'pending' } },
    201,
  );
});

admin.get('/opportunities/:id', requireRole('admin', 'editor', 'broker', 'publisher', 'auditor', 'super_admin'), async (c) => {
  const staff = c.get('staff');
  const row = await findOpportunityScoped(c.env.DB, c.req.param('id'), staff.role === 'broker', staff.id);
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
  const existing = await findOpportunityScoped(c.env.DB, c.req.param('id'), staff.role === 'broker', staff.id);
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
      const broker = await activeBrokerExists(c.env.DB, requested);
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
  let newSlug: string | null = null;
  if (input.title && input.title !== existing.title) {
    newSlug = slugify(input.title);
    if (await slugTakenByOther(c.env.DB, newSlug, String(existing.id)))
      newSlug = `${newSlug}-${String(existing.id).slice(0, 8)}`;
  }
  await updateOpportunity(c.env.DB, String(existing.id), input, newSlug, updatedAt);
  const cachePurge = await purgeOpportunityPublicCache(
    c.env,
    String(existing.slug),
    typeof existing.country === 'string' ? existing.country : null,
  );
  const updated = await findOpportunityFull(c.env.DB, String(existing.id));
  await insertVersion(c.env.DB, {
    id: id(),
    opportunityId: String(existing.id),
    versionNumber: await nextVersion(c.env.DB, String(existing.id)),
    snapshotJson: JSON.stringify(updated),
    changedBy: c.get('staff').id,
    reason: 'Opportunity edited; sent back for content review',
    timestamp: updatedAt,
  });
  await audit(c, 'opportunity.updated', 'opportunity', String(existing.id), {
    fields: Object.keys(input),
    reviewReset: true,
    cachePurge,
  });
  return c.json({ data: updated });
});

admin.delete('/opportunities/:id', requireRole('admin', 'super_admin'), async (c) => {
  const row = await findForDelete(c.env.DB, c.req.param('id'));
  if (!row) return c.json({ error: { code: 'NOT_FOUND', message: 'Opportunity not found.' } }, 404);
  if (await hasLinkedRecords(c.env.DB, row.id))
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
    await deleteOpportunityRow(c.env.DB, row.id);
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
