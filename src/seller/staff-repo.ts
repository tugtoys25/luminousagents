/** All SQL for the staff seller-enquiry workflow. Brokers are scoped to enquiries assigned to them (`brokerOnly`). */
type Row = Record<string, unknown>;
export interface Scope { brokerOnly: 0 | 1; staffId: string }
export interface EnquiryRef { id: string; reference: string; status: string; assignedTo: string | null; version: number; firstResponseAt: string | null }

const AUDIT_SQL =
  "INSERT INTO audit_logs (id, actor_user_id, actor_type, action, entity_type, entity_id, request_id, details_json, created_at) VALUES (?, ?, 'staff', ?, 'seller_enquiry', ?, ?, ?, ?)";
// Conditional variants: only write when the immediately preceding statement in the batch changed a row.
const AUDIT_IF_CHANGED_SQL =
  "INSERT INTO audit_logs (id, actor_user_id, actor_type, action, entity_type, entity_id, request_id, details_json, created_at) SELECT ?, ?, 'staff', ?, 'seller_enquiry', ?, ?, ?, ? WHERE changes() > 0";
const HISTORY_IF_CHANGED_SQL =
  'INSERT INTO seller_enquiry_status_history (id, enquiry_id, from_status, to_status, from_assignee, to_assignee, reason, actor_user_id, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() > 0';

export function findRef(db: D1Database, reference: string, s: Scope): Promise<EnquiryRef | null> {
  return db
    .prepare('SELECT id, reference, status, assigned_to AS assignedTo, version, first_response_at AS firstResponseAt FROM seller_enquiries WHERE reference = ? AND (? = 0 OR assigned_to = ?)')
    .bind(reference, s.brokerOnly, s.staffId)
    .first<EnquiryRef>();
}

export interface ListFilter {
  status?: string | undefined; assigned?: string | undefined; country?: string | undefined; assetType?: string | undefined;
  from?: string | undefined; to?: string | undefined; due?: string | undefined; q?: string | undefined; page: number;
}
export const PAGE_SIZE = 25;

export async function listEnquiries(db: D1Database, f: ListFilter, s: Scope, nowIso: string): Promise<{ rows: Row[]; total: number }> {
  const dueBefore = f.due === 'overdue' ? nowIso : f.due === 'today' ? `${nowIso.slice(0, 10)}T23:59:59.999Z` : '';
  const like = `%${(f.q ?? '').replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const where = `WHERE (? = '' OR e.status = ?)
    AND (? = '' OR (? = 'unassigned' AND e.assigned_to IS NULL) OR e.assigned_to = ?)
    AND (? = '' OR e.asset_country = ? OR e.contact_country = ?)
    AND (? = '' OR e.asset_type = ?)
    AND (? = '' OR e.created_at >= ?) AND (? = '' OR e.created_at < date(?, '+1 day'))
    AND (? = '' OR EXISTS (SELECT 1 FROM staff_tasks t WHERE t.related_entity_type = 'seller_enquiry' AND t.related_entity_id = e.id AND t.status IN ('open','in_progress','blocked') AND t.due_at IS NOT NULL AND t.due_at <= ?))
    AND (? = '' OR e.reference LIKE ? ESCAPE '\\' OR e.contact_name LIKE ? ESCAPE '\\' OR e.organisation LIKE ? ESCAPE '\\' OR e.email LIKE ? ESCAPE '\\')
    AND (? = 0 OR e.assigned_to = ?)`;
  const binds = [
    f.status ?? '', f.status ?? '', f.assigned ?? '', f.assigned ?? '', f.assigned ?? '', f.country ?? '', f.country ?? '', f.country ?? '',
    f.assetType ?? '', f.assetType ?? '', f.from ?? '', f.from ?? '', f.to ?? '', f.to ?? '', dueBefore, dueBefore,
    f.q ?? '', like, like, like, like, s.brokerOnly, s.staffId,
  ];
  // The list deliberately omits email, telephone and free-text fields.
  const rows = await db
    .prepare(
      `SELECT e.reference, e.contact_name AS contactName, e.organisation, e.status, e.asset_type AS assetType, e.asset_country AS assetCountry,
        e.contact_country AS contactCountry, e.asset_name_confidential AS assetNameConfidential, e.assigned_to AS assignedTo,
        u.display_name AS assignedName, e.created_at AS createdAt,
        (SELECT MIN(t.due_at) FROM staff_tasks t WHERE t.related_entity_type = 'seller_enquiry' AND t.related_entity_id = e.id AND t.status IN ('open','in_progress','blocked')) AS nextFollowupAt
       FROM seller_enquiries e LEFT JOIN users u ON u.id = e.assigned_to ${where}
       ORDER BY e.created_at DESC, e.id DESC LIMIT ${PAGE_SIZE} OFFSET ?`,
    )
    .bind(...binds, (f.page - 1) * PAGE_SIZE)
    .all<Row>();
  const total = await db.prepare(`SELECT COUNT(*) AS total FROM seller_enquiries e ${where}`).bind(...binds).first<{ total: number }>();
  return { rows: rows.results ?? [], total: total?.total ?? 0 };
}

/** Full detail without the idempotency hash, IP hash or raw original submission. */
export function getEnquiry(db: D1Database, reference: string, s: Scope): Promise<Row | null> {
  return db
    .prepare(
      `SELECT e.id, e.reference, e.contact_name AS contactName, e.contact_role AS contactRole, e.contact_role_other AS contactRoleOther, e.email, e.telephone,
        e.organisation, e.preferred_contact_method AS preferredContactMethod, e.contact_country AS contactCountry, e.asset_type AS assetType,
        e.asset_type_other AS assetTypeOther, e.asset_country AS assetCountry, e.asset_name AS assetName, e.asset_name_confidential AS assetNameConfidential,
        e.asset_description AS assetDescription, e.operating_status AS operatingStatus, e.authority_declaration AS authorityDeclaration,
        e.sale_reason AS saleReason, e.sale_timing AS saleTiming, e.asking_price_text AS askingPriceText, e.currency, e.currency_other AS currencyOther,
        e.additional_information AS additionalInformation, e.confidentiality_preference AS confidentialityPreference,
        e.privacy_notice_version AS privacyNoticeVersion, e.privacy_acknowledged_at AS privacyAcknowledgedAt,
        e.accuracy_declaration_version AS accuracyDeclarationVersion, e.accuracy_declared_at AS accuracyDeclaredAt,
        e.marketing_consent AS marketingConsent, e.marketing_consent_text_version AS marketingConsentTextVersion, e.marketing_consent_at AS marketingConsentAt,
        e.marketing_consent_withdrawn_at AS marketingConsentWithdrawnAt, e.status, e.assigned_to AS assignedTo, u.display_name AS assignedName,
        e.first_response_at AS firstResponseAt, e.closed_at AS closedAt, e.closure_reason AS closureReason, e.version, e.created_at AS createdAt, e.updated_at AS updatedAt
       FROM seller_enquiries e LEFT JOIN users u ON u.id = e.assigned_to WHERE e.reference = ? AND e.anonymised_at IS NULL AND (? = 0 OR e.assigned_to = ?)`,
    )
    .bind(reference, s.brokerOnly, s.staffId)
    .first<Row>();
}

const all = async (stmt: D1PreparedStatement): Promise<Row[]> => (await stmt.all<Row>()).results ?? [];
export const listNotes = (db: D1Database, id: string) =>
  all(db.prepare('SELECT n.id, n.classification, n.note, n.created_at AS createdAt, u.display_name AS authorName FROM seller_enquiry_notes n JOIN users u ON u.id = n.author_id WHERE n.enquiry_id = ? ORDER BY n.created_at DESC LIMIT 200').bind(id));
export const listCommunications = (db: D1Database, id: string) =>
  all(db.prepare('SELECT c.id, c.direction, c.channel, c.outcome, c.summary, c.occurred_at AS occurredAt, c.actor_type AS actorType, c.template_id AS templateId, c.delivery_status AS deliveryStatus, u.display_name AS actorName FROM seller_communications c LEFT JOIN users u ON u.id = c.actor_user_id WHERE c.enquiry_id = ? ORDER BY c.occurred_at DESC LIMIT 200').bind(id));
export const listFollowups = (db: D1Database, id: string) =>
  all(db.prepare("SELECT t.id, t.title, t.task_type AS taskType, t.status, t.priority, t.due_at AS dueAt, t.outcome, t.completed_at AS completedAt, t.reminder_count AS reminderCount, t.escalated_at AS escalatedAt, u.display_name AS assignedName FROM staff_tasks t LEFT JOIN users u ON u.id = t.assigned_to WHERE t.related_entity_type = 'seller_enquiry' AND t.related_entity_id = ? ORDER BY (t.status IN ('done','cancelled')), t.due_at LIMIT 100").bind(id));
export const listHistory = (db: D1Database, id: string) =>
  all(db.prepare('SELECT h.from_status AS fromStatus, h.to_status AS toStatus, h.from_assignee AS fromAssignee, h.to_assignee AS toAssignee, h.reason, h.created_at AS createdAt, u.display_name AS actorName FROM seller_enquiry_status_history h JOIN users u ON u.id = h.actor_user_id WHERE h.enquiry_id = ? ORDER BY h.created_at DESC LIMIT 100').bind(id));
export const listAuditFor = (db: D1Database, id: string) =>
  all(db.prepare("SELECT a.action, a.actor_type AS actorType, a.created_at AS createdAt, u.display_name AS actorName FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id WHERE a.entity_type = 'seller_enquiry' AND a.entity_id = ? ORDER BY a.created_at DESC, a.id DESC LIMIT 100").bind(id));
export const latestQualification = (db: D1Database, id: string) =>
  db.prepare('SELECT q.checklist_json AS checklistJson, q.outcome, q.next_action AS nextAction, q.compliance_routed AS complianceRouted, q.created_at AS createdAt, u.display_name AS reviewerName FROM seller_enquiry_qualifications q JOIN users u ON u.id = q.reviewer_id WHERE q.enquiry_id = ? ORDER BY q.created_at DESC, q.id DESC LIMIT 1').bind(id).first<Row>();
export const hasPassingQualification = async (db: D1Database, id: string): Promise<boolean> =>
  Boolean(await db.prepare("SELECT 1 AS ok FROM seller_enquiry_qualifications WHERE enquiry_id = ? AND outcome = 'PASS' ORDER BY created_at DESC, id DESC LIMIT 1").bind(id).first());

export interface Actor { id: string; requestId: string; ts: string }

/** Optimistic-concurrency update: history and audit rows are written only if the version still matched. */
export async function applyStatusOrAssignment(
  db: D1Database,
  p: Actor & { enquiry: EnquiryRef; toStatus: string; toAssignee: string | null; reason: string | null; closing: boolean; ids: [string, string]; action: string },
): Promise<boolean> {
  const e = p.enquiry;
  const results = await db.batch([
    db
      .prepare(
        `UPDATE seller_enquiries SET status = ?, assigned_to = ?, version = version + 1, updated_at = ?,
           closed_at = CASE WHEN ? = 1 THEN ? ELSE closed_at END, closure_reason = CASE WHEN ? = 1 THEN ? ELSE closure_reason END
         WHERE id = ? AND version = ?`,
      )
      .bind(p.toStatus, p.toAssignee, p.ts, p.closing ? 1 : 0, p.ts, p.closing ? 1 : 0, p.reason, e.id, e.version),
    db.prepare(HISTORY_IF_CHANGED_SQL).bind(p.ids[0], e.id, e.status, p.toStatus, e.assignedTo, p.toAssignee, p.reason, p.id, p.ts),
    db.prepare(AUDIT_IF_CHANGED_SQL).bind(p.ids[1], p.id, p.action, e.id, p.requestId,
      JSON.stringify({ reference: e.reference, from: e.status, to: p.toStatus, fromAssignee: e.assignedTo, toAssignee: p.toAssignee, hasReason: Boolean(p.reason) }), p.ts),
  ]);
  return (results[0]?.meta?.changes ?? 0) > 0;
}

export async function insertNote(db: D1Database, p: Actor & { enquiry: EnquiryRef; noteId: string; auditId: string; classification: string; note: string }): Promise<void> {
  await db.batch([
    db.prepare('INSERT INTO seller_enquiry_notes (id, enquiry_id, author_id, classification, note, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(p.noteId, p.enquiry.id, p.id, p.classification, p.note, p.ts),
    // The audit record carries the note id and classification only, never the note text.
    db.prepare(AUDIT_SQL).bind(p.auditId, p.id, 'seller_enquiry.note_added', p.enquiry.id, p.requestId, JSON.stringify({ reference: p.enquiry.reference, noteId: p.noteId, classification: p.classification }), p.ts),
  ]);
}

export async function insertCommunication(
  db: D1Database,
  p: Actor & { enquiry: EnquiryRef; commId: string; auditId: string; direction: string; channel: string; outcome: string; summary: string; occurredAt: string },
): Promise<void> {
  const firstResponse = p.direction === 'OUTBOUND' && !p.enquiry.firstResponseAt;
  await db.batch([
    db.prepare("INSERT INTO seller_communications (id, enquiry_id, direction, channel, occurred_at, actor_type, actor_user_id, summary, outcome, delivery_status, created_at) VALUES (?, ?, ?, ?, ?, 'staff', ?, ?, ?, 'NOT_APPLICABLE', ?)")
      .bind(p.commId, p.enquiry.id, p.direction, p.channel, p.occurredAt, p.id, p.summary, p.outcome, p.ts),
    db.prepare('UPDATE seller_enquiries SET first_response_at = COALESCE(first_response_at, ?), updated_at = ? WHERE id = ? AND ? = 1').bind(p.occurredAt, p.ts, p.enquiry.id, firstResponse ? 1 : 0),
    db.prepare(AUDIT_SQL).bind(p.auditId, p.id, 'seller_enquiry.communication_recorded', p.enquiry.id, p.requestId,
      JSON.stringify({ reference: p.enquiry.reference, commId: p.commId, direction: p.direction, channel: p.channel, outcome: p.outcome, firstResponse }), p.ts),
  ]);
}

export async function insertFollowup(
  db: D1Database,
  p: Actor & { enquiry: EnquiryRef; taskId: string; auditId: string; title: string; taskType: string; dueAt: string; priority: string; assignedTo: string | null },
): Promise<void> {
  await db.batch([
    db.prepare("INSERT INTO staff_tasks (id, title, description, status, priority, due_at, assigned_to, related_entity_type, related_entity_id, created_by, created_at, updated_at, task_type) VALUES (?, ?, '', 'open', ?, ?, ?, 'seller_enquiry', ?, ?, ?, ?, ?)")
      .bind(p.taskId, p.title, p.priority, p.dueAt, p.assignedTo, p.enquiry.id, p.id, p.ts, p.ts, p.taskType),
    db.prepare(AUDIT_SQL).bind(p.auditId, p.id, 'seller_enquiry.followup_created', p.enquiry.id, p.requestId,
      JSON.stringify({ reference: p.enquiry.reference, taskId: p.taskId, taskType: p.taskType, dueAt: p.dueAt, assignedTo: p.assignedTo }), p.ts),
  ]);
}

/** Completes only a task that belongs to this enquiry (prevents cross-record id substitution). */
export async function completeFollowup(db: D1Database, p: Actor & { enquiry: EnquiryRef; taskId: string; auditId: string; outcome: string }): Promise<boolean> {
  const results = await db.batch([
    db.prepare("UPDATE staff_tasks SET status = 'done', outcome = ?, completed_at = ?, updated_at = ? WHERE id = ? AND related_entity_type = 'seller_enquiry' AND related_entity_id = ? AND status IN ('open','in_progress','blocked')")
      .bind(p.outcome, p.ts, p.ts, p.taskId, p.enquiry.id),
    db.prepare(AUDIT_IF_CHANGED_SQL).bind(p.auditId, p.id, 'seller_enquiry.followup_completed', p.enquiry.id, p.requestId, JSON.stringify({ reference: p.enquiry.reference, taskId: p.taskId }), p.ts),
  ]);
  return (results[0]?.meta?.changes ?? 0) > 0;
}

export async function insertQualification(
  db: D1Database,
  p: Actor & { enquiry: EnquiryRef; qualId: string; auditId: string; checklistJson: string; outcome: string; nextAction: string; complianceRouted: boolean },
): Promise<void> {
  await db.batch([
    db.prepare('INSERT INTO seller_enquiry_qualifications (id, enquiry_id, reviewer_id, checklist_json, outcome, next_action, compliance_routed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(p.qualId, p.enquiry.id, p.id, p.checklistJson, p.outcome, p.nextAction, p.complianceRouted ? 1 : 0, p.ts),
    db.prepare(AUDIT_SQL).bind(p.auditId, p.id, 'seller_enquiry.qualification_recorded', p.enquiry.id, p.requestId,
      JSON.stringify({ reference: p.enquiry.reference, qualId: p.qualId, outcome: p.outcome, complianceRouted: p.complianceRouted }), p.ts),
  ]);
}

/** Records the acknowledgement as a system communication. INSERT OR IGNORE on the job id keeps retries idempotent. */
export async function recordSystemCommunication(db: D1Database, p: { id: string; enquiryId: string; templateId: string; jobId: string; ts: string }): Promise<void> {
  await db
    .prepare("INSERT OR IGNORE INTO seller_communications (id, enquiry_id, direction, channel, occurred_at, actor_type, template_id, summary, outcome, delivery_status, notification_job_id, created_at) VALUES (?, ?, 'OUTBOUND', 'EMAIL', ?, 'system', ?, 'Automated acknowledgement accepted by the email provider (inbox delivery not confirmed).', 'SENT', 'ACCEPTED_BY_PROVIDER', ?, ?)")
    .bind(p.id, p.enquiryId, p.ts, p.templateId, p.jobId, p.ts)
    .run();
}

/** Owners may be brokers or managers; editors, publishers and auditors cannot own seller enquiries. */
export async function isAssignableOwner(db: D1Database, userId: string): Promise<boolean> {
  return Boolean(await db.prepare("SELECT id FROM users WHERE id = ? AND user_type = 'staff' AND status = 'active' AND role IN ('broker','admin','super_admin')").bind(userId).first());
}

export interface DueFollowup { taskId: string; enquiryId: string; dueAt: string; assignedTo: string | null; escalatedAt: string | null }
export async function listDueFollowups(db: D1Database, nowIso: string, limit: number): Promise<DueFollowup[]> {
  const r = await db
    .prepare(
      `SELECT t.id AS taskId, t.related_entity_id AS enquiryId, t.due_at AS dueAt, t.assigned_to AS assignedTo, t.escalated_at AS escalatedAt
       FROM staff_tasks t JOIN seller_enquiries e ON e.id = t.related_entity_id
       WHERE t.related_entity_type = 'seller_enquiry' AND t.status IN ('open','in_progress','blocked') AND t.due_at IS NOT NULL AND t.due_at <= ?
         AND e.status NOT IN ('CONVERTED','DECLINED','CLOSED') ORDER BY t.due_at LIMIT ?`,
    )
    .bind(nowIso, limit)
    .all<DueFollowup>();
  return r.results ?? [];
}

/** Creates the reminder job once per dedupe key (unique index) and bumps reminder state only when it was created. */
export async function enqueueReminderJob(db: D1Database, p: { jobId: string; taskId: string; enquiryId: string; dedupeKey: string; escalate: boolean; ts: string }): Promise<boolean> {
  const results = await db.batch([
    db.prepare("INSERT OR IGNORE INTO notification_jobs (id, job_type, payload_json, status, attempts, available_at, created_at, updated_at, dedupe_key) VALUES (?, 'seller.followup_due', ?, 'queued', 0, ?, ?, ?, ?)")
      .bind(p.jobId, JSON.stringify({ taskId: p.taskId, enquiryId: p.enquiryId, escalate: p.escalate }), p.ts, p.ts, p.ts, p.dedupeKey),
    db.prepare('UPDATE staff_tasks SET reminder_count = reminder_count + 1, last_reminder_at = ?, escalated_at = CASE WHEN ? = 1 THEN ? ELSE escalated_at END WHERE id = ? AND changes() > 0')
      .bind(p.ts, p.escalate ? 1 : 0, p.ts, p.taskId),
  ]);
  return (results[0]?.meta?.changes ?? 0) > 0;
}

export interface FollowupForReminder {
  taskId: string; taskStatus: string; title: string; dueAt: string; reference: string; contactName: string; enquiryStatus: string;
  assigneeName: string | null; assigneeEmail: string | null; lastContactAt: string | null;
}
export function findFollowupForReminder(db: D1Database, taskId: string): Promise<FollowupForReminder | null> {
  return db
    .prepare(
      `SELECT t.id AS taskId, t.status AS taskStatus, t.title, t.due_at AS dueAt, e.reference, e.contact_name AS contactName, e.status AS enquiryStatus,
        u.display_name AS assigneeName, u.email AS assigneeEmail,
        (SELECT MAX(c.occurred_at) FROM seller_communications c WHERE c.enquiry_id = e.id AND c.actor_type = 'staff') AS lastContactAt
       FROM staff_tasks t JOIN seller_enquiries e ON e.id = t.related_entity_id LEFT JOIN users u ON u.id = t.assigned_to
       WHERE t.id = ? AND t.related_entity_type = 'seller_enquiry'`,
    )
    .bind(taskId)
    .first<FollowupForReminder>();
}
