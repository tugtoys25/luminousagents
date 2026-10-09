CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT OR IGNORE INTO app_settings(key, value_json, updated_at) VALUES
  ('public_listing_review_required', 'true', '2026-10-09T00:00:00.000Z'),
  ('default_currency', '"GBP"', '2026-10-09T00:00:00.000Z'),
  ('site_name', '"Casinos of Mayfair"', '2026-10-09T00:00:00.000Z');
