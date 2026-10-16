/** SQL for the notification-job admin routes. */
export interface NotificationJobRef {
  id: string;
  jobType: string;
  status: string;
}

export async function listRecentJobs(db: D1Database, limit = 100): Promise<unknown[]> {
  const result = await db
    .prepare(
      'SELECT id, job_type AS jobType, status, attempts, available_at AS availableAt, created_at AS createdAt, updated_at AS updatedAt FROM notification_jobs ORDER BY created_at DESC LIMIT ?',
    )
    .bind(limit)
    .all();
  return result.results ?? [];
}

export function findJob(db: D1Database, id: string): Promise<NotificationJobRef | null> {
  return db
    .prepare('SELECT id, job_type AS jobType, status FROM notification_jobs WHERE id = ?')
    .bind(id)
    .first<NotificationJobRef>();
}

export async function requeueJob(db: D1Database, id: string, timestamp: string): Promise<void> {
  await db
    .prepare("UPDATE notification_jobs SET status = 'queued', available_at = ?, updated_at = ? WHERE id = ?")
    .bind(timestamp, timestamp, id)
    .run();
}
