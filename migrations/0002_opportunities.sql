CREATE TABLE IF NOT EXISTS opportunities (
  id TEXT PRIMARY KEY,
  legacy_id TEXT UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  country TEXT,
  opportunity_type TEXT NOT NULL DEFAULT 'casino-hotel',
  price_text TEXT NOT NULL DEFAULT '',
  price_minor INTEGER,
  currency TEXT,
  lifecycle TEXT NOT NULL DEFAULT 'draft' CHECK (lifecycle IN ('draft','in_review','published','on_hold','under_offer','sold','off_market','archived')),
  content_review_status TEXT NOT NULL DEFAULT 'pending' CHECK (content_review_status IN ('pending','approved','rejected')),
  legacy_status TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  body_html TEXT NOT NULL DEFAULT '',
  availability TEXT NOT NULL DEFAULT '',
  points_json TEXT NOT NULL DEFAULT '[]',
  public_visibility INTEGER NOT NULL DEFAULT 0 CHECK (public_visibility IN (0,1)),
  last_verified_at TEXT,
  published_at TEXT,
  seo_title TEXT NOT NULL DEFAULT '',
  seo_description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_opportunities_lifecycle ON opportunities(lifecycle, public_visibility);
CREATE INDEX IF NOT EXISTS idx_opportunities_country ON opportunities(country);
CREATE INDEX IF NOT EXISTS idx_opportunities_type ON opportunities(opportunity_type);
CREATE INDEX IF NOT EXISTS idx_opportunities_updated ON opportunities(updated_at DESC);
CREATE TABLE IF NOT EXISTS opportunity_versions (
  id TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  changed_by TEXT REFERENCES users(id),
  change_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(opportunity_id, version_number)
);
CREATE TABLE IF NOT EXISTS opportunity_media (
  id TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL UNIQUE,
  alt_text TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
