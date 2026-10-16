/** SQL for staff tasks. Brokers are scoped to tasks assigned to them via `brokerOnly`. */
export { isActiveStaff } from './staff-repo';

export interface TaskRef {
  id: string;
  status: string;
  assignedTo: string | null;
}

export async function listTasks(
  db: D1Database,
  f: { status: string; assignedTo: string; brokerOnly: 0 | 1; staffId: string },
): Promise<unknown[]> {
  const result = await db
    .prepare(
      `SELECT t.id, t.title, t.description, t.status, t.priority, t.due_at AS dueAt, t.assigned_to AS assignedTo, t.related_entity_type AS relatedEntityType, t.related_entity_id AS relatedEntityId, t.created_at AS createdAt, t.updated_at AS updatedAt, u.display_name AS assigneeName, u.email AS assigneeEmail FROM staff_tasks t LEFT JOIN users u ON u.id = t.assigned_to WHERE (? = '' OR t.status = ?) AND (? = '' OR t.assigned_to = ?) AND (? = 0 OR t.assigned_to = ?) ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, t.due_at IS NULL, t.due_at ASC, t.updated_at DESC LIMIT 200`,
    )
    .bind(f.status, f.status, f.assignedTo, f.assignedTo, f.brokerOnly, f.staffId)
    .all();
  return result.results ?? [];
}

export interface NewTask {
  id: string;
  title: string;
  description: string;
  priority: string;
  dueAt: string | null;
  assignedTo: string | null;
  relatedEntityType: string | null;
  relatedEntityId: string | null;
  createdBy: string;
  timestamp: string;
}

export async function insertTask(db: D1Database, t: NewTask): Promise<void> {
  await db
    .prepare(
      "INSERT INTO staff_tasks (id,title,description,status,priority,due_at,assigned_to,related_entity_type,related_entity_id,created_by,created_at,updated_at) VALUES (?,?,?,'open',?,?,?,?,?,?,?,?)",
    )
    .bind(
      t.id,
      t.title,
      t.description,
      t.priority,
      t.dueAt,
      t.assignedTo,
      t.relatedEntityType,
      t.relatedEntityId,
      t.createdBy,
      t.timestamp,
      t.timestamp,
    )
    .run();
}

export function findTaskFor(
  db: D1Database,
  taskId: string,
  brokerOnly: 0 | 1,
  staffId: string,
): Promise<TaskRef | null> {
  return db
    .prepare('SELECT id, status, assigned_to AS assignedTo FROM staff_tasks WHERE id = ? AND (? = 0 OR assigned_to = ?)')
    .bind(taskId, brokerOnly, staffId)
    .first<TaskRef>();
}

export interface TaskPatch {
  title?: string | undefined;
  description?: string | undefined;
  status?: string | undefined;
  priority?: string | undefined;
  dueAt?: string | null | undefined;
  assignedTo?: string | null | undefined;
}

/** Partial update: omitted fields are left unchanged; reopening clears completed_at, 'done' stamps it. */
export async function updateTask(db: D1Database, taskId: string, input: TaskPatch, timestamp: string): Promise<void> {
  await db
    .prepare(
      'UPDATE staff_tasks SET title=COALESCE(?,title), description=COALESCE(?,description), status=COALESCE(?,status), priority=COALESCE(?,priority), due_at=CASE WHEN ? = 1 THEN ? ELSE due_at END, assigned_to=CASE WHEN ? = 1 THEN ? ELSE assigned_to END, completed_at=CASE WHEN ? = 1 THEN ? WHEN ? = 1 THEN NULL ELSE completed_at END, updated_at=? WHERE id=?',
    )
    .bind(
      input.title ?? null,
      input.description ?? null,
      input.status ?? null,
      input.priority ?? null,
      Number(input.dueAt !== undefined),
      input.dueAt ?? null,
      Number(input.assignedTo !== undefined),
      input.assignedTo ?? null,
      Number(input.status === 'done'),
      timestamp,
      Number(input.status !== undefined && input.status !== 'done'),
      timestamp,
      taskId,
    )
    .run();
}
