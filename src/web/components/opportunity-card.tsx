import type { PublicOpportunity } from '../../domain/opportunities/serialize';

/** Column list shared by every public query that renders OpportunityCard. */
export const OPPORTUNITY_CARD_SELECT =
  'id, slug, title, country, opportunity_type, price_text, price_visibility, lifecycle, summary, availability, points_json, seo_title, seo_description, published_at, classification, labels_json, (SELECT id FROM opportunity_media m WHERE m.opportunity_id = opportunities.id ORDER BY m.sort_order ASC, m.created_at ASC LIMIT 1) AS cover_media_id, (SELECT alt_text FROM opportunity_media ma WHERE ma.id = (SELECT id FROM opportunity_media mb WHERE mb.opportunity_id = opportunities.id ORDER BY mb.sort_order ASC, mb.created_at ASC LIMIT 1)) AS cover_media_alt';

const typeLabel = (type: string) =>
  type === 'casino-hotel'
    ? 'Casino & Hotel'
    : type === 'gaming-venue'
      ? 'Gaming venue'
      : type.charAt(0).toUpperCase() + type.slice(1);

interface CardProps {
  item: PublicOpportunity;
  /** "archive" cards describe past opportunities and do not link to a detail page. */
  variant?: 'live' | 'archive';
}

export function OpportunityCard({ item, variant = 'live' }: CardProps) {
  const archive = variant === 'archive';
  const href = `/opportunities/${encodeURIComponent(item.slug)}`;
  const flag = archive ? 'Past opportunity' : item.labels[0];
  const media = (
    <>
      {item.coverMediaPath ? (
        <img src={item.coverMediaPath} alt={item.coverMediaAlt} loading="lazy" decoding="async" />
      ) : (
        <span class="opp-fallback" aria-hidden="true">
          <span class="opp-monogram">M</span>
          <span class="opp-fallback-type">{typeLabel(item.type)}</span>
        </span>
      )}
      <span class="opp-badge">{typeLabel(item.type)}</span>
      {flag && <span class="opp-flag">{flag}</span>}
    </>
  );
  return (
    <article class={archive ? 'opp-card opp-card-archive' : 'opp-card'}>
      {archive ? (
        <div class="opp-media">{media}</div>
      ) : (
        <a class="opp-media" href={href} aria-label={`View ${item.title}`} tabindex={-1}>
          {media}
        </a>
      )}
      <div class="opp-body">
        <div class="opp-location">
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">
            <path
              fill="currentColor"
              d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7Zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5Z"
            />
          </svg>
          {item.country ?? 'International'}
        </div>
        <h3>{archive ? item.title : <a href={href}>{item.title}</a>}</h3>
        <p class="opp-summary">
          {item.summary || 'Further details are available to qualified parties.'}
        </p>
        {item.points.length > 0 && (
          <ul class="opp-points">
            {item.points.slice(0, 3).map((point) => (
              <li>{point}</li>
            ))}
          </ul>
        )}
      </div>
      <div class="opp-footer">
        <div class="opp-price">
          <small>Indicative price</small>
          <strong>{item.price ? item.price : 'Price on request'}</strong>
        </div>
        {!archive && (
          <a class="button button-primary opp-cta" href={href} aria-label={`View ${item.title}`}>
            View details <span aria-hidden="true">→</span>
          </a>
        )}
      </div>
    </article>
  );
}
