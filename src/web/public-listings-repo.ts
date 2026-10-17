/**
 * SQL for the PUBLIC website: only listings that are published, approved, visible AND classified public are ever
 * returned. Price text is always fetched raw; serializeOpportunity decides what may be shown.
 */
import type { OpportunityRow } from '../domain/opportunities/serialize';

/** Column list shared by every public query that renders OpportunityCard. */
export const OPPORTUNITY_CARD_SELECT =
  'id, slug, title, country, opportunity_type, price_text, price_visibility, lifecycle, summary, availability, points_json, seo_title, seo_description, published_at, classification, labels_json, (SELECT id FROM opportunity_media m WHERE m.opportunity_id = opportunities.id ORDER BY m.sort_order ASC, m.created_at ASC LIMIT 1) AS cover_media_id, (SELECT alt_text FROM opportunity_media ma WHERE ma.id = (SELECT id FROM opportunity_media mb WHERE mb.opportunity_id = opportunities.id ORDER BY mb.sort_order ASC, mb.created_at ASC LIMIT 1)) AS cover_media_alt';

/** The single definition of "publicly listed". Every public query must include it. */
export const PUBLIC_FILTER =
  "lifecycle = 'published' AND content_review_status = 'approved' AND public_visibility = 1 AND classification = 'public'";

export async function latestListings(db: D1Database, limit: number): Promise<OpportunityRow[]> {
  const rows = await db
    .prepare(`SELECT ${OPPORTUNITY_CARD_SELECT} FROM opportunities WHERE ${PUBLIC_FILTER} ORDER BY published_at DESC, title ASC LIMIT ?`)
    .bind(limit)
    .all<OpportunityRow>();
  return rows.results;
}

export interface CatalogueQuery {
  country: string;
  type: string;
  query: string;
  sort: 'newest' | 'title' | 'country';
  page: number;
}

const TYPES = ['casino', 'casino-hotel', 'hotel', 'resort', 'gaming-venue', 'other'];
const PRICE_TERM = /(?:\d|£|\$|€|\b(?:price|asking|million|billion|thousand|dollars?|pounds?|euros?|usd|gbp|eur)\b)/i;
export const PAGE_SIZE = 12;

/** Paged, filtered catalogue. All values are bound; only fixed fragments are concatenated. */
export async function searchCatalogue(
  db: D1Database,
  q: CatalogueQuery,
): Promise<{ total: number; rows: OpportunityRow[]; countries: Array<{ country: string }> }> {
  const orderBy =
    q.sort === 'title'
      ? 'title COLLATE NOCASE ASC, published_at DESC'
      : q.sort === 'country'
        ? 'country COLLATE NOCASE ASC, title COLLATE NOCASE ASC'
        : 'published_at DESC, title ASC';
  const conditions = [
    "lifecycle = 'published'",
    "content_review_status = 'approved'",
    'public_visibility = 1',
    "classification = 'public'",
  ];
  const binds: (string | number)[] = [];
  if (q.country) {
    conditions.push('country = ?');
    binds.push(q.country);
  }
  if (q.type && TYPES.includes(q.type)) {
    conditions.push('opportunity_type = ?');
    binds.push(q.type);
  }
  if (q.query) {
    const pattern = `%${q.query}%`;
    conditions.push('(title LIKE ? OR summary LIKE ?)');
    binds.push(pattern, pattern);
    // Numeric/currency/price-oriented searches must not reveal that a hidden price phrase exists.
    // For these searches, omit confidential listings whose raw text matches the term.
    if (PRICE_TERM.test(q.query)) {
      conditions.push('NOT (price_visibility = 0 AND (title LIKE ? OR summary LIKE ? OR price_text LIKE ?))');
      binds.push(pattern, pattern, pattern);
    }
  }
  const where = conditions.join(' AND ');
  const count = await db.prepare(`SELECT COUNT(*) AS total FROM opportunities WHERE ${where}`).bind(...binds).first<{ total: number }>();
  const rows = await db
    .prepare(`SELECT ${OPPORTUNITY_CARD_SELECT} FROM opportunities WHERE ${where} ORDER BY ${orderBy} LIMIT ${PAGE_SIZE} OFFSET ?`)
    .bind(...binds, (q.page - 1) * PAGE_SIZE)
    .all<OpportunityRow>();
  const countries = await db
    .prepare(`SELECT DISTINCT country FROM opportunities WHERE ${PUBLIC_FILTER} AND country IS NOT NULL ORDER BY country`)
    .all<{ country: string }>();
  return { total: count?.total ?? 0, rows: rows.results, countries: countries.results };
}

export async function listingsByCountry(db: D1Database, countryName: string): Promise<OpportunityRow[]> {
  const rows = await db
    .prepare(`SELECT ${OPPORTUNITY_CARD_SELECT} FROM opportunities WHERE lower(country) = lower(?) AND ${PUBLIC_FILTER} ORDER BY published_at DESC, title ASC LIMIT 100`)
    .bind(countryName)
    .all<OpportunityRow>();
  return rows.results;
}

export async function casinoHotelListings(db: D1Database): Promise<OpportunityRow[]> {
  const rows = await db
    .prepare(`SELECT ${OPPORTUNITY_CARD_SELECT} FROM opportunities WHERE opportunity_type = 'casino-hotel' AND ${PUBLIC_FILTER} ORDER BY published_at DESC, title ASC LIMIT 100`)
    .all<OpportunityRow>();
  return rows.results;
}

/** Past (sold / off-market) listings that staff have approved for public display. */
export async function archivedListings(db: D1Database): Promise<OpportunityRow[]> {
  const rows = await db
    .prepare(
      `SELECT ${OPPORTUNITY_CARD_SELECT} FROM opportunities WHERE lifecycle IN ('sold','off_market') AND content_review_status = 'approved' AND public_visibility = 1 AND classification = 'public' ORDER BY updated_at DESC LIMIT 100`,
    )
    .all<OpportunityRow>();
  return rows.results;
}

export function findPublicListing(db: D1Database, slug: string): Promise<OpportunityRow | null> {
  return db
    .prepare(`SELECT ${OPPORTUNITY_CARD_SELECT} FROM opportunities WHERE slug = ? AND ${PUBLIC_FILTER} LIMIT 1`)
    .bind(slug)
    .first<OpportunityRow>();
}

export function findPageOverride(
  db: D1Database,
  slug: string,
): Promise<{ title: string; description: string; body: string; seoTitle: string; seoDescription: string } | null> {
  return db
    .prepare(
      "SELECT title, description, body_markdown AS body, seo_title AS seoTitle, seo_description AS seoDescription FROM managed_pages WHERE slug = ? AND status = 'published' LIMIT 1",
    )
    .bind(slug)
    .first();
}

/** Only images of publicly listed opportunities, and only JPEG/PNG, are ever served from this lookup. */
export function findPublicListingImage(
  db: D1Database,
  mediaId: string,
  opportunityId: string,
): Promise<{ r2Key: string; contentType: string; byteSize: number; sha256: string } | null> {
  return db
    .prepare(
      "SELECT m.r2_key AS r2Key, m.content_type AS contentType, m.byte_size AS byteSize, m.sha256 AS sha256 FROM opportunity_media m JOIN opportunities o ON o.id = m.opportunity_id WHERE m.id = ? AND m.opportunity_id = ? AND o.lifecycle = 'published' AND o.content_review_status = 'approved' AND o.public_visibility = 1 AND o.classification = 'public' AND m.content_type IN ('image/jpeg','image/png') LIMIT 1",
    )
    .bind(mediaId, opportunityId)
    .first();
}

export interface SitemapData {
  listings: Array<{ slug: string; updatedAt: string }>;
  countries: Array<{ country: string; updatedAt: string }>;
  pages: Array<{ slug: string; updatedAt: string }>;
  archivedUpdatedAt: string | null;
}

export async function loadSitemapData(db: D1Database): Promise<SitemapData> {
  const [listings, countries, pages, archived] = await Promise.all([
    db
      .prepare(`SELECT slug, updated_at AS updatedAt FROM opportunities WHERE ${PUBLIC_FILTER} ORDER BY updated_at DESC LIMIT 5000`)
      .all<{ slug: string; updatedAt: string }>(),
    db
      .prepare(`SELECT country, MAX(updated_at) AS updatedAt FROM opportunities WHERE ${PUBLIC_FILTER} AND country IS NOT NULL GROUP BY country ORDER BY country`)
      .all<{ country: string; updatedAt: string }>(),
    db
      .prepare("SELECT slug, updated_at AS updatedAt FROM managed_pages WHERE status = 'published' ORDER BY updated_at DESC LIMIT 500")
      .all<{ slug: string; updatedAt: string }>(),
    db
      .prepare(
        "SELECT MAX(updated_at) AS updatedAt FROM opportunities WHERE lifecycle IN ('sold','off_market') AND content_review_status = 'approved' AND public_visibility = 1 AND classification = 'public'",
      )
      .first<{ updatedAt: string | null }>(),
  ]);
  return { listings: listings.results, countries: countries.results, pages: pages.results, archivedUpdatedAt: archived?.updatedAt ?? null };
}
