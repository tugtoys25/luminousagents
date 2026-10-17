/** SQL for staff-managed public pages and forms (public read, public form submission). */
export function findPublishedPage(
  db: D1Database,
  slug: string,
): Promise<{ title: string; description: string; bodyMarkdown: string; seoTitle: string; seoDescription: string } | null> {
  return db
    .prepare(
      "SELECT title,description,body_markdown AS bodyMarkdown,seo_title AS seoTitle,seo_description AS seoDescription FROM managed_pages WHERE slug=? AND status='published' LIMIT 1",
    )
    .bind(slug)
    .first();
}

export function findPublishedForm(
  db: D1Database,
  slug: string,
): Promise<{ id: string; title: string; description: string; fieldsJson: string } | null> {
  return db
    .prepare("SELECT id,title,description,fields_json AS fieldsJson FROM managed_forms WHERE slug=? AND status='published' LIMIT 1")
    .bind(slug)
    .first();
}

export function findPublishedFormForSubmit(
  db: D1Database,
  slug: string,
): Promise<{ id: string; title: string; description: string; fieldsJson: string; notificationEnabled: number } | null> {
  return db
    .prepare(
      "SELECT id,title,description,fields_json AS fieldsJson,notification_enabled AS notificationEnabled FROM managed_forms WHERE slug=? AND status='published' LIMIT 1",
    )
    .bind(slug)
    .first();
}

/** A submission may only be linked to a listing that is genuinely public; anything else is ignored. */
export async function findPublicOpportunityId(db: D1Database, slug: string): Promise<string | null> {
  const op = await db
    .prepare(
      "SELECT id,title FROM opportunities WHERE slug=? AND lifecycle='published' AND content_review_status='approved' AND public_visibility=1 LIMIT 1",
    )
    .bind(slug)
    .first<{ id: string; title: string }>();
  return op ? op.id : null;
}

export interface NewSubmission {
  id: string;
  formId: string;
  opportunityId: string | null;
  dataJson: string;
  ipHash: string | null;
  timestamp: string;
  requestId: string;
  auditId: string;
  /** Present when the form notifies staff; the job is queued in the same transaction. */
  notificationJobId: string | null;
}

/** Atomic: the submission, its audit row and (optionally) the notification job all commit together or not at all. */
export async function insertSubmission(db: D1Database, s: NewSubmission): Promise<void> {
  const statements = [
    db
      .prepare('INSERT INTO managed_form_submissions (id,form_id,opportunity_id,data_json,consent_at,ip_hash,created_at) VALUES (?,?,?,?,?,?,?)')
      .bind(s.id, s.formId, s.opportunityId, s.dataJson, s.timestamp, s.ipHash, s.timestamp),
    db
      .prepare(
        "INSERT INTO audit_logs (id,actor_user_id,actor_type,action,entity_type,entity_id,request_id,details_json,created_at) VALUES (?,NULL,'public','managed_form.submitted','managed_form_submission',?,?,?,?)",
      )
      .bind(s.auditId, s.id, s.requestId, JSON.stringify({ formId: s.formId, opportunityId: s.opportunityId }), s.timestamp),
  ];
  if (s.notificationJobId)
    statements.push(
      db
        .prepare(
          "INSERT INTO notification_jobs (id,job_type,payload_json,status,attempts,available_at,created_at,updated_at) VALUES (?,'managed_form.submitted',?,'queued',0,?,?,?)",
        )
        .bind(s.notificationJobId, JSON.stringify({ submissionId: s.id }), s.timestamp, s.timestamp, s.timestamp),
    );
  await db.batch(statements);
}
