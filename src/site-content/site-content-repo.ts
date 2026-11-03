/** SQL for staff-managed site content. Reads are public (rendered into pages); writes are staff-only and audited by the caller. */
import type { Row, StoredItem } from './types';

interface ItemRow {
  id: string;
  collection: string;
  sortOrder: number;
  enabled: number;
  dataJson: string;
  updatedAt: string;
}

const SELECT = 'SELECT id,collection,sort_order AS sortOrder,enabled,data_json AS dataJson,updated_at AS updatedAt FROM site_content_items';

function toItem(row: ItemRow): StoredItem | null {
  try {
    const data = JSON.parse(row.dataJson) as unknown;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    return { id: row.id, collection: row.collection, sortOrder: row.sortOrder, enabled: row.enabled === 1, data: data as Row, updatedAt: row.updatedAt };
  } catch {
    return null;
  }
}

/** Collections that have been customised, with all their items, in one round trip. */
export async function loadAllStored(db: D1Database): Promise<{ customised: string[]; items: StoredItem[] }> {
  const [marks, rows] = await db.batch<Record<string, unknown>>([
    db.prepare('SELECT collection FROM site_content_collections'),
    db.prepare(`${SELECT} ORDER BY collection, sort_order, created_at`),
  ]);
  const items = ((rows?.results ?? []) as unknown as ItemRow[]).map(toItem).filter((i): i is StoredItem => i !== null);
  return { customised: ((marks?.results ?? []) as Array<{ collection: string }>).map((m) => m.collection), items };
}

export async function isCustomised(db: D1Database, collection: string): Promise<boolean> {
  const row = await db.prepare('SELECT 1 AS x FROM site_content_collections WHERE collection = ?').bind(collection).first();
  return row !== null;
}

export async function listStored(db: D1Database, collection: string): Promise<StoredItem[]> {
  const rows = await db.prepare(`${SELECT} WHERE collection = ? ORDER BY sort_order, created_at`).bind(collection).all<ItemRow>();
  return (rows.results ?? []).map(toItem).filter((i): i is StoredItem => i !== null);
}

export async function findStored(db: D1Database, collection: string, id: string): Promise<StoredItem | null> {
  const row = await db.prepare(`${SELECT} WHERE collection = ? AND id = ?`).bind(collection, id).first<ItemRow>();
  return row ? toItem(row) : null;
}

export async function countStored(db: D1Database, collection: string): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM site_content_items WHERE collection = ?').bind(collection).first<{ n: number }>();
  return row?.n ?? 0;
}

export interface NewItem {
  id: string;
  sortOrder: number;
  enabled: boolean;
  data: Row;
}

function insertStatement(db: D1Database, collection: string, item: NewItem, staffId: string, ts: string): D1PreparedStatement {
  return db
    .prepare('INSERT INTO site_content_items (id,collection,sort_order,enabled,data_json,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .bind(item.id, collection, item.sortOrder, item.enabled ? 1 : 0, JSON.stringify(item.data), staffId, staffId, ts, ts);
}

function markStatement(db: D1Database, collection: string, staffId: string, ts: string): D1PreparedStatement {
  return db
    .prepare('INSERT INTO site_content_collections (collection,updated_by,updated_at) VALUES (?,?,?) ON CONFLICT(collection) DO UPDATE SET updated_by=excluded.updated_by,updated_at=excluded.updated_at')
    .bind(collection, staffId, ts);
}

/** Marks a collection customised and seeds it with the given items (used on first edit, so built-in content is copied, never lost). */
export async function seedCollection(db: D1Database, collection: string, items: NewItem[], staffId: string, ts: string): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM site_content_items WHERE collection = ?').bind(collection),
    ...items.map((item) => insertStatement(db, collection, item, staffId, ts)),
    markStatement(db, collection, staffId, ts),
  ]);
}

/** Adds one item. When the collection was not customised yet, the built-in items are seeded in the same atomic batch. */
export async function addItem(db: D1Database, collection: string, item: NewItem, seed: NewItem[] | null, staffId: string, ts: string): Promise<void> {
  await db.batch([
    ...(seed ? [db.prepare('DELETE FROM site_content_items WHERE collection = ?').bind(collection), ...seed.map((s) => insertStatement(db, collection, s, staffId, ts))] : []),
    insertStatement(db, collection, item, staffId, ts),
    markStatement(db, collection, staffId, ts),
  ]);
}

export async function updateItem(db: D1Database, collection: string, id: string, patch: { enabled?: boolean; data?: Row }, staffId: string, ts: string): Promise<boolean> {
  const sets = ['updated_by = ?', 'updated_at = ?'];
  const binds: unknown[] = [staffId, ts];
  if (patch.data) { sets.push('data_json = ?'); binds.push(JSON.stringify(patch.data)); }
  if (patch.enabled !== undefined) { sets.push('enabled = ?'); binds.push(patch.enabled ? 1 : 0); }
  const [result] = await db.batch([
    db.prepare(`UPDATE site_content_items SET ${sets.join(', ')} WHERE collection = ? AND id = ?`).bind(...binds, collection, id),
    markStatement(db, collection, staffId, ts),
  ]);
  return (result?.meta.changes ?? 0) > 0;
}

export async function deleteItem(db: D1Database, collection: string, id: string, staffId: string, ts: string): Promise<boolean> {
  const [result] = await db.batch([
    db.prepare('DELETE FROM site_content_items WHERE collection = ? AND id = ?').bind(collection, id),
    markStatement(db, collection, staffId, ts),
  ]);
  return (result?.meta.changes ?? 0) > 0;
}

export async function reorderItems(db: D1Database, collection: string, ids: string[], staffId: string, ts: string): Promise<void> {
  await db.batch([
    ...ids.map((id, index) =>
      db.prepare('UPDATE site_content_items SET sort_order = ?, updated_by = ?, updated_at = ? WHERE collection = ? AND id = ?').bind(index, staffId, ts, collection, id),
    ),
    markStatement(db, collection, staffId, ts),
  ]);
}

/** Removes every override so the collection shows its built-in content again. */
export async function resetCollection(db: D1Database, collection: string): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM site_content_items WHERE collection = ?').bind(collection),
    db.prepare('DELETE FROM site_content_collections WHERE collection = ?').bind(collection),
  ]);
}
