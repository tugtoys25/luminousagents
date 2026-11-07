/** All SQL for the control plane (Super API) support. No HTTP here. */
export interface SuperDb {
  DB: D1Database;
}

export type StateKey = 'site_access' | 'storage_limit';

export async function consumeNonce(db: D1Database, credentialId: string, nonce: string, now: number): Promise<boolean> {
  await db.prepare('DELETE FROM super_api_nonces WHERE created_at < ?').bind(now - 10 * 60_000).run().catch(() => undefined);
  // One atomic statement: the primary key decides who got there first, so two simultaneous requests cannot both pass.
  const result = await db
    .prepare('INSERT INTO super_api_nonces (credential_id, nonce, created_at) VALUES (?, ?, ?) ON CONFLICT(credential_id, nonce) DO NOTHING')
    .bind(credentialId, nonce, now)
    .run();
  return result.meta.changes > 0;
}

export async function consumeRateSlot(db: D1Database, credentialId: string, now: number, max: number): Promise<boolean> {
  await db.prepare('DELETE FROM super_api_rate_limits WHERE created_at < ?').bind(now - 60_000).run().catch(() => undefined);
  const row = await db
    .prepare('SELECT COUNT(*) AS c FROM super_api_rate_limits WHERE credential_id = ? AND created_at >= ?')
    .bind(credentialId, now - 60_000)
    .first<{ c: number }>();
  if ((row?.c ?? 0) >= max) return false;
  await db.prepare('INSERT INTO super_api_rate_limits (credential_id, created_at) VALUES (?, ?)').bind(credentialId, now).run();
  return true;
}

export async function readState(db: D1Database, key: StateKey): Promise<{ value: string; generation: number } | null> {
  return db.prepare('SELECT value, generation FROM platform_state WHERE key = ?').bind(key).first<{ value: string; generation: number }>();
}

/** Stores a state value only when its generation is newer than the stored one. Returns whether it was applied. */
export async function writeState(db: D1Database, key: StateKey, value: string, generation: number, now: string): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO platform_state (key, value, generation, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, generation = excluded.generation, updated_at = excluded.updated_at
       WHERE platform_state.generation < excluded.generation`,
    )
    .bind(key, value, generation, now)
    .run();
  return result.meta.changes > 0;
}

/** Bytes of every stored file this site holds (media library, listing media, data room documents, seller evidence). */
export async function usedBytes(db: D1Database): Promise<number> {
  const row = await db
    .prepare(
      `SELECT (SELECT COALESCE(SUM(byte_size), 0) FROM media_library)
            + (SELECT COALESCE(SUM(byte_size), 0) FROM opportunity_media)
            + (SELECT COALESCE(SUM(byte_size), 0) FROM documents)
            + (SELECT COALESCE(SUM(byte_size), 0) FROM seller_authority_evidence WHERE r2_key IS NOT NULL) AS bytes`,
    )
    .first<{ bytes: number }>();
  return Number(row?.bytes ?? 0);
}

export async function pingDatabase(db: D1Database): Promise<void> {
  await db.prepare('SELECT 1').first();
}
