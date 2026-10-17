/** SQL for listing images (opportunity_media) and attaching them from the Media library. */
type Row = Record<string, unknown>;

export interface MediaOpportunity {
  id: string;
  slug: string;
  country: string | null;
  publicVisibility: number;
  assignedBrokerId: string | null;
}

export function findOpportunityForMedia(db: D1Database, opportunityId: string): Promise<MediaOpportunity | null> {
  return db
    .prepare(
      'SELECT id, slug, country, public_visibility AS publicVisibility, assigned_broker_id AS assignedBrokerId FROM opportunities WHERE id = ?',
    )
    .bind(opportunityId)
    .first<MediaOpportunity>();
}

export async function nextSortOrder(db: D1Database, opportunityId: string): Promise<number> {
  const row = await db
    .prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM opportunity_media WHERE opportunity_id = ?')
    .bind(opportunityId)
    .first<{ next: number }>();
  return row?.next ?? 0;
}

export interface LibraryAsset {
  id: string;
  r2Key: string;
  contentType: string;
  byteSize: number;
  altText: string | null;
  visibility: string;
}

/** Looks a PUBLIC library asset up by id or public slug. */
export function findPublicLibraryAsset(db: D1Database, lookup: string): Promise<LibraryAsset | null> {
  return db
    .prepare(
      "SELECT id, r2_key AS r2Key, content_type AS contentType, byte_size AS byteSize, alt_text AS altText, visibility FROM media_assets WHERE (id = ?1 OR public_slug = ?1) AND visibility = 'public'",
    )
    .bind(lookup)
    .first<LibraryAsset>();
}

/** Only fills a missing description; never overwrites one that staff wrote. */
export async function backfillAssetAltText(db: D1Database, assetId: string, altText: string, timestamp: string): Promise<void> {
  await db
    .prepare("UPDATE media_assets SET alt_text = ?, updated_at = ? WHERE id = ? AND (alt_text IS NULL OR alt_text = '')")
    .bind(altText, timestamp, assetId)
    .run();
}

export interface AttachImage {
  mediaId: string;
  opportunityId: string;
  r2Key: string;
  altText: string;
  sortOrder: number;
  contentType: string;
  byteSize: number;
  sha256: string;
  timestamp: string;
  actorId: string;
  requestId: string;
  reviewAuditId: string;
  /** Present for direct uploads; library attaches write their own audit row afterwards. */
  uploadAudit: { id: string; detailsJson: string } | null;
}

/**
 * Atomic. Changing the pictures of a LIVE listing sends it back for approval; the review audit row is
 * written only if that UPDATE changed a row, so it MUST stay directly after the UPDATE.
 */
export async function attachImage(db: D1Database, p: AttachImage): Promise<void> {
  const statements = [
    db
      .prepare(
        "UPDATE opportunities SET content_review_status = 'pending', public_visibility = 0, updated_at = ? WHERE id = ? AND public_visibility = 1",
      )
      .bind(p.timestamp, p.opportunityId),
  ];
  if (p.uploadAudit) {
    statements.push(reviewAudit(db, p.reviewAuditId, p.actorId, p.opportunityId, p.requestId, p.timestamp));
  }
  statements.push(
    db
      .prepare(
        'INSERT INTO opportunity_media (id, opportunity_id, r2_key, alt_text, sort_order, created_at, content_type, byte_size, sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(p.mediaId, p.opportunityId, p.r2Key, p.altText, p.sortOrder, p.timestamp, p.contentType, p.byteSize, p.sha256),
  );
  if (p.uploadAudit) {
    statements.push(
      db
        .prepare(
          "INSERT INTO audit_logs (id, actor_user_id, actor_type, action, entity_type, entity_id, request_id, details_json, created_at) VALUES (?, ?, 'staff', 'opportunity.media_uploaded', 'opportunity_media', ?, ?, ?, ?)",
        )
        .bind(p.uploadAudit.id, p.actorId, p.mediaId, p.requestId, p.uploadAudit.detailsJson, p.timestamp),
    );
  }
  await db.batch(statements);
}

function reviewAudit(db: D1Database, auditId: string, actorId: string, opportunityId: string, requestId: string, timestamp: string) {
  return db
    .prepare(
      "INSERT INTO audit_logs (id, actor_user_id, actor_type, action, entity_type, entity_id, request_id, details_json, created_at) SELECT ?, ?, 'staff', 'opportunity.media_change_requires_review', 'opportunity', ?, ?, '{}', ? WHERE changes() > 0",
    )
    .bind(auditId, actorId, opportunityId, requestId, timestamp);
}

export async function listOpportunityMedia(
  db: D1Database,
  opportunityId: string,
  brokerOnly: boolean,
  staffId: string,
): Promise<Row[]> {
  const result = await db
    .prepare(
      'SELECT m.id, m.alt_text AS altText, m.sort_order AS sortOrder, m.content_type AS contentType, m.byte_size AS byteSize, m.sha256 FROM opportunity_media m JOIN opportunities o ON o.id = m.opportunity_id WHERE m.opportunity_id = ? AND (? = 0 OR o.assigned_broker_id = ?) ORDER BY m.sort_order, m.created_at',
    )
    .bind(opportunityId, brokerOnly ? 1 : 0, staffId)
    .all<Row>();
  return result.results ?? [];
}

export interface MediaForDelete {
  id: string;
  r2Key: string;
  slug: string;
  country: string | null;
  assignedBrokerId: string | null;
}

export function findMediaForDelete(db: D1Database, mediaId: string, opportunityId: string): Promise<MediaForDelete | null> {
  return db
    .prepare(
      'SELECT m.id, m.r2_key AS r2Key, o.slug, o.country, o.assigned_broker_id AS assignedBrokerId FROM opportunity_media m JOIN opportunities o ON o.id = m.opportunity_id WHERE m.id = ? AND m.opportunity_id = ?',
    )
    .bind(mediaId, opportunityId)
    .first<MediaForDelete>();
}

/** Atomic: review reset (+ its audit, adjacent), the delete, and the delete audit. */
export async function deleteImage(
  db: D1Database,
  p: { mediaId: string; opportunityId: string; timestamp: string; actorId: string; requestId: string; reviewAuditId: string; deleteAuditId: string },
): Promise<void> {
  await db.batch([
    db
      .prepare(
        "UPDATE opportunities SET content_review_status = 'pending', public_visibility = 0, updated_at = ? WHERE id = ? AND public_visibility = 1",
      )
      .bind(p.timestamp, p.opportunityId),
    reviewAudit(db, p.reviewAuditId, p.actorId, p.opportunityId, p.requestId, p.timestamp),
    db.prepare('DELETE FROM opportunity_media WHERE id = ?').bind(p.mediaId),
    db
      .prepare(
        "INSERT INTO audit_logs (id, actor_user_id, actor_type, action, entity_type, entity_id, request_id, details_json, created_at) VALUES (?, ?, 'staff', 'opportunity.media_deleted', 'opportunity_media', ?, ?, '{}', ?)",
      )
      .bind(p.deleteAuditId, p.actorId, p.mediaId, p.requestId, p.timestamp),
  ]);
}
