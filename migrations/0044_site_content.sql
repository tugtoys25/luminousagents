-- Staff-managed site content (hero, home layout, lists, navigation, theme, footer, SEO).
-- A collection with no row in site_content_collections shows its built-in content (code defaults).
-- Once a collection is "customised" its rows are the whole truth, so staff can also delete every item.
CREATE TABLE IF NOT EXISTS site_content_collections (
  collection TEXT PRIMARY KEY,
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS site_content_items (
  id TEXT PRIMARY KEY,
  collection TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  data_json TEXT NOT NULL,
  created_by TEXT REFERENCES users(id),
  updated_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_site_content_items_collection ON site_content_items(collection, sort_order);

-- Brand rebrand: drop the seeded legacy values ONLY where they were never edited, so the built-in
-- Luminous Agents defaults apply. Anything staff changed is kept.
DELETE FROM platform_settings WHERE setting_key = 'contact_email' AND value_json = '"casinosofmayfair@btinternet.com"';
DELETE FROM platform_settings WHERE setting_key = 'contact_email_chairman' AND value_json = '"briancasinosofmayfair@gmail.com"';
DELETE FROM platform_settings WHERE setting_key = 'whatsapp_message'
  AND value_json = '"Hello Casinos of Mayfair, I would like to discuss a casino or casino-hotel opportunity."';
