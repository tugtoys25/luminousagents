/** SQL for the notification queue consumer: job state machine and the records emails are rendered from. */
export type NotificationJob = {
  id: string;
  job_type: string;
  payload_json: string;
  attempts: number;
  status: string;
};

export function findJob(db: D1Database, jobId: string): Promise<NotificationJob | null> {
  return db
    .prepare('SELECT id, job_type, payload_json, attempts, status FROM notification_jobs WHERE id = ?')
    .bind(jobId)
    .first<NotificationJob>();
}

/** Compare-and-set claim: only one consumer can move a queued/failed job to processing. */
export async function claimJob(db: D1Database, jobId: string, timestamp: string): Promise<boolean> {
  const claim = await db
    .prepare("UPDATE notification_jobs SET status = 'processing', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status IN ('queued','failed')")
    .bind(timestamp, jobId)
    .run();
  return (claim.meta?.changes ?? 0) > 0;
}

export async function markSent(db: D1Database, jobId: string, timestamp: string): Promise<void> {
  await db.prepare("UPDATE notification_jobs SET status = 'sent', updated_at = ? WHERE id = ?").bind(timestamp, jobId).run();
}

export async function markRetryOrDead(
  db: D1Database,
  p: { jobId: string; dead: boolean; availableAt: string; timestamp: string },
): Promise<void> {
  await db
    .prepare('UPDATE notification_jobs SET status = ?, available_at = ?, updated_at = ? WHERE id = ?')
    .bind(p.dead ? 'dead' : 'queued', p.availableAt, p.timestamp, p.jobId)
    .run();
}

/** Jobs stuck in processing (consumer crashed) go back to the queue. */
export async function requeueStaleProcessing(db: D1Database, staleBefore: string, timestamp: string): Promise<void> {
  await db
    .prepare("UPDATE notification_jobs SET status = 'queued', available_at = ?, updated_at = ? WHERE status = 'processing' AND updated_at < ?")
    .bind(timestamp, timestamp, staleBefore)
    .run();
}

export async function buryExhaustedJobs(db: D1Database, timestamp: string): Promise<void> {
  await db
    .prepare("UPDATE notification_jobs SET status = 'dead', updated_at = ? WHERE status = 'failed' AND attempts >= 5")
    .bind(timestamp)
    .run();
}

export async function listDueJobs(db: D1Database, timestamp: string): Promise<Array<{ id: string; type: string }>> {
  const due = await db
    .prepare(
      "SELECT id, job_type AS type FROM notification_jobs WHERE status IN ('queued','failed') AND attempts < 5 AND available_at <= ? ORDER BY created_at LIMIT 100",
    )
    .bind(timestamp)
    .all<{ id: string; type: string }>();
  return due.results ?? [];
}

export function findEnquiryForAck(db: D1Database, enquiryId: string): Promise<{ id: string; name: string; email: string } | null> {
  return db.prepare('SELECT id, name, email FROM enquiries WHERE id = ?').bind(enquiryId).first();
}

export function findAssignedEnquiry(
  db: D1Database,
  enquiryId: string,
  brokerId: string,
): Promise<{ id: string; name: string; email: string; company: string; opportunityTitle: string | null; brokerEmail: string } | null> {
  return db
    .prepare(
      "SELECT e.id, e.name, e.email, e.company, o.title AS opportunityTitle, u.email AS brokerEmail FROM enquiries e JOIN users u ON u.id = e.assigned_to LEFT JOIN opportunities o ON o.id = e.opportunity_id WHERE e.id = ? AND u.id = ? AND u.status = 'active' AND u.role = 'broker'",
    )
    .bind(enquiryId, brokerId)
    .first();
}

/** Returns '' when unset or when the settings table does not exist yet. */
export async function readNotificationEmailSetting(db: D1Database): Promise<string> {
  try {
    const setting = await db
      .prepare("SELECT value_json AS value FROM platform_settings WHERE setting_key = 'notification_email'")
      .first<{ value: string }>();
    const parsed = setting ? JSON.parse(setting.value) : '';
    return typeof parsed === 'string' ? parsed : '';
  } catch {
    return ''; // migration not applied yet
  }
}

export function findPendingBuyer(
  db: D1Database,
  userId: string,
): Promise<{ id: string; displayName: string; email: string; companyName: string | null; roleTitle: string | null; experienceNotes: string | null } | null> {
  return db
    .prepare(
      "SELECT u.id, u.display_name AS displayName, u.email, p.company_name AS companyName, p.role_title AS roleTitle, p.experience_notes AS experienceNotes FROM users u LEFT JOIN buyer_profiles p ON p.user_id = u.id WHERE u.id = ? AND u.user_type = 'buyer' AND u.status = 'invited'",
    )
    .bind(userId)
    .first();
}

export function findEnquiryForOps(
  db: D1Database,
  enquiryId: string,
): Promise<{ name: string; email: string; company: string; message: string } | null> {
  return db.prepare('SELECT name, email, company, message FROM enquiries WHERE id = ?').bind(enquiryId).first();
}

export function findNdaForReview(db: D1Database, requestId: string): Promise<{ id: string; email: string; title: string } | null> {
  return db
    .prepare('SELECT n.id, u.email, o.title FROM nda_requests n JOIN users u ON u.id = n.user_id JOIN opportunities o ON o.id = n.opportunity_id WHERE n.id = ?')
    .bind(requestId)
    .first();
}

export function findSignedNda(
  db: D1Database,
  requestId: string,
): Promise<{ id: string; email: string; buyerName: string | null; opportunityTitle: string } | null> {
  return db
    .prepare(
      'SELECT n.id, u.email, u.display_name AS buyerName, o.title AS opportunityTitle FROM nda_requests n JOIN users u ON u.id = n.user_id JOIN opportunities o ON o.id = n.opportunity_id WHERE n.id = ? AND n.signed_pdf_r2_key IS NOT NULL',
    )
    .bind(requestId)
    .first();
}

export function findNdaDecision(
  db: D1Database,
  requestId: string,
): Promise<{ id: string; status: string; reason: string; email: string; name: string | null; title: string; expiresAt: string | null } | null> {
  return db
    .prepare(
      'SELECT n.id, n.status, n.review_reason AS reason, u.email, u.display_name AS name, o.title, (SELECT g.expires_at FROM access_grants g WHERE g.nda_request_id = n.id AND g.revoked_at IS NULL ORDER BY g.granted_at DESC LIMIT 1) AS expiresAt FROM nda_requests n JOIN users u ON u.id = n.user_id JOIN opportunities o ON o.id = n.opportunity_id WHERE n.id = ?',
    )
    .bind(requestId)
    .first();
}

export function findFormSubmission(
  db: D1Database,
  submissionId: string,
): Promise<{ id: string; dataJson: string; formTitle: string; opportunityTitle: string | null } | null> {
  return db
    .prepare(
      'SELECT s.id,s.data_json AS dataJson,f.title AS formTitle,o.title AS opportunityTitle FROM managed_form_submissions s JOIN managed_forms f ON f.id=s.form_id LEFT JOIN opportunities o ON o.id=s.opportunity_id WHERE s.id=? LIMIT 1',
    )
    .bind(submissionId)
    .first();
}
