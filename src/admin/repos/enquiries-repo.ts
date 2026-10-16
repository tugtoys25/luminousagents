/** SQL for the staff enquiry inbox. Brokers are scoped to enquiries assigned to them via `brokerOnly`. */
type Row = Record<string, unknown>;

export interface EnquiryRef {
  id: string;
  status: string;
  assignedTo: string | null;
}

export async function listAssignees(db: D1Database): Promise<Row[]> {
  const result = await db
    .prepare(
      "SELECT id, display_name AS displayName, email, role FROM users WHERE user_type = 'staff' AND status = 'active' AND role IN ('admin','editor','broker','publisher','super_admin') ORDER BY display_name COLLATE NOCASE LIMIT 200",
    )
    .all<Row>();
  return result.results ?? [];
}

export async function listEnquiries(
  db: D1Database,
  f: { status: string; q: string; brokerOnly: 0 | 1; staffId: string },
): Promise<Row[]> {
  const like = `%${f.q}%`;
  const result = await db
    .prepare(
      "SELECT e.id, e.name, e.email, e.company, e.message, e.status, e.assigned_to AS assignedTo, e.opportunity_id AS opportunityId, e.created_at AS createdAt, e.updated_at AS updatedAt, o.title AS opportunityTitle FROM enquiries e LEFT JOIN opportunities o ON o.id = e.opportunity_id WHERE (? = '' OR e.status = ?) AND (? = '' OR e.name LIKE ? OR e.email LIKE ? OR e.company LIKE ?) AND (? = 0 OR e.assigned_to = ?) ORDER BY e.created_at DESC LIMIT 100",
    )
    .bind(f.status, f.status, f.q, like, like, like, f.brokerOnly, f.staffId)
    .all<Row>();
  return result.results ?? [];
}

export function getEnquiry(db: D1Database, id: string, brokerOnly: 0 | 1, staffId: string): Promise<Row | null> {
  return db
    .prepare('SELECT * FROM enquiries WHERE id = ? AND (? = 0 OR assigned_to = ?)')
    .bind(id, brokerOnly, staffId)
    .first<Row>();
}

export async function listNotes(db: D1Database, enquiryId: string): Promise<Row[]> {
  const notes = await db
    .prepare(
      'SELECT n.id, n.note, n.created_at AS createdAt, u.email AS authorEmail FROM enquiry_notes n JOIN users u ON u.id = n.author_id WHERE n.enquiry_id = ? ORDER BY n.created_at DESC LIMIT 100',
    )
    .bind(enquiryId)
    .all<Row>();
  return notes.results ?? [];
}

export function findEnquiryRef(db: D1Database, id: string, brokerOnly: 0 | 1, staffId: string): Promise<EnquiryRef | null> {
  return db
    .prepare('SELECT id, status, assigned_to AS assignedTo FROM enquiries WHERE id = ? AND (? = 0 OR assigned_to = ?)')
    .bind(id, brokerOnly, staffId)
    .first<EnquiryRef>();
}

export async function enquiryVisible(db: D1Database, id: string, brokerOnly: 0 | 1, staffId: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT id FROM enquiries WHERE id = ? AND (? = 0 OR assigned_to = ?)')
    .bind(id, brokerOnly, staffId)
    .first();
  return Boolean(row);
}

/** Updates only provided fields. Pass `assignedTo: undefined` to leave the assignee alone, `null` to clear it. */
export async function updateEnquiry(
  db: D1Database,
  enquiryId: string,
  patch: { status?: string | undefined; assignedTo?: string | null | undefined },
  hasAssignee: boolean,
  timestamp: string,
): Promise<void> {
  const sets: string[] = ['updated_at = ?'];
  const values: (string | null)[] = [timestamp];
  if (patch.status) {
    sets.push('status = ?');
    values.push(patch.status);
  }
  if (hasAssignee) {
    sets.push('assigned_to = ?');
    values.push(patch.assignedTo ?? null);
  }
  values.push(enquiryId);
  await db
    .prepare(`UPDATE enquiries SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run();
}

export async function insertNote(
  db: D1Database,
  n: { id: string; enquiryId: string; authorId: string; note: string; timestamp: string },
): Promise<void> {
  await db
    .prepare('INSERT INTO enquiry_notes (id, enquiry_id, author_id, note, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(n.id, n.enquiryId, n.authorId, n.note, n.timestamp)
    .run();
}
