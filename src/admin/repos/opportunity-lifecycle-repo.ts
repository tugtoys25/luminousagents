/** SQL for opportunity versions, verification, publication and workflow transitions. */
import { STAGE_SQL } from '../shared';

type Row = Record<string, unknown>;

export async function isVisibleToStaff(db: D1Database, opportunityId: string, brokerOnly: boolean, staffId: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT id FROM opportunities WHERE id = ? AND (? = 0 OR assigned_broker_id = ?)')
    .bind(opportunityId, brokerOnly ? 1 : 0, staffId)
    .first();
  return Boolean(row);
}

export async function listVersions(db: D1Database, opportunityId: string): Promise<Row[]> {
  const result = await db
    .prepare(
      'SELECT id, version_number AS versionNumber, changed_by AS changedBy, change_reason AS changeReason, created_at AS createdAt FROM opportunity_versions WHERE opportunity_id = ? ORDER BY version_number DESC LIMIT 100',
    )
    .bind(opportunityId)
    .all<Row>();
  return result.results ?? [];
}

export function findOpportunityScoped(db: D1Database, opportunityId: string, brokerOnly: boolean, staffId: string): Promise<Row | null> {
  return db
    .prepare('SELECT * FROM opportunities WHERE id = ? AND (? = 0 OR assigned_broker_id = ?)')
    .bind(opportunityId, brokerOnly ? 1 : 0, staffId)
    .first<Row>();
}

export function findOpportunityFull(db: D1Database, opportunityId: string): Promise<Row | null> {
  return db.prepare('SELECT * FROM opportunities WHERE id = ?').bind(opportunityId).first<Row>();
}

export async function findVersionSnapshot(db: D1Database, opportunityId: string, versionNumber: number): Promise<string | null> {
  const row = await db
    .prepare('SELECT snapshot_json FROM opportunity_versions WHERE opportunity_id = ? AND version_number = ?')
    .bind(opportunityId, versionNumber)
    .first<{ snapshot_json: string }>();
  return row ? row.snapshot_json : null;
}

export async function slugTakenByOther(db: D1Database, slug: string, opportunityId: string): Promise<boolean> {
  return Boolean(await db.prepare('SELECT id FROM opportunities WHERE slug = ? AND id != ?').bind(slug, opportunityId).first());
}

export const RESTORABLE_COLUMNS = [
  'title', 'country', 'opportunity_type', 'classification', 'labels_json', 'price_text', 'price_visibility',
  'summary', 'body_html', 'availability', 'seo_title', 'seo_description',
] as const;

/** Restores content only; review and publication are deliberately reset to private/pending. */
export async function restoreContent(
  db: D1Database,
  p: { opportunityId: string; values: unknown[]; slug: string; timestamp: string },
): Promise<void> {
  const assignments = RESTORABLE_COLUMNS.map((key) => `${key} = ?`).join(', ');
  await db
    .prepare(
      `UPDATE opportunities SET ${assignments}, slug = ?, lifecycle = 'draft', content_review_status = 'pending', public_visibility = 0, updated_at = ? WHERE id = ?`,
    )
    .bind(...p.values, p.slug, p.timestamp, p.opportunityId)
    .run();
}

export async function nextVersion(db: D1Database, opportunityId: string): Promise<number> {
  const row = await db
    .prepare('SELECT COALESCE(MAX(version_number), 0) + 1 AS next FROM opportunity_versions WHERE opportunity_id = ?')
    .bind(opportunityId)
    .first<{ next: number }>();
  return row?.next ?? 1;
}

export async function insertVersion(
  db: D1Database,
  v: { id: string; opportunityId: string; versionNumber: number; snapshotJson: string; changedBy: string; reason: string; timestamp: string },
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO opportunity_versions (id, opportunity_id, version_number, snapshot_json, changed_by, change_reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(v.id, v.opportunityId, v.versionNumber, v.snapshotJson, v.changedBy, v.reason, v.timestamp)
    .run();
}

export function findForVerify(db: D1Database, opportunityId: string): Promise<{ id: string; title: string; assignedBrokerId: string | null } | null> {
  return db
    .prepare('SELECT id, title, assigned_broker_id AS assignedBrokerId FROM opportunities WHERE id = ?')
    .bind(opportunityId)
    .first();
}

export async function stampVerified(db: D1Database, opportunityId: string, timestamp: string): Promise<void> {
  await db
    .prepare('UPDATE opportunities SET last_verified_at = ?, updated_at = ? WHERE id = ?')
    .bind(timestamp, timestamp, opportunityId)
    .run();
}

/** publishedAt is set once, the first time the listing goes public, and is never cleared. */
export async function setPublication(
  db: D1Database,
  p: { opportunityId: string; lifecycle: string; publicVisibility: boolean; timestamp: string },
): Promise<void> {
  const flag = p.publicVisibility ? 1 : 0;
  await db
    .prepare(
      'UPDATE opportunities SET lifecycle = ?, public_visibility = ?, published_at = CASE WHEN ? = 1 THEN COALESCE(published_at, ?) ELSE published_at END, updated_at = ? WHERE id = ?',
    )
    .bind(p.lifecycle, flag, flag, p.timestamp, p.timestamp, p.opportunityId)
    .run();
}

export interface WorkflowRow {
  id: string;
  slug: string;
  country: string | null;
  lifecycle: string;
  classification: string;
  review: string;
  vis: number;
  broker: string | null;
}

export function findWorkflowRow(db: D1Database, opportunityId: string): Promise<WorkflowRow | null> {
  return db
    .prepare(
      'SELECT id, slug, country, lifecycle, classification, content_review_status AS review, public_visibility AS vis, assigned_broker_id AS broker FROM opportunities WHERE id = ?',
    )
    .bind(opportunityId)
    .first<WorkflowRow>();
}

/** One statement per transition. The route decides IF a transition is allowed; these only perform it. */
export const workflow = {
  submit: (db: D1Database, oid: string, ts: string) =>
    db.prepare("UPDATE opportunities SET lifecycle = 'in_review', public_visibility = 0, updated_at = ? WHERE id = ?").bind(ts, oid).run(),
  approve: (db: D1Database, oid: string, ts: string) =>
    db
      .prepare("UPDATE opportunities SET content_review_status = 'approved', last_verified_at = ?, public_visibility = 0, updated_at = ? WHERE id = ?")
      .bind(ts, ts, oid)
      .run(),
  unapprove: (db: D1Database, oid: string, lifecycle: string, ts: string) =>
    db
      .prepare("UPDATE opportunities SET content_review_status = 'pending', public_visibility = 0, lifecycle = ?, updated_at = ? WHERE id = ?")
      .bind(lifecycle, ts, oid)
      .run(),
  publish: (db: D1Database, oid: string, ts: string) =>
    db
      .prepare(
        "UPDATE opportunities SET lifecycle = 'published', public_visibility = 1, classification = 'public', last_verified_at = COALESCE(last_verified_at, ?), published_at = COALESCE(published_at, ?), updated_at = ? WHERE id = ?",
      )
      .bind(ts, ts, ts, oid)
      .run(),
  unpublish: (db: D1Database, oid: string, ts: string) =>
    db
      .prepare("UPDATE opportunities SET lifecycle = CASE WHEN lifecycle = 'published' THEN 'in_review' ELSE lifecycle END, public_visibility = 0, updated_at = ? WHERE id = ?")
      .bind(ts, oid)
      .run(),
  archive: (db: D1Database, oid: string, ts: string) =>
    db.prepare("UPDATE opportunities SET lifecycle = 'archived', public_visibility = 0, updated_at = ? WHERE id = ?").bind(ts, oid).run(),
  restore: (db: D1Database, oid: string, target: string, ts: string) =>
    db.prepare('UPDATE opportunities SET lifecycle = ?, public_visibility = 0, updated_at = ? WHERE id = ?').bind(target, ts, oid).run(),
};

export function loadStage(db: D1Database, opportunityId: string): Promise<Row | null> {
  return db
    .prepare(
      `SELECT lifecycle, classification, content_review_status AS reviewStatus, public_visibility AS publicVisibility, ${STAGE_SQL} AS stage FROM opportunities WHERE id = ?`,
    )
    .bind(opportunityId)
    .first<Row>();
}

export function findRef(db: D1Database, opportunityId: string): Promise<{ id: string; slug: string; country: string | null } | null> {
  return db
    .prepare('SELECT id, slug, country FROM opportunities WHERE id = ?')
    .bind(opportunityId)
    .first();
}

/** A decision always returns the listing to private; only approval stamps last_verified_at. */
export async function setReview(
  db: D1Database,
  p: { opportunityId: string; decision: 'approved' | 'rejected'; verifiedAt: string; timestamp: string },
): Promise<void> {
  await db
    .prepare(
      "UPDATE opportunities SET content_review_status = ?, last_verified_at = CASE WHEN ? = 'approved' THEN ? ELSE last_verified_at END, public_visibility = 0, updated_at = ? WHERE id = ?",
    )
    .bind(p.decision, p.decision, p.verifiedAt, p.timestamp, p.opportunityId)
    .run();
}
