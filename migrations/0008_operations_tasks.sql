CREATE TABLE IF NOT EXISTS staff_tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','blocked','done','cancelled')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  due_at TEXT,
  assigned_to TEXT REFERENCES users(id),
  related_entity_type TEXT,
  related_entity_id TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_staff_tasks_status_due ON staff_tasks(status, due_at);
CREATE INDEX IF NOT EXISTS idx_staff_tasks_assignee ON staff_tasks(assigned_to, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_staff_tasks_related ON staff_tasks(related_entity_type, related_entity_id);
CREATE INDEX IF NOT EXISTS idx_notification_jobs_recovery ON notification_jobs(status, available_at, created_at);
