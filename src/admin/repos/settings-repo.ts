/** SQL for platform settings. Statement builders return unexecuted statements so routes can batch them atomically. */
export interface SettingRow {
  key: string;
  value: string;
  updatedAt: string;
}

export async function listSettings(db: D1Database): Promise<SettingRow[]> {
  const rows = await db
    .prepare('SELECT setting_key AS key,value_json AS value,updated_at AS updatedAt FROM platform_settings ORDER BY setting_key')
    .all<SettingRow>();
  return rows.results ?? [];
}

export function upsertSettingStatement(
  db: D1Database,
  key: string,
  value: unknown,
  staffId: string,
  timestamp: string,
): D1PreparedStatement {
  return db
    .prepare(
      'INSERT INTO platform_settings (setting_key,value_json,updated_by,updated_at) VALUES (?,?,?,?) ON CONFLICT(setting_key) DO UPDATE SET value_json=excluded.value_json,updated_by=excluded.updated_by,updated_at=excluded.updated_at',
    )
    .bind(key, JSON.stringify(value), staffId, timestamp);
}

export function settingsAuditStatement(
  db: D1Database,
  a: { auditId: string; staffId: string; requestId: string; keys: string[]; timestamp: string },
): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO audit_logs (id,actor_user_id,actor_type,action,entity_type,entity_id,request_id,details_json,created_at) VALUES (?,?,'staff','platform.settings_updated','platform_settings','global',?,?,?)",
    )
    .bind(a.auditId, a.staffId, a.requestId, JSON.stringify({ keys: a.keys }), a.timestamp);
}

/** Raw value_json for the given keys. Callers parse and tolerate malformed values. */
export async function listSettingsByKeys(db: D1Database, keys: readonly string[]): Promise<Array<{ key: string; value: string }>> {
  if (keys.length === 0) return [];
  const rows = await db
    .prepare(`SELECT setting_key AS key, value_json AS value FROM platform_settings WHERE setting_key IN (${keys.map(() => '?').join(',')})`)
    .bind(...keys)
    .all<{ key: string; value: string }>();
  return rows.results ?? [];
}

/** Raw value_json for one key, or null when unset. */
export async function readSettingRaw(db: D1Database, key: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT value_json AS value FROM platform_settings WHERE setting_key = ?')
    .bind(key)
    .first<{ value: string }>();
  return row ? row.value : null;
}
