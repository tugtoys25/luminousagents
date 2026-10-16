/** SQL for NDA access requests and their review. Brokers are scoped to requests on their assigned opportunities. */
type Row = Record<string, unknown>;

export interface NdaRequestRef {
  id: string;
  userId: string;
  opportunityId: string;
  status: string;
}
export interface SignedPdfRef {
  id: string;
  r2Key: string | null;
  sha256: string | null;
}

export async function listNdaRequests(
  db: D1Database,
  f: { status: string; brokerOnly: 0 | 1; staffId: string },
): Promise<Row[]> {
  const result = await db
    .prepare(
      "SELECT n.id, n.status, n.acceptance_name AS acceptanceName, n.accepted_at AS acceptedAt, n.review_reason AS reviewReason, CASE WHEN n.signed_pdf_r2_key IS NULL THEN 0 ELSE 1 END AS hasSignedPdf, n.created_at AS createdAt, u.email AS buyerEmail, u.display_name AS buyerName, o.title AS opportunityTitle FROM nda_requests n JOIN users u ON u.id = n.user_id JOIN opportunities o ON o.id = n.opportunity_id WHERE (? = '' OR n.status = ?) AND (? = 0 OR o.assigned_broker_id = ?) ORDER BY n.created_at DESC LIMIT 100",
    )
    .bind(f.status, f.status, f.brokerOnly, f.staffId)
    .all<Row>();
  return result.results ?? [];
}

export function findSignedPdf(db: D1Database, id: string): Promise<SignedPdfRef | null> {
  return db
    .prepare('SELECT id, signed_pdf_r2_key AS r2Key, signed_pdf_sha256 AS sha256 FROM nda_requests WHERE id = ? LIMIT 1')
    .bind(id)
    .first<SignedPdfRef>();
}

export function findNdaRequest(db: D1Database, id: string): Promise<NdaRequestRef | null> {
  return db
    .prepare('SELECT id, user_id AS userId, opportunity_id AS opportunityId, status FROM nda_requests WHERE id = ?')
    .bind(id)
    .first<NdaRequestRef>();
}

export interface ReviewArgs {
  request: NdaRequestRef;
  decision: 'approved' | 'rejected';
  reason: string;
  tier: 1 | 2 | 3;
  staffId: string;
  requestId: string;
  timestamp: string;
  /** ISO expiry of the access grant; only used when approved. */
  expiry: string;
  grantId: string;
  auditId: string;
  decisionJobId: string;
}

/**
 * Records the decision, creates the access grant (approvals only), writes the audit row and queues the
 * decision email job. All statements commit together, so a decision never exists without its grant or job.
 */
export async function reviewNdaRequest(db: D1Database, r: ReviewArgs): Promise<void> {
  const approved = r.decision === 'approved';
  const t = r.timestamp;
  const statements = [
    db
      .prepare('UPDATE nda_requests SET status = ?, review_reason = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ?')
      .bind(r.decision, r.reason, r.staffId, t, t, r.request.id),
  ];
  if (approved)
    statements.push(
      db
        .prepare(
          'INSERT INTO access_grants (id, user_id, opportunity_id, nda_request_id, tier, granted_by, granted_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(r.grantId, r.request.userId, r.request.opportunityId, r.request.id, r.tier, r.staffId, t, r.expiry),
    );
  statements.push(
    db
      .prepare(
        "INSERT INTO audit_logs (id, actor_user_id, actor_type, action, entity_type, entity_id, request_id, details_json, created_at) VALUES (?, ?, 'staff', ?, 'nda_request', ?, ?, ?, ?)",
      )
      .bind(
        r.auditId,
        r.staffId,
        `nda.${r.decision}`,
        r.request.id,
        r.requestId,
        JSON.stringify({ reason: r.reason, tier: r.tier, expiresAt: approved ? r.expiry : null }),
        t,
      ),
    db
      .prepare(
        "INSERT INTO notification_jobs (id, job_type, payload_json, status, attempts, available_at, created_at, updated_at) VALUES (?, 'nda.decision', ?, 'queued', 0, ?, ?, ?)",
      )
      .bind(r.decisionJobId, JSON.stringify({ ndaRequestId: r.request.id }), t, t, t),
  );
  await db.batch(statements);
}
