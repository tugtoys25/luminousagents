/** SQL for managed forms and their submissions. */
type Row = Record<string, unknown>;

export type SubmissionFilters = [string, string, string, string, string, string];

const SUBMISSION_SELECT =
  's.id, s.data_json AS dataJson, s.status, s.internal_note AS internalNote, s.created_at AS createdAt, s.updated_at AS updatedAt, f.title AS formTitle, f.slug AS formSlug, o.title AS opportunityTitle';
const SUBMISSION_FROM =
  'FROM managed_form_submissions s JOIN managed_forms f ON f.id = s.form_id LEFT JOIN opportunities o ON o.id = s.opportunity_id';
const SUBMISSION_FILTER =
  "WHERE (? = '' OR s.status = ?) AND (? = '' OR f.slug = ?) AND (? = '' OR s.data_json LIKE ? ESCAPE '\\')";

export async function listForms(db: D1Database): Promise<Row[]> {
  const r = await db
    .prepare(
      'SELECT id,slug,title,description,fields_json AS fieldsJson,notification_enabled AS notificationEnabled,status,updated_at AS updatedAt FROM managed_forms ORDER BY updated_at DESC LIMIT 200',
    )
    .all<Row>();
  return r.results ?? [];
}

/** `limit` is an internal constant (200 for the list, 5000 for export), never user input. */
export async function querySubmissions(db: D1Database, filters: SubmissionFilters, limit: 200 | 5000): Promise<Row[]> {
  const r = await db
    .prepare(`SELECT ${SUBMISSION_SELECT} ${SUBMISSION_FROM} ${SUBMISSION_FILTER} ORDER BY s.created_at DESC LIMIT ${limit}`)
    .bind(...filters)
    .all<Row>();
  return r.results ?? [];
}

export function findSubmission(db: D1Database, id: string): Promise<{ id: string; status: string } | null> {
  return db
    .prepare('SELECT id, status FROM managed_form_submissions WHERE id = ?')
    .bind(id)
    .first<{ id: string; status: string }>();
}

/** Updates only the provided fields; `updated_at` is always set. */
export async function updateSubmission(
  db: D1Database,
  submissionId: string,
  patch: { status?: string | undefined; internalNote?: string | undefined },
  timestamp: string,
): Promise<void> {
  const sets = ['updated_at = ?'];
  const values: string[] = [timestamp];
  if (patch.status) {
    sets.push('status = ?');
    values.push(patch.status);
  }
  if (patch.internalNote !== undefined) {
    sets.push('internal_note = ?');
    values.push(patch.internalNote);
  }
  await db
    .prepare(`UPDATE managed_form_submissions SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...values, submissionId)
    .run();
}

export interface FormInput {
  slug: string;
  title: string;
  description: string;
  fieldsJson: string;
  notificationEnabled: boolean;
  status: string;
}

/** Throws on a slug uniqueness conflict; callers translate that into a 409. */
export async function upsertForm(db: D1Database, formId: string, d: FormInput, staffId: string, timestamp: string): Promise<void> {
  await db
    .prepare(
      'INSERT INTO managed_forms (id,slug,title,description,fields_json,notification_enabled,status,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET slug=excluded.slug,title=excluded.title,description=excluded.description,fields_json=excluded.fields_json,notification_enabled=excluded.notification_enabled,status=excluded.status,updated_by=excluded.updated_by,updated_at=excluded.updated_at',
    )
    .bind(formId, d.slug, d.title, d.description, d.fieldsJson, d.notificationEnabled ? 1 : 0, d.status, staffId, staffId, timestamp, timestamp)
    .run();
}
