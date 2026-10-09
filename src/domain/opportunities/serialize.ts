export interface OpportunityRow {
  id: string;
  slug: string;
  title: string;
  country: string | null;
  opportunity_type: string;
  price_text: string;
  lifecycle: string;
  summary: string;
  availability: string;
  points_json: string;
  seo_title: string;
  seo_description: string;
  published_at: string | null;
}

export interface PublicOpportunity {
  slug: string;
  title: string;
  country: string | null;
  type: string;
  price: string | null;
  summary: string;
  availability: string | null;
  points: string[];
  seoTitle: string;
  seoDescription: string;
}

/** The sole serialization boundary for opportunity data leaving the Worker. */
export function serializeOpportunity(
  row: OpportunityRow,
  viewerTier: 1 | 2 = 1,
): PublicOpportunity {
  let points: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.points_json);
    if (Array.isArray(parsed))
      points = parsed.filter((value): value is string => typeof value === 'string').slice(0, 12);
  } catch {
    points = [];
  }
  return {
    slug: row.slug,
    title: row.title,
    country: row.country,
    type: row.opportunity_type,
    price: viewerTier >= 1 ? row.price_text || null : null,
    summary: row.summary,
    availability: row.availability || null,
    points,
    seoTitle: row.seo_title || row.title,
    seoDescription: row.seo_description || row.summary.slice(0, 160),
  };
}
