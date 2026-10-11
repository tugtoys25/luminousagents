/**
 * Sprint 32 — reconciliation checks over the opportunities table.
 *
 * Every row in `opportunities` must be accounted for: how many exist, what state each is in,
 * and whether any publication invariant is broken. The same check list is mirrored by
 * `scripts/sprint32-reconcile.mjs`, which runs the migrations in an in-memory SQLite database
 * so the 198 legacy records can be reconciled without any Cloudflare resource.
 *
 * Each `where` fragment is a fixed SQL literal, never built from user input.
 */

export interface ReconciliationCheck {
  key: string;
  label: string;
  /** "blocker" means the record set must not be published until the count is zero. */
  severity: 'blocker' | 'review' | 'info';
  where: string;
}

export const RECONCILIATION_CHECKS: readonly ReconciliationCheck[] = [
  {
    key: 'public_not_published',
    label: 'Public visibility on but lifecycle is not published',
    severity: 'blocker',
    where: "public_visibility = 1 AND lifecycle <> 'published'",
  },
  {
    key: 'public_not_approved',
    label: 'Publicly visible without approved content',
    severity: 'blocker',
    where: "public_visibility = 1 AND content_review_status <> 'approved'",
  },
  {
    key: 'public_not_verified',
    label: 'Publicly visible without a verification date',
    severity: 'blocker',
    where: 'public_visibility = 1 AND last_verified_at IS NULL',
  },
  {
    key: 'public_not_classified_public',
    label: 'Publicly visible but classification is not public',
    severity: 'blocker',
    where: "public_visibility = 1 AND classification <> 'public'",
  },
  {
    key: 'published_not_approved',
    label: 'Lifecycle published without approved content',
    severity: 'blocker',
    where: "lifecycle = 'published' AND content_review_status <> 'approved'",
  },
  {
    key: 'orphan_assigned_broker',
    label: 'Assigned broker no longer exists',
    severity: 'blocker',
    where:
      'assigned_broker_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = opportunities.assigned_broker_id)',
  },
  {
    key: 'pending_review',
    label: 'Content review still pending',
    severity: 'review',
    where: "content_review_status = 'pending'",
  },
  {
    key: 'never_verified',
    label: 'Never verified (no last_verified_at)',
    severity: 'review',
    where: 'last_verified_at IS NULL',
  },
  {
    key: 'missing_country',
    label: 'Country missing',
    severity: 'review',
    where: "country IS NULL OR trim(country) = ''",
  },
  {
    key: 'missing_summary',
    label: 'Summary missing',
    severity: 'review',
    where: "summary IS NULL OR trim(summary) = ''",
  },
  {
    key: 'unparsed_price',
    label: 'Price text present but no structured amount or currency',
    severity: 'review',
    where: "trim(price_text) <> '' AND price_minor IS NULL AND currency IS NULL",
  },
  {
    key: 'confidential_price',
    label: 'Price is confidential to the public',
    severity: 'info',
    where: 'price_visibility = 0',
  },
  {
    key: 'legacy_imported',
    label: 'Imported from the legacy listing set',
    severity: 'info',
    where: 'legacy_id IS NOT NULL',
  },
];

/** One SELECT returning a count column per check plus the total row count. */
export function buildReconciliationSql(): string {
  const columns = RECONCILIATION_CHECKS.map(
    (check) => `COALESCE(SUM(CASE WHEN ${check.where} THEN 1 ELSE 0 END), 0) AS ${check.key}`,
  );
  return `SELECT COUNT(*) AS total, ${columns.join(', ')} FROM opportunities`;
}

export const RECONCILIATION_GROUPINGS: readonly { key: string; column: string }[] = [
  { key: 'byLifecycle', column: 'lifecycle' },
  { key: 'byReviewStatus', column: 'content_review_status' },
  { key: 'byPublicVisibility', column: 'public_visibility' },
  { key: 'byClassification', column: 'classification' },
  { key: 'byLegacyStatus', column: 'legacy_status' },
];

export const DUPLICATE_LEGACY_ID_SQL =
  'SELECT COUNT(*) AS n FROM (SELECT legacy_id FROM opportunities WHERE legacy_id IS NOT NULL GROUP BY legacy_id HAVING COUNT(*) > 1)';

export const DUPLICATE_SLUG_SQL =
  'SELECT COUNT(*) AS n FROM (SELECT slug FROM opportunities GROUP BY slug HAVING COUNT(*) > 1)';
