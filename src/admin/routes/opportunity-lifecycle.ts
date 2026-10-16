import { z } from 'zod';
import { requireRole } from '../../auth/staff-session';
import { slugify } from '../../domain/opportunities/slug';
import { checkLifecycleTransition } from '../../domain/opportunities/lifecycle';
import { Hono } from 'hono';
import {
  type AdminApp,
  audit,
  editorRoles,
  id,
  now,
  publisherRoles,
  purgeOpportunityPublicCache,
  STAGE_SQL,
} from '../shared';

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

export default admin;
