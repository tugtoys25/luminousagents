import { z } from 'zod';
import { requireRole } from '../../auth/staff-session';
import { slugify } from '../../domain/opportunities/slug';
import { checkLifecycleTransition } from '../../domain/opportunities/lifecycle';
import { Hono } from 'hono';
import { sellerGateResult } from '../../seller/gate-check';
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
  findForVerify,
  findOpportunityFull,
  findOpportunityScoped,
  findRef,
  findVersionSnapshot,
  findWorkflowRow,
  insertVersion,
  isVisibleToStaff,
  listVersions,
  loadStage,
  nextVersion,
  RESTORABLE_COLUMNS,
  restoreContent,
  setPublication,
  setReview,
  slugTakenByOther,
  stampVerified,
  workflow,
} from '../repos/opportunity-lifecycle-repo';

const admin = new Hono<AdminApp>();

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

admin.get('/opportunities/:id/versions', requireRole('admin', 'editor', 'broker', 'publisher', 'super_admin'), async (c) => {
  const staff = c.get('staff');
  const owned = await isVisibleToStaff(c.env.DB, c.req.param('id'), staff.role === 'broker', staff.id);
  if (!owned) return c.json({ error: { code: 'NOT_FOUND', message: 'Opportunity not found.' } }, 404);
  const versions = await listVersions(c.env.DB, c.req.param('id'));
  return c.json({ data: versions });
});

admin.post('/opportunities/:id/versions/:versionNumber/restore', requireRole(...editorRoles), async (c) => {
  const versionNumber = Number(c.req.param('versionNumber'));
  const restoreInput = z.object({ reason: z.string().trim().min(3).max(500) }).safeParse(await c.req.json().catch(() => null));
  if (!restoreInput.success) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Provide a restore reason of at least 3 characters.' } }, 422);
  if (!Number.isSafeInteger(versionNumber) || versionNumber < 1)
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid version number.' } }, 422);
  const staff = c.get('staff');
  const existing = await findOpportunityScoped(c.env.DB, c.req.param('id'), staff.role === 'broker', staff.id);
  if (!existing) return c.json({ error: { code: 'NOT_FOUND', message: 'Opportunity not found.' } }, 404);
  const snapshotJson = await findVersionSnapshot(c.env.DB, String(existing.id), versionNumber);
  if (snapshotJson === null) return c.json({ error: { code: 'NOT_FOUND', message: 'Version not found.' } }, 404);
  let snapshot: Record<string, unknown>;
  try { snapshot = JSON.parse(snapshotJson) as Record<string, unknown>; }
  catch { return c.json({ error: { code: 'VERSION_CORRUPT', message: 'This version cannot be restored because its snapshot is invalid.' } }, 409); }
  const editable = RESTORABLE_COLUMNS;
  if (typeof snapshot.title !== 'string' || typeof snapshot.slug !== 'string')
    return c.json({ error: { code: 'VERSION_CORRUPT', message: 'This version is missing required opportunity fields.' } }, 409);
  const values = editable.map((key) => snapshot[key] ?? (key === 'price_visibility' ? 0 : key === 'labels_json' ? '[]' : ''));
  const timestamp = now();
  // Restores content only; review and publication are deliberately reset to private/pending.
  let restoredSlug = snapshot.slug;
  const existingId = String(existing.id);
  if (await slugTakenByOther(c.env.DB, String(restoredSlug), existingId)) restoredSlug = `${slugify(String(snapshot.title))}-${existingId.slice(0, 8)}`;
  await restoreContent(c.env.DB, { opportunityId: existingId, values, slug: String(restoredSlug), timestamp });
  const restored = await findOpportunityFull(c.env.DB, existingId);
  await insertVersion(c.env.DB, {
    id: id(),
    opportunityId: existingId,
    versionNumber: await nextVersion(c.env.DB, existingId),
    snapshotJson: JSON.stringify(restored),
    changedBy: staff.id,
    reason: `Restored version ${versionNumber}: ${restoreInput.data.reason}; returned to draft for review`,
    timestamp,
  });
  const cachePurge = await purgeOpportunityPublicCache(c.env, String(existing.slug), typeof existing.country === 'string' ? existing.country : null);
  await audit(c, 'opportunity.version_restored', 'opportunity', String(existing.id), { restoredVersion: versionNumber, cachePurge });
  return c.json({ data: { opportunity: restored, restoredVersion: versionNumber, reviewStatus: 'pending', publicVisibility: false } });
});

admin.post('/opportunities/:id/verify', requireRole(...publisherRoles), async (c) => {
  const parsed = z.object({ reason: z.string().trim().min(3).max(500) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Provide a verification note of at least 3 characters.' } }, 422);
  const existing = await findForVerify(c.env.DB, c.req.param('id'));
  if (!existing) return c.json({ error: { code: 'NOT_FOUND', message: 'Opportunity not found.' } }, 404);
  const timestamp = now();
  await stampVerified(c.env.DB, existing.id, timestamp);
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
  const existing = await findOpportunityFull(c.env.DB, c.req.param('id'));
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
  if (publicVisibility || lifecycle === 'published') {
    const gates = await sellerGateResult(c.env.DB, String(existing.id));
    if (gates.unmet.length)
      return c.json({ error: { code: 'SELLER_GATES_NOT_MET', message: 'This seller-sourced opportunity cannot be published until every authority, mandate and review gate is satisfied.', unmet: gates.unmet } }, 409);
  }
  const timestamp = now();
  await setPublication(c.env.DB, { opportunityId: String(existing.id), lifecycle, publicVisibility, timestamp });
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
    const row = await findWorkflowRow(c.env.DB, c.req.param('id'));
    if (!row || (staff.role === 'broker' && row.broker !== staff.id))
      return c.json({ error: { code: 'NOT_FOUND', message: 'Opportunity not found.' } }, 404);
    const conflict = (code: string, message: string) => c.json({ error: { code, message } }, 409);
    /** Every lifecycle change goes through the Sprint 32 state machine. */
    const hop = (from: string, to: string) => checkLifecycleTransition(from, to, staff.role);
    const timestamp = now();
    const live = row.lifecycle === 'published' && row.vis === 1;
    const closed = ['sold', 'off_market', 'archived', 'on_hold', 'under_offer'].includes(row.lifecycle);
    let run: () => Promise<unknown>;
    switch (action) {
      case 'submit': {
        if (live || row.review === 'approved')
          return conflict('ALREADY_REVIEWED', 'This listing is already approved.');
        const step = hop(row.lifecycle, 'in_review');
        if (!step.ok) return conflict(step.code, step.message);
        run = () => workflow.submit(c.env.DB, row.id, timestamp);
        break;
      }
      case 'approve':
        if (live) return conflict('ALREADY_LIVE', 'This listing is already live.');
        if (closed) return conflict('LISTING_CLOSED', 'Restore this listing before approving it.');
        run = () => workflow.approve(c.env.DB, row.id, timestamp);
        break;
      case 'unapprove': {
        let lifecycle = row.lifecycle;
        if (lifecycle === 'published') {
          const step = hop('published', 'in_review');
          if (!step.ok) return conflict(step.code, step.message);
          lifecycle = 'in_review';
        }
        run = () => workflow.unapprove(c.env.DB, row.id, lifecycle, timestamp);
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
        const gates = await sellerGateResult(c.env.DB, row.id);
        if (gates.unmet.length)
          return c.json({ error: { code: 'SELLER_GATES_NOT_MET', message: 'This seller-sourced opportunity cannot be published until every authority, mandate and review gate is satisfied.', unmet: gates.unmet } }, 409);
        // A draft must pass through "in review" first; both hops are checked.
        const route =
          row.lifecycle === 'draft' ? ['in_review', 'published'] : row.lifecycle === 'published' ? [] : ['published'];
        let from = row.lifecycle;
        for (const to of route) {
          const step = hop(from, to);
          if (!step.ok) return conflict(step.code, step.message);
          from = to;
        }
        run = () => workflow.publish(c.env.DB, row.id, timestamp);
        break;
      }
      case 'unpublish': {
        if (row.lifecycle === 'published') {
          const step = hop('published', 'in_review');
          if (!step.ok) return conflict(step.code, step.message);
        }
        run = () => workflow.unpublish(c.env.DB, row.id, timestamp);
        break;
      }
      case 'archive': {
        const step = hop(row.lifecycle, 'archived');
        if (!step.ok) return conflict(step.code, step.message);
        run = () => workflow.archive(c.env.DB, row.id, timestamp);
        break;
      }
      default: {
        const target = hop(row.lifecycle, 'draft').ok ? 'draft' : 'in_review';
        const step = hop(row.lifecycle, target);
        if (!step.ok || row.lifecycle === target)
          return conflict('NOT_CLOSED', 'This listing does not need restoring.');
        run = () => workflow.restore(c.env.DB, row.id, target, timestamp);
      }
    }
    await run();
    const cachePurge = await purgeOpportunityPublicCache(c.env, row.slug, row.country);
    await audit(c, `opportunity.workflow.${action}`, 'opportunity', row.id, {
      reason: parsed.data.reason ?? null,
      fromLifecycle: row.lifecycle,
      fromReview: row.review,
      wasLive: live,
      cachePurge,
    });
    c.header('Cache-Control', 'private, no-store');
    const after = await loadStage(c.env.DB, row.id);
    return c.json({ data: { id: row.id, ...after } });
  },
);

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
  const existing = await findRef(c.env.DB, c.req.param('id'));
  if (!existing)
    return c.json({ error: { code: 'NOT_FOUND', message: 'Opportunity not found.' } }, 404);
  const timestamp = now();
  await setReview(c.env.DB, {
    opportunityId: c.req.param('id'),
    decision: parsed.data.decision,
    verifiedAt: parsed.data.verifiedAt ?? timestamp,
    timestamp,
  });
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

export default admin;
