/** SQL for the opportunity review queue, list, export, bulk review and reconciliation (read) pages. */
import {
  buildReconciliationSql,
  DUPLICATE_LEGACY_ID_SQL,
  DUPLICATE_SLUG_SQL,
  RECONCILIATION_GROUPINGS,
} from '../../domain/opportunities/reconciliation';
import { STAGE_SQL } from '../shared';

type Row = Record<string, unknown>;

export interface ReviewQueueRow {
  id: string;
  title: string;
  country: string | null;
  priceText: string;
  summary: string;
  lifecycle: string;
  reviewStatus: string;
  publicVisibility: number;
  classification: string;
  lastVerifiedAt: string | null;
  updatedAt: string;
  assignedBrokerId: string | null;
}

export async function reviewQueueRows(
  db: D1Database,
  f: { brokerOnly: 0 | 1; staffId: string; staleBeforeIso: string },
): Promise<ReviewQueueRow[]> {
  const rows = await db
    .prepare(
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
    )
    .bind(f.brokerOnly, f.staffId, f.staleBeforeIso)
    .all<ReviewQueueRow>();
  return rows.results ?? [];
}

export interface OpportunityListFilter {
  q: string;
  review: string;
  stage: string;
  brokerOnly: 0 | 1;
  staffId: string;
  pageSize: number;
  page: number;
}

export async function listOpportunities(
  db: D1Database,
  f: OpportunityListFilter,
): Promise<{ rows: Row[]; stageCounts: { stage: string; n: number }[] }> {
  const like = `%${f.q}%`;
  const where = `(? = '' OR title LIKE ? OR country LIKE ? OR slug LIKE ?) AND (? = '' OR content_review_status = ?) AND (? = 0 OR assigned_broker_id = ?)`;
  const base = [f.q, like, like, like, f.review, f.review, f.brokerOnly, f.staffId];
  const [rows, counts] = await Promise.all([
    db
      .prepare(
        `SELECT * FROM (SELECT id, slug, title, country, opportunity_type AS opportunityType, price_text AS priceText, lifecycle, classification, content_review_status AS reviewStatus, public_visibility AS publicVisibility, assigned_broker_id AS assignedBrokerId, updated_at AS updatedAt, ${STAGE_SQL} AS stage FROM opportunities WHERE ${where}) WHERE (? = '' OR stage = ?) ORDER BY updatedAt DESC, title ASC LIMIT ? OFFSET ?`,
      )
      .bind(...base, f.stage, f.stage, f.pageSize, (f.page - 1) * f.pageSize)
      .all<Row>(),
    db
      .prepare(`SELECT stage, COUNT(*) AS n FROM (SELECT ${STAGE_SQL} AS stage FROM opportunities WHERE ${where}) GROUP BY stage`)
      .bind(...base)
      .all<{ stage: string; n: number }>(),
  ]);
  return { rows: rows.results ?? [], stageCounts: counts.results ?? [] };
}

export async function exportOpportunityRows(db: D1Database): Promise<Row[]> {
  const result = await db
    .prepare(
      `SELECT id, legacy_id, slug, title, country, opportunity_type, classification, labels_json,
      price_text, price_visibility, lifecycle, content_review_status, legacy_status, summary,
      body_html, availability, points_json, public_visibility, last_verified_at, published_at,
      seo_title, seo_description, assigned_broker_id, created_at, updated_at
     FROM opportunities ORDER BY updated_at DESC`,
    )
    .all<Row>();
  return result.results ?? [];
}

export interface OpportunityRef {
  id: string;
  slug: string;
  country: string | null;
}

export function findOpportunityRef(db: D1Database, id: string): Promise<OpportunityRef | null> {
  return db
    .prepare('SELECT id, slug, country FROM opportunities WHERE id = ?')
    .bind(id)
    .first<OpportunityRef>();
}

/** A review decision always returns the record to private; approval also stamps last_verified_at. */
export async function applyReviewDecision(
  db: D1Database,
  opportunityId: string,
  decision: 'approved' | 'rejected',
  timestamp: string,
): Promise<void> {
  await db
    .prepare(
      "UPDATE opportunities SET content_review_status = ?, last_verified_at = CASE WHEN ? = 'approved' THEN ? ELSE last_verified_at END, public_visibility = 0, updated_at = ? WHERE id = ?",
    )
    .bind(decision, decision, timestamp, timestamp, opportunityId)
    .run();
}

export interface ReconciliationData {
  counts: Record<string, number>;
  groups: Record<string, Row[]>;
  duplicateLegacyIds: number;
  duplicateSlugs: number;
}

export async function loadReconciliation(db: D1Database): Promise<ReconciliationData> {
  const counts = (await db.prepare(buildReconciliationSql()).first<Record<string, number>>()) ?? {};
  const groups: Record<string, Row[]> = {};
  for (const grouping of RECONCILIATION_GROUPINGS) {
    const result = await db
      .prepare(`SELECT ${grouping.column} AS value, COUNT(*) AS count FROM opportunities GROUP BY ${grouping.column} ORDER BY count DESC`)
      .all<Row>();
    groups[grouping.key] = result.results ?? [];
  }
  const duplicateLegacy = await db.prepare(DUPLICATE_LEGACY_ID_SQL).first<{ n: number }>();
  const duplicateSlug = await db.prepare(DUPLICATE_SLUG_SQL).first<{ n: number }>();
  return {
    counts,
    groups,
    duplicateLegacyIds: Number(duplicateLegacy?.n ?? 0),
    duplicateSlugs: Number(duplicateSlug?.n ?? 0),
  };
}
