/** SQL for staff-managed content pages. */
export interface PageListRow {
  slug: string;
  [column: string]: unknown;
}
export interface PageRef {
  id: string;
  slug: string;
}
export interface PageInput {
  slug: string;
  title: string;
  description: string;
  bodyMarkdown: string;
  status: string;
  seoTitle: string;
  seoDescription: string;
}

export async function listPages(db: D1Database): Promise<PageListRow[]> {
  const r = await db
    .prepare(
      'SELECT id,slug,title,description,body_markdown AS bodyMarkdown,status,seo_title AS seoTitle,seo_description AS seoDescription,updated_at AS updatedAt FROM managed_pages ORDER BY updated_at DESC LIMIT 200',
    )
    .all<PageListRow>();
  return r.results ?? [];
}

export async function findPageSlugById(db: D1Database, id: string): Promise<string | null> {
  const row = await db.prepare('SELECT slug FROM managed_pages WHERE id = ?').bind(id).first<{ slug: string }>();
  return row?.slug ?? null;
}

export function findPage(db: D1Database, id: string): Promise<PageRef | null> {
  return db.prepare('SELECT id, slug FROM managed_pages WHERE id = ?').bind(id).first<PageRef>();
}

/** Throws on a slug uniqueness conflict; callers translate that into a 409. */
export async function upsertPage(
  db: D1Database,
  pageId: string,
  d: PageInput,
  staffId: string,
  timestamp: string,
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO managed_pages (id,slug,title,description,body_markdown,status,seo_title,seo_description,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET slug=excluded.slug,title=excluded.title,description=excluded.description,body_markdown=excluded.body_markdown,status=excluded.status,seo_title=excluded.seo_title,seo_description=excluded.seo_description,updated_by=excluded.updated_by,updated_at=excluded.updated_at',
    )
    .bind(pageId, d.slug, d.title, d.description, d.bodyMarkdown, d.status, d.seoTitle, d.seoDescription, staffId, staffId, timestamp, timestamp)
    .run();
}

export async function setPageStatus(db: D1Database, pageId: string, status: string, staffId: string, timestamp: string): Promise<void> {
  await db
    .prepare(
      'UPDATE managed_pages SET status = ?, updated_by = ?, updated_at = ? WHERE id = ?',
    )
    .bind(status, staffId, timestamp, pageId)
    .run();
}

export async function deletePage(db: D1Database, pageId: string): Promise<void> {
  await db.prepare('DELETE FROM managed_pages WHERE id = ?').bind(pageId).run();
}
