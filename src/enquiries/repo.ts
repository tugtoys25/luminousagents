/** All SQL for public enquiries. Routes call these; they never touch D1 directly. */
export interface PublishedOpportunity {
  id: string;
  assignedBrokerId: string | null;
  title: string;
}

export async function findPublishedOpportunity(
  db: D1Database,
  slug: string,
): Promise<PublishedOpportunity | null> {
  return db
    .prepare(
      "SELECT id, assigned_broker_id AS assignedBrokerId, title FROM opportunities WHERE slug = ? AND lifecycle = 'published' AND content_review_status = 'approved' AND public_visibility = 1 LIMIT 1",
    )
    .bind(slug)
    .first<PublishedOpportunity>();
}

export interface EnquiryBundle {
  enquiryId: string;
  opportunityId: string | null;
  opportunityTitle: string;
  assignedBrokerId: string | null;
  name: string;
  email: string;
  company: string;
  message: string;
  ipHash: string | null;
  requestId: string;
  taskId: string;
  auditId: string;
  jobId: string;
  acknowledgementJobId: string;
  brokerJobId: string | null;
  timestamp: string;
  dueAt: string;
}

const JOB_SQL =
  "INSERT INTO notification_jobs (id, job_type, payload_json, status, attempts, available_at, created_at, updated_at) VALUES (?, ?, ?, 'queued', 0, ?, ?, ?)";

/** Enquiry, follow-up task, audit row and notification jobs commit atomically in one batch. */
export async function insertEnquiryBundle(db: D1Database, e: EnquiryBundle): Promise<void> {
  const t = e.timestamp;
  const statements = [
    db
      .prepare(
        "INSERT INTO enquiries (id, opportunity_id, name, email, company, message, source, status, assigned_to, consent_at, ip_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'website', 'new', ?, ?, ?, ?, ?)",
      )
      .bind(e.enquiryId, e.opportunityId, e.name, e.email, e.company, e.message, e.assignedBrokerId, t, e.ipHash, t, t),
    db
      .prepare(
        "INSERT INTO staff_tasks (id,title,description,status,priority,due_at,assigned_to,related_entity_type,related_entity_id,created_by,created_at,updated_at) VALUES (?,?,?,'open','normal',?,?,?,?,NULL,?,?)",
      )
      .bind(
        e.taskId,
        'Review new website enquiry',
        `Enquiry reference: ${e.enquiryId}${e.opportunityTitle ? ` · Opportunity: ${e.opportunityTitle}` : ''}`,
        e.dueAt,
        e.assignedBrokerId,
        'enquiry',
        e.enquiryId,
        t,
        t,
      ),
    db
      .prepare(
        "INSERT INTO audit_logs (id, actor_user_id, actor_type, action, entity_type, entity_id, request_id, details_json, created_at) VALUES (?, NULL, 'public', 'enquiry.created', 'enquiry', ?, ?, ?, ?)",
      )
      .bind(
        e.auditId,
        e.enquiryId,
        e.requestId,
        JSON.stringify({
          source: 'website',
          hasOpportunity: Boolean(e.opportunityId),
          assignedBrokerId: e.assignedBrokerId,
          taskId: e.taskId,
          taskDueAt: e.dueAt,
        }),
        t,
      ),
    db.prepare(JOB_SQL).bind(e.jobId, 'enquiry.received', JSON.stringify({ enquiryId: e.enquiryId }), t, t, t),
    db
      .prepare(JOB_SQL)
      .bind(e.acknowledgementJobId, 'enquiry.acknowledgement', JSON.stringify({ enquiryId: e.enquiryId }), t, t, t),
  ];
  if (e.brokerJobId && e.assignedBrokerId)
    statements.push(
      db
        .prepare(JOB_SQL)
        .bind(
          e.brokerJobId,
          'enquiry.assigned',
          JSON.stringify({ enquiryId: e.enquiryId, assignedBrokerId: e.assignedBrokerId }),
          t,
          t,
          t,
        ),
    );
  await db.batch(statements);
}
