/** SQL for editable seller policy. Writes are version-checked and audited in the same transaction. */
import { auditIfChangedStmt } from './audit-repo';
import type { Actor } from './seller-repo';
import type { StoredSetting } from './policy';

export async function listPolicyRows(db: D1Database): Promise<Array<StoredSetting & { updatedByName: string | null }>> {
  const r = await db.prepare(`SELECT s.setting_key AS key, s.value_json AS value, s.version, s.updated_at AS updatedAt, u.display_name AS updatedByName
    FROM seller_policy_settings s LEFT JOIN users u ON u.id = s.updated_by`).all<StoredSetting & { updatedByName: string | null }>();
  return r.results ?? [];
}

export interface PolicyChange { key: string; value: unknown; expectedVersion: number; reason: string; auditId: string; auditDetails: Record<string, unknown> }
/** expectedVersion 0 means "no stored value yet" (insert); otherwise the stored version must still match. Returns false on a conflict. */
export async function writePolicy(db: D1Database, p: Actor & PolicyChange): Promise<boolean> {
  const json = JSON.stringify(p.value);
  const write = p.expectedVersion === 0
    ? db.prepare('INSERT OR IGNORE INTO seller_policy_settings (setting_key, value_json, version, updated_by, updated_at) VALUES (?, ?, 1, ?, ?)').bind(p.key, json, p.id, p.ts)
    : db.prepare('UPDATE seller_policy_settings SET value_json = ?, version = version + 1, updated_by = ?, updated_at = ? WHERE setting_key = ? AND version = ?').bind(json, p.id, p.ts, p.key, p.expectedVersion);
  const r = await db.batch([
    write,
    auditIfChangedStmt(db, { id: p.auditId, actorId: p.id, action: 'seller_policy.changed', entityType: 'seller_policy', entityId: p.key, requestId: p.requestId, details: { ...p.auditDetails, reason: p.reason }, ts: p.ts }),
  ]);
  return (r[0]?.meta?.changes ?? 0) > 0;
}

/** Removes the stored value so the environment (or default) applies again. */
export async function resetPolicy(db: D1Database, p: Actor & { key: string; expectedVersion: number; reason: string; auditId: string; auditDetails: Record<string, unknown> }): Promise<boolean> {
  const r = await db.batch([
    db.prepare('DELETE FROM seller_policy_settings WHERE setting_key = ? AND version = ?').bind(p.key, p.expectedVersion),
    auditIfChangedStmt(db, { id: p.auditId, actorId: p.id, action: 'seller_policy.reset', entityType: 'seller_policy', entityId: p.key, requestId: p.requestId, details: { ...p.auditDetails, reason: p.reason }, ts: p.ts }),
  ]);
  return (r[0]?.meta?.changes ?? 0) > 0;
}
