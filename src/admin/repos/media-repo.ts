/** SQL for the shared media library (metadata only; bytes live in private R2). */
type Row = Record<string, unknown>;

export interface MediaFilter {
  /** Already trimmed, lower-cased and length-limited by the caller. */
  q: string;
  kind: string;
  visibility: string;
  limit: number;
}

export async function listMedia(db: D1Database, f: MediaFilter): Promise<Row[]> {
  const clauses: string[] = [];
  const args: (string | number)[] = [];
  if (f.q) {
    clauses.push("(lower(filename) LIKE ? ESCAPE '\\' OR lower(alt_text) LIKE ? ESCAPE '\\' OR lower(caption) LIKE ? ESCAPE '\\')");
    const like = `%${f.q.replace(/[\\%_]/g, '\\$&')}%`;
    args.push(like, like, like);
  }
  if (f.kind === 'image') clauses.push("content_type LIKE 'image/%'");
  if (f.kind === 'document') clauses.push("content_type NOT LIKE 'image/%'");
  if (f.visibility === 'public' || f.visibility === 'private') {
    clauses.push('visibility = ?');
    args.push(f.visibility);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = await db
    .prepare(
      `SELECT id, filename, content_type AS contentType, byte_size AS byteSize, alt_text AS altText, caption, folder, visibility, public_slug AS publicSlug, created_at AS createdAt FROM media_assets ${where} ORDER BY created_at DESC LIMIT ?`,
    )
    .bind(...args, f.limit)
    .all<Row>();
  return rows.results ?? [];
}

export async function insertMedia(
  db: D1Database,
  m: { id: string; r2Key: string; filename: string; contentType: string; byteSize: number; sha256: string; visibility: string; uploadedBy: string; timestamp: string },
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO media_assets (id, r2_key, filename, content_type, byte_size, sha256, folder, visibility, uploaded_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(m.id, m.r2Key, m.filename, m.contentType, m.byteSize, m.sha256, 'general', m.visibility, m.uploadedBy, m.timestamp, m.timestamp)
    .run();
}

export interface MediaRecord {
  id: string;
  contentType: string;
  visibility: string;
  publicSlug: string | null;
}

export function findMedia(db: D1Database, id: string): Promise<MediaRecord | null> {
  return db
    .prepare('SELECT id, content_type AS contentType, visibility, public_slug AS publicSlug FROM media_assets WHERE id = ?')
    .bind(id)
    .first<MediaRecord>();
}

/** True when another asset already uses this slug as its slug or as its id. */
export async function slugTaken(db: D1Database, slug: string, exceptId: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT id FROM media_assets WHERE (public_slug = ? OR id = ?) AND id != ? LIMIT 1')
    .bind(slug, slug, exceptId)
    .first();
  return Boolean(row);
}

export interface MediaPatch {
  filename?: string | undefined;
  altText?: string | undefined;
  caption?: string | undefined;
  folder?: string | undefined;
  publicSlug?: string | undefined;
  visibility?: string | undefined;
}
const PATCH_COLUMNS = [
  ['filename', 'filename'],
  ['altText', 'alt_text'],
  ['caption', 'caption'],
  ['folder', 'folder'],
  ['publicSlug', 'public_slug'],
  ['visibility', 'visibility'],
] as const;

/** Updates only provided fields ('' clears a field). Returns false when there was nothing to change. */
export async function updateMedia(db: D1Database, id: string, patch: MediaPatch, timestamp: string): Promise<boolean> {
  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  for (const [key, column] of PATCH_COLUMNS) {
    const value = patch[key];
    if (value !== undefined) {
      sets.push(`${column} = ?`);
      args.push(value === '' ? null : value);
    }
  }
  if (!sets.length) return false;
  sets.push('updated_at = ?');
  args.push(timestamp, id);
  await db.prepare(`UPDATE media_assets SET ${sets.join(', ')} WHERE id = ?`).bind(...args).run();
  return true;
}

export interface MediaFile {
  r2Key: string;
  filename: string;
  contentType: string;
}
export function findMediaFile(db: D1Database, id: string): Promise<MediaFile | null> {
  return db
    .prepare('SELECT r2_key AS r2Key, filename, content_type AS contentType FROM media_assets WHERE id = ?')
    .bind(id)
    .first<MediaFile>();
}

export interface MediaForDelete {
  id: string;
  r2Key: string;
  filename: string;
  publicSlug: string | null;
}
export function findMediaForDelete(db: D1Database, id: string): Promise<MediaForDelete | null> {
  return db
    .prepare('SELECT id, r2_key AS r2Key, filename, public_slug AS publicSlug FROM media_assets WHERE id = ?')
    .bind(id)
    .first<MediaForDelete>();
}

export async function deleteMedia(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM media_assets WHERE id = ?').bind(id).run();
}

export interface PathReferences {
  settings: string[];
  pages: string[];
  forms: string[];
  opportunities: string[];
}

/** Finds managed content that mentions a public media path. Used to block unsafe slug changes and deletes. */
export async function findPathReferences(db: D1Database, path: string): Promise<PathReferences> {
  const like = `%${path}%`;
  const [settings, pages, forms, opportunities] = await Promise.all([
    db.prepare('SELECT setting_key AS name FROM platform_settings WHERE value_json LIKE ? LIMIT 20').bind(like).all<{ name: string }>(),
    db
      .prepare('SELECT slug AS name FROM managed_pages WHERE (body_markdown LIKE ? OR description LIKE ? OR seo_title LIKE ? OR seo_description LIKE ?) LIMIT 20')
      .bind(like, like, like, like)
      .all<{ name: string }>(),
    db
      .prepare('SELECT slug AS name FROM managed_forms WHERE (fields_json LIKE ? OR description LIKE ?) LIMIT 20')
      .bind(like, like)
      .all<{ name: string }>(),
    db
      .prepare('SELECT slug AS name FROM opportunities WHERE body_html LIKE ? OR summary LIKE ? OR seo_title LIKE ? OR seo_description LIKE ? LIMIT 20')
      .bind(like, like, like, like)
      .all<{ name: string }>(),
  ]);
  const names = (r: { results?: { name: string }[] }) => (r.results ?? []).map((row) => row.name);
  return { settings: names(settings), pages: names(pages), forms: names(forms), opportunities: names(opportunities) };
}

export interface PublicMediaAsset {
  r2Key: string;
  contentType: string;
  filename: string;
  byteSize: number;
  sha256: string;
}

/** Public serving: only assets explicitly marked public, found by id or public slug. */
export function findPublicMediaAsset(db: D1Database, idOrSlug: string): Promise<PublicMediaAsset | null> {
  return db
    .prepare(
      "SELECT r2_key AS r2Key, content_type AS contentType, filename, byte_size AS byteSize, sha256 FROM media_assets WHERE (id = ? OR public_slug = ?) AND visibility = 'public'",
    )
    .bind(idOrSlug, idOrSlug)
    .first<PublicMediaAsset>();
}
