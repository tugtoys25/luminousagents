-- Phase 3 triggers (isolated, like 0033/0035). Rollback: DROP each trigger named below.
-- 1) Append-only history tables.
CREATE TRIGGER IF NOT EXISTS trg_seller_changes_no_update BEFORE UPDATE ON seller_changes BEGIN SELECT RAISE(ABORT, 'seller_changes is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_seller_changes_no_delete BEFORE DELETE ON seller_changes BEGIN SELECT RAISE(ABORT, 'seller_changes is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_authority_events_no_update BEFORE UPDATE ON seller_authority_events BEGIN SELECT RAISE(ABORT, 'seller_authority_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_authority_events_no_delete BEFORE DELETE ON seller_authority_events BEGIN SELECT RAISE(ABORT, 'seller_authority_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_publication_events_no_update BEFORE UPDATE ON seller_publication_events BEGIN SELECT RAISE(ABORT, 'seller_publication_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_publication_events_no_delete BEFORE DELETE ON seller_publication_events BEGIN SELECT RAISE(ABORT, 'seller_publication_events is append-only'); END;

-- 2) Publication gate, enforced in the database so every code path (publication endpoint, workflow action,
--    import, future code) is covered. Applies only to opportunities that have ever been linked to a seller;
--    existing and imported listings are unaffected. It fires only when a row BECOMES public or published.
--    Mirrors src/seller/gates.ts; the application returns the detailed reasons, this is the backstop.
CREATE TRIGGER IF NOT EXISTS trg_opportunities_seller_publication_gate
BEFORE UPDATE OF public_visibility, lifecycle ON opportunities
WHEN (NEW.public_visibility = 1 OR NEW.lifecycle = 'published')
 AND (OLD.public_visibility <> NEW.public_visibility OR OLD.lifecycle <> NEW.lifecycle)
 AND EXISTS (SELECT 1 FROM seller_opportunity_links x WHERE x.opportunity_id = NEW.id)
BEGIN
  SELECT CASE WHEN
    NOT EXISTS (SELECT 1 FROM seller_opportunity_links a WHERE a.opportunity_id = NEW.id AND a.relationship_status = 'ACTIVE')
    OR EXISTS (
      SELECT 1 FROM seller_opportunity_links l
      WHERE l.opportunity_id = NEW.id AND l.relationship_status = 'ACTIVE'
        AND (l.review_status <> 'REVIEWED'
          OR NOT EXISTS (SELECT 1 FROM seller_authority_records r WHERE r.link_id = l.id AND r.authority_type = 'AUTHORITY_TO_MARKET'
              AND ((r.status = 'VERIFIED' AND (r.valid_from IS NULL OR r.valid_from <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                    AND (r.valid_until IS NULL OR r.valid_until > strftime('%Y-%m-%dT%H:%M:%fZ','now')))
                   OR r.status = 'NOT_REQUIRED_WITH_RECORDED_REASON'))
          OR NOT EXISTS (SELECT 1 FROM seller_authority_records r WHERE r.link_id = l.id AND r.authority_type = 'BROKERAGE_MANDATE'
              AND ((r.status = 'VERIFIED' AND (r.valid_from IS NULL OR r.valid_from <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                    AND (r.valid_until IS NULL OR r.valid_until > strftime('%Y-%m-%dT%H:%M:%fZ','now')))
                   OR r.status = 'NOT_REQUIRED_WITH_RECORDED_REASON'))))
    OR NOT EXISTS (SELECT 1 FROM seller_publication_reviews p WHERE p.opportunity_id = NEW.id AND p.status = 'APPROVED')
  THEN RAISE(ABORT, 'seller publication gates not satisfied') END;
END;
