-- Read-only diagnostic (PHP edition equivalent: bin/check-images.php).
-- Lists every listing image row and flags the ones the public /media route would refuse.
-- Run:  npx wrangler d1 execute <DB_NAME> --env staging --remote --file scripts/check-listing-images.sql
SELECT
  o.slug,
  o.lifecycle,
  o.public_visibility,
  o.content_review_status,
  m.id AS media_id,
  m.r2_key,
  m.content_type,
  m.byte_size,
  CASE
    WHEN m.r2_key IS NULL OR m.r2_key = '' THEN 'missing r2_key'
    WHEN m.byte_size = 0 THEN 'zero byte_size'
    WHEN m.sha256 = '' THEN 'missing sha256'
    WHEN o.lifecycle <> 'published' THEN 'listing not published'
    WHEN o.public_visibility <> 1 THEN 'listing not public'
    WHEN o.content_review_status <> 'approved' THEN 'content not approved'
    ELSE 'ok'
  END AS verdict
FROM opportunity_media m
JOIN opportunities o ON o.id = m.opportunity_id
ORDER BY (verdict = 'ok'), o.slug, m.sort_order;
