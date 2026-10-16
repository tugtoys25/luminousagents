/** SQL for the staff dashboard overview. Brokers only see opportunities assigned to them. */
export interface OverviewCounts {
  total: number;
  pending: number;
  published: number;
}

export async function loadOverview(db: D1Database, staffId: string, brokerOnly: 0 | 1) {
  const [counts, pending, recent] = await Promise.all([
    db
      .prepare(
        "SELECT COUNT(*) AS total, SUM(CASE WHEN content_review_status = 'pending' THEN 1 ELSE 0 END) AS pending, SUM(CASE WHEN lifecycle = 'published' AND public_visibility = 1 AND content_review_status = 'approved' THEN 1 ELSE 0 END) AS published FROM opportunities WHERE (? = 0 OR assigned_broker_id = ?)",
      )
      .bind(brokerOnly, staffId)
      .first<OverviewCounts>(),
    db
      .prepare(
        "SELECT id, title, country, legacy_status AS legacyStatus, updated_at AS updatedAt FROM opportunities WHERE content_review_status = 'pending' AND (? = 0 OR assigned_broker_id = ?) ORDER BY updated_at DESC LIMIT 8",
      )
      .bind(brokerOnly, staffId)
      .all(),
    db
      .prepare(
        'SELECT id, title, country, lifecycle, content_review_status AS reviewStatus, updated_at AS updatedAt FROM opportunities WHERE (? = 0 OR assigned_broker_id = ?) ORDER BY updated_at DESC LIMIT 10',
      )
      .bind(brokerOnly, staffId)
      .all(),
  ]);
  return { counts, pending: pending.results ?? [], recent: recent.results ?? [] };
}

export async function listActiveBrokers(db: D1Database): Promise<unknown[]> {
  const result = await db
    .prepare(
      "SELECT id, display_name AS displayName, email FROM users WHERE user_type = 'staff' AND status = 'active' AND role = 'broker' ORDER BY display_name COLLATE NOCASE",
    )
    .all();
  return result.results ?? [];
}
