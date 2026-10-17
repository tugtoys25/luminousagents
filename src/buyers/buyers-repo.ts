/**
 * SQL for the buyer portal API: session lookup, profile, saved listings, NDA requests and data-room access.
 * Access rules live here in ONE place: a document is reachable only if it is clean, belongs to a publicly listed
 * opportunity, and the buyer holds an unrevoked, unexpired grant whose tier covers it.
 */
import type { OpportunityRow } from '../domain/opportunities/serialize';

export type BuyerSessionRow = {
  id: string;
  email: string;
  displayName: string;
  status: string;
  hasPassword: number;
  mustChange: number;
  sessionId: string;
};

/** Resolves a HASHED buyer session token to an active buyer. */
export function findBuyerSession(db: D1Database, tokenHash: string, nowIso: string): Promise<BuyerSessionRow | null> {
  return db
    .prepare(
      "SELECT u.id, u.email, u.display_name AS displayName, u.status, CASE WHEN u.password_hash IS NULL THEN 0 ELSE 1 END AS hasPassword, u.must_change_password AS mustChange, s.id AS sessionId FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND u.user_type = 'buyer' AND u.status = 'active' LIMIT 1",
    )
    .bind(tokenHash, nowIso)
    .first<BuyerSessionRow>();
}

export async function insertBuyerAudit(
  db: D1Database,
  r: { id: string; buyerId: string; action: string; entityType: string; entityId: string; requestId: string; detailsJson: string; timestamp: string },
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO audit_logs (id, actor_user_id, actor_type, action, entity_type, entity_id, request_id, details_json, created_at) VALUES (?, ?, 'buyer', ?, ?, ?, ?, ?, ?)",
    )
    .bind(r.id, r.buyerId, r.action, r.entityType, r.entityId, r.requestId, r.detailsJson, r.timestamp)
    .run();
}

export type BuyerProfileRow = {
  companyName: string;
  roleTitle: string;
  countriesJson: string;
  budgetMinMinor: number | null;
  budgetMaxMinor: number | null;
  currency: string;
  experienceNotes: string;
  updatedAt: string;
};

export function findBuyerProfile(db: D1Database, userId: string): Promise<BuyerProfileRow | null> {
  return db
    .prepare(
      'SELECT company_name AS companyName, role_title AS roleTitle, countries_json AS countriesJson, budget_min_minor AS budgetMinMinor, budget_max_minor AS budgetMaxMinor, currency, experience_notes AS experienceNotes, updated_at AS updatedAt FROM buyer_profiles WHERE user_id = ? LIMIT 1',
    )
    .bind(userId)
    .first<BuyerProfileRow>();
}

export async function upsertBuyerProfile(
  db: D1Database,
  p: {
    userId: string;
    companyName: string;
    roleTitle: string;
    countriesJson: string;
    budgetMinMinor: number | null;
    budgetMaxMinor: number | null;
    currency: string;
    experienceNotes: string;
    timestamp: string;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO buyer_profiles (user_id, company_name, role_title, countries_json, budget_min_minor, budget_max_minor, currency, experience_notes, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET company_name = excluded.company_name, role_title = excluded.role_title,
       countries_json = excluded.countries_json, budget_min_minor = excluded.budget_min_minor,
       budget_max_minor = excluded.budget_max_minor, currency = excluded.currency,
       experience_notes = excluded.experience_notes, updated_at = excluded.updated_at`,
    )
    .bind(p.userId, p.companyName, p.roleTitle, p.countriesJson, p.budgetMinMinor, p.budgetMaxMinor, p.currency, p.experienceNotes, p.timestamp)
    .run();
}

/** Saved listings that are STILL publicly listed; a listing that goes private disappears from the buyer's list. */
export async function listSavedPublic(db: D1Database, userId: string): Promise<Array<OpportunityRow & { savedAt: string }>> {
  const result = await db
    .prepare(
      "SELECT o.id, o.slug, o.title, o.country, o.opportunity_type, o.price_text, o.price_visibility, o.lifecycle, o.summary, o.availability, o.points_json, o.seo_title, o.seo_description, o.published_at, o.classification, o.labels_json, (SELECT id FROM opportunity_media m WHERE m.opportunity_id = o.id ORDER BY m.sort_order ASC, m.created_at ASC LIMIT 1) AS cover_media_id, (SELECT alt_text FROM opportunity_media ma WHERE ma.id = (SELECT id FROM opportunity_media mb WHERE mb.opportunity_id = o.id ORDER BY mb.sort_order ASC, mb.created_at ASC LIMIT 1)) AS cover_media_alt, s.created_at AS savedAt FROM saved_opportunities s JOIN opportunities o ON o.id = s.opportunity_id WHERE s.user_id = ? AND o.lifecycle = 'published' AND o.content_review_status = 'approved' AND o.public_visibility = 1 AND o.classification = 'public' ORDER BY s.created_at DESC",
    )
    .bind(userId)
    .all<OpportunityRow & { savedAt: string }>();
  return result.results ?? [];
}

export async function publicOpportunityExists(db: D1Database, opportunityId: string): Promise<boolean> {
  const row = await db
    .prepare(
      "SELECT id FROM opportunities WHERE id = ? AND lifecycle = 'published' AND content_review_status = 'approved' AND public_visibility = 1 AND classification = 'public'",
    )
    .bind(opportunityId)
    .first();
  return Boolean(row);
}

export async function saveOpportunity(db: D1Database, userId: string, opportunityId: string, timestamp: string): Promise<void> {
  await db
    .prepare('INSERT OR IGNORE INTO saved_opportunities (user_id, opportunity_id, created_at) VALUES (?, ?, ?)')
    .bind(userId, opportunityId, timestamp)
    .run();
}

export async function unsaveOpportunity(db: D1Database, userId: string, opportunityId: string): Promise<void> {
  await db
    .prepare('DELETE FROM saved_opportunities WHERE user_id = ? AND opportunity_id = ?')
    .bind(userId, opportunityId)
    .run();
}

export async function listNdaRequests(db: D1Database, userId: string): Promise<Array<Record<string, unknown>>> {
  const result = await db
    .prepare(
      'SELECT n.id, n.status, n.acceptance_name AS acceptanceName, n.accepted_at AS acceptedAt, n.review_reason AS reviewReason, CASE WHEN n.signed_pdf_r2_key IS NULL THEN 0 ELSE 1 END AS hasSignedPdf, n.created_at AS createdAt, o.id AS opportunityId, o.slug AS opportunitySlug, o.title AS opportunityTitle, g.id AS grantId, g.tier AS accessTier, g.expires_at AS accessExpiresAt, g.revoked_at AS accessRevokedAt FROM nda_requests n JOIN opportunities o ON o.id = n.opportunity_id LEFT JOIN access_grants g ON g.nda_request_id = n.id AND g.user_id = n.user_id WHERE n.user_id = ? ORDER BY n.created_at DESC LIMIT 100',
    )
    .bind(userId)
    .all<Record<string, unknown>>();
  return result.results ?? [];
}

/** The buyer's current data-room grant for a listing: unrevoked AND unexpired, or null. */
export function findActiveGrant(
  db: D1Database,
  userId: string,
  opportunityId: string,
  nowIso: string,
): Promise<{ id: string; tier: number } | null> {
  return db
    .prepare(
      'SELECT id, tier FROM access_grants WHERE user_id = ? AND opportunity_id = ? AND revoked_at IS NULL AND expires_at > ? LIMIT 1',
    )
    .bind(userId, opportunityId, nowIso)
    .first<{ id: string; tier: number }>();
}

/** Clean documents at or below the grant tier, newest first. Uncleared (pending/rejected) files never appear. */
export async function listDocumentsAtTier(db: D1Database, opportunityId: string, tier: number): Promise<Array<Record<string, unknown>>> {
  const result = await db
    .prepare(
      "SELECT id, filename, content_type AS contentType, byte_size AS byteSize, tier, created_at AS createdAt FROM documents WHERE opportunity_id = ? AND tier <= ? AND scan_status = 'clean' ORDER BY created_at DESC",
    )
    .bind(opportunityId, tier)
    .all<Record<string, unknown>>();
  return result.results ?? [];
}

export type DownloadableDocument = {
  id: string;
  opportunityId: string;
  r2Key: string;
  filename: string;
  contentType: string;
  tier: number;
};

/** A document is only visible if it is scan-clean AND its opportunity is publicly listed. The caller must still check the grant. */
export function findAccessibleDocument(db: D1Database, documentId: string): Promise<DownloadableDocument | null> {
  return db
    .prepare(
      "SELECT d.id, d.opportunity_id AS opportunityId, d.r2_key AS r2Key, d.filename, d.content_type AS contentType, d.tier FROM documents d JOIN opportunities o ON o.id = d.opportunity_id WHERE d.id = ? AND d.scan_status = 'clean' AND o.lifecycle = 'published' AND o.content_review_status = 'approved' AND o.public_visibility = 1 AND o.classification = 'public'",
    )
    .bind(documentId)
    .first<DownloadableDocument>();
}

export async function listBuyerActivity(
  db: D1Database,
  userId: string,
): Promise<Array<{ action: string; entityId: string; at: string }>> {
  const result = await db
    .prepare(
      "SELECT action, entity_id AS entityId, MAX(created_at) AS at FROM audit_logs WHERE actor_user_id = ? AND actor_type = 'buyer' AND action IN ('nda.template_downloaded', 'document.downloaded', 'document.previewed') GROUP BY action, entity_id",
    )
    .bind(userId)
    .all<{ action: string; entityId: string; at: string }>();
  return result.results ?? [];
}

export type ActiveTemplate = { id: string; name: string; version: number; r2Key: string | null; contentHash: string };

export function findActiveTemplate(db: D1Database): Promise<ActiveTemplate | null> {
  return db
    .prepare(
      "SELECT id, name, version, r2_key AS r2Key, content_hash AS contentHash FROM nda_templates WHERE status = 'active' ORDER BY version DESC LIMIT 1",
    )
    .first<ActiveTemplate>();
}

/** Resolves the template a buyer is acknowledging: the one they name (if still active) or the latest active one. */
export function findTemplateForAcknowledgement(
  db: D1Database,
  templateId: string | undefined,
): Promise<{ id: string; contentHash: string } | null> {
  return templateId
    ? db
        .prepare(
          "SELECT id, content_hash AS contentHash FROM nda_templates WHERE id = ? AND status = 'active'",
        )
        .bind(templateId)
        .first<{ id: string; contentHash: string }>()
    : db
        .prepare(
          "SELECT id, content_hash AS contentHash FROM nda_templates WHERE status = 'active' ORDER BY version DESC LIMIT 1",
        )
        .first<{ id: string; contentHash: string }>();
}

export async function findPublicOpportunityIdBySlug(db: D1Database, slug: string): Promise<string | null> {
  const row = await db
    .prepare(
      "SELECT id FROM opportunities WHERE slug = ? AND lifecycle = 'published' AND content_review_status = 'approved' AND public_visibility = 1 AND classification = 'public'",
    )
    .bind(slug)
    .first<{ id: string }>();
  return row ? row.id : null;
}

/** A pending request, or an approved one with a live grant, blocks a duplicate request. */
export async function hasOpenNdaRequest(db: D1Database, userId: string, opportunityId: string, nowIso: string): Promise<boolean> {
  const row = await db
    .prepare(
      "SELECT n.id FROM nda_requests n WHERE n.user_id = ? AND n.opportunity_id = ? AND (n.status = 'pending' OR (n.status = 'approved' AND EXISTS (SELECT 1 FROM access_grants g WHERE g.nda_request_id = n.id AND g.revoked_at IS NULL AND g.expires_at > ?))) LIMIT 1",
    )
    .bind(userId, opportunityId, nowIso)
    .first();
  return Boolean(row);
}

/** Atomic: the request, its audit row and the review-notification job commit together. */
export async function insertNdaRequest(
  db: D1Database,
  r: {
    requestId: string;
    userId: string;
    opportunityId: string;
    templateId: string;
    acceptanceName: string;
    acceptedIpHash: string;
    templateHash: string;
    timestamp: string;
    auditId: string;
    auditRequestId: string;
    jobId: string;
  },
): Promise<void> {
  await db.batch([
    db
      .prepare(
        "INSERT INTO nda_requests (id, user_id, opportunity_id, template_id, status, acceptance_name, accepted_at, accepted_ip_hash, nda_template_hash, review_reason, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, '', ?, ?)",
      )
      .bind(r.requestId, r.userId, r.opportunityId, r.templateId, r.acceptanceName, r.timestamp, r.acceptedIpHash, r.templateHash, r.timestamp, r.timestamp),
    db
      .prepare(
        "INSERT INTO audit_logs (id, actor_user_id, actor_type, action, entity_type, entity_id, request_id, details_json, created_at) VALUES (?, ?, 'buyer', 'nda.requested', 'nda_request', ?, ?, ?, ?)",
      )
      .bind(
        r.auditId,
        r.userId,
        r.requestId,
        r.auditRequestId,
        JSON.stringify({ opportunityId: r.opportunityId, templateId: r.templateId, templateHash: r.templateHash }),
        r.timestamp,
      ),
    db
      .prepare(
        "INSERT INTO notification_jobs (id, job_type, payload_json, status, attempts, available_at, created_at, updated_at) VALUES (?, 'nda.review_requested', ?, 'queued', 0, ?, ?, ?)",
      )
      .bind(r.jobId, JSON.stringify({ ndaRequestId: r.requestId }), r.timestamp, r.timestamp, r.timestamp),
  ]);
}

/** The buyer's OWN pending request (ownership enforced in SQL). */
export function findPendingNdaForUpload(
  db: D1Database,
  requestId: string,
  userId: string,
): Promise<{ id: string; signedPdfR2Key: string | null } | null> {
  return db
    .prepare(
      "SELECT id, signed_pdf_r2_key AS signedPdfR2Key FROM nda_requests WHERE id = ? AND user_id = ? AND status = 'pending' LIMIT 1",
    )
    .bind(requestId, userId)
    .first<{ id: string; signedPdfR2Key: string | null }>();
}

/** Compare-and-set: attaches the scanned PDF only if the request is still pending, owned and has none. Returns true on exactly one row. */
export async function attachSignedPdf(
  db: D1Database,
  p: { key: string; sha256: string; provider: string; scannedAt: string; timestamp: string; requestId: string; userId: string },
): Promise<boolean> {
  const update = await db
    .prepare(
      "UPDATE nda_requests SET signed_pdf_r2_key = ?, signed_pdf_sha256 = ?, signed_pdf_scan_provider = ?, signed_pdf_scanned_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND status = 'pending' AND signed_pdf_r2_key IS NULL",
    )
    .bind(p.key, p.sha256, p.provider, p.scannedAt, p.timestamp, p.requestId, p.userId)
    .run();
  return (update.meta?.changes ?? 0) === 1;
}

/** Atomic: upload audit row and the staff-notification job. */
export async function recordSignedPdfUpload(
  db: D1Database,
  r: { auditId: string; userId: string; requestId: string; auditRequestId: string; detailsJson: string; timestamp: string; jobId: string },
): Promise<void> {
  await db.batch([
    db
      .prepare(
        "INSERT INTO audit_logs (id, actor_user_id, actor_type, action, entity_type, entity_id, request_id, details_json, created_at) VALUES (?, ?, 'buyer', 'nda.signed_pdf_uploaded', 'nda_request', ?, ?, ?, ?)",
      )
      .bind(r.auditId, r.userId, r.requestId, r.auditRequestId, r.detailsJson, r.timestamp),
    db
      .prepare(
        "INSERT INTO notification_jobs (id, job_type, payload_json, status, attempts, available_at, created_at, updated_at) VALUES (?, 'nda.signed_pdf_uploaded', ?, 'queued', 0, ?, ?, ?)",
      )
      .bind(r.jobId, JSON.stringify({ ndaRequestId: r.requestId }), r.timestamp, r.timestamp, r.timestamp),
  ]);
}

/** Undo attachSignedPdf when recording the audit/job failed; only clears the exact key we set. */
export async function detachSignedPdf(db: D1Database, requestId: string, key: string, timestamp: string): Promise<void> {
  await db
    .prepare(
      'UPDATE nda_requests SET signed_pdf_r2_key = NULL, signed_pdf_sha256 = NULL, signed_pdf_scan_provider = NULL, signed_pdf_scanned_at = NULL, updated_at = ? WHERE id = ? AND signed_pdf_r2_key = ?',
    )
    .bind(timestamp, requestId, key)
    .run();
}
