/** SQL for creating, editing and deleting opportunities. Lifecycle/versions live in opportunity-lifecycle-repo. */
export async function activeBrokerExists(db: D1Database, userId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT id FROM users WHERE id = ? AND user_type = 'staff' AND role = 'broker' AND status = 'active'")
    .bind(userId)
    .first();
  return Boolean(row);
}

export async function slugExists(db: D1Database, slug: string): Promise<boolean> {
  return Boolean(await db.prepare('SELECT 1 AS found FROM opportunities WHERE slug = ?').bind(slug).first());
}

export interface NewOpportunity {
  id: string;
  slug: string;
  title: string;
  country: string;
  opportunityType: string;
  classification: string;
  labels: string[];
  priceText: string;
  priceVisibility: boolean;
  summary: string;
  bodyHtml: string;
  availability: string;
  seoTitle: string;
  seoDescription: string;
  assignedBrokerId: string | null;
  timestamp: string;
}

/** Every new opportunity is a private draft awaiting review, whatever the caller passes. */
export async function insertOpportunity(db: D1Database, o: NewOpportunity): Promise<void> {
  await db
    .prepare(
      "INSERT INTO opportunities (id, slug, title, country, opportunity_type, classification, labels_json, price_text, price_visibility, lifecycle, content_review_status, summary, body_html, availability, public_visibility, seo_title, seo_description, assigned_broker_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 'pending', ?, ?, ?, 0, ?, ?, ?, ?, ?)",
    )
    .bind(
      o.id, o.slug, o.title, o.country, o.opportunityType, o.classification, JSON.stringify(o.labels), o.priceText,
      o.priceVisibility ? 1 : 0, o.summary, o.bodyHtml, o.availability, o.seoTitle, o.seoDescription,
      o.assignedBrokerId, o.timestamp, o.timestamp,
    )
    .run();
}

/** API field name -> column. The only columns an edit may ever touch. */
export const EDIT_COLUMNS: Record<string, string> = {
  title: 'title',
  country: 'country',
  opportunityType: 'opportunity_type',
  classification: 'classification',
  labels: 'labels_json',
  priceText: 'price_text',
  priceVisibility: 'price_visibility',
  summary: 'summary',
  bodyHtml: 'body_html',
  availability: 'availability',
  seoTitle: 'seo_title',
  seoDescription: 'seo_description',
  assignedBrokerId: 'assigned_broker_id',
};

/** Any edit sends the listing back for content review and takes it off the website. */
export async function updateOpportunity(
  db: D1Database,
  opportunityId: string,
  input: Record<string, unknown>,
  newSlug: string | null,
  updatedAt: string,
): Promise<void> {
  const entries = Object.entries(input);
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of entries) {
    const column = EDIT_COLUMNS[key];
    if (!column) throw new Error(`Field not editable: ${key}`);
    sets.push(`${column} = ?`);
    values.push(key === 'labels' ? JSON.stringify(value) : key === 'priceVisibility' ? (value ? 1 : 0) : value);
  }
  if (newSlug !== null) {
    sets.push('slug = ?');
    values.push(newSlug);
  }
  sets.push("content_review_status = 'pending'", 'public_visibility = 0', 'updated_at = ?');
  values.push(updatedAt, opportunityId);
  await db.prepare(`UPDATE opportunities SET ${sets.join(', ')} WHERE id = ?`).bind(...values).run();
}

export function findForDelete(db: D1Database, opportunityId: string): Promise<{ id: string; slug: string; title: string; country: string | null } | null> {
  return db
    .prepare('SELECT id, slug, title, country FROM opportunities WHERE id = ?')
    .bind(opportunityId)
    .first();
}

/** True when NDA requests, grants, data-room documents or form submissions still reference the listing. */
export async function hasLinkedRecords(db: D1Database, opportunityId: string): Promise<boolean> {
  const used = await db
    .prepare(
      'SELECT (SELECT COUNT(*) FROM nda_requests WHERE opportunity_id = ?1) AS ndas, (SELECT COUNT(*) FROM access_grants WHERE opportunity_id = ?1) AS grants, (SELECT COUNT(*) FROM documents WHERE opportunity_id = ?1) AS docs, (SELECT COUNT(*) FROM managed_form_submissions WHERE opportunity_id = ?1) AS forms',
    )
    .bind(opportunityId)
    .first<{ ndas: number; grants: number; docs: number; forms: number }>();
  return Boolean(used && (used.ndas || used.grants || used.docs || used.forms));
}

/** Image files stay in storage: the media library is reference-aware and may share them. */
export async function deleteOpportunityRow(db: D1Database, opportunityId: string): Promise<void> {
  await db.prepare('DELETE FROM opportunities WHERE id = ?').bind(opportunityId).run();
}
