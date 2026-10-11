-- Sprint 25: explicit public price policy and configurable media URL slugs.
-- Existing listings default to confidential prices; existing public image URLs remain ID-based.
ALTER TABLE opportunities ADD COLUMN price_visibility INTEGER NOT NULL DEFAULT 0 CHECK (price_visibility IN (0, 1));
ALTER TABLE media_assets ADD COLUMN public_slug TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_media_assets_public_slug
  ON media_assets(public_slug) WHERE public_slug IS NOT NULL AND public_slug <> '';

CREATE TABLE IF NOT EXISTS buyer_email_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_buyer_email_codes_user_expiry
  ON buyer_email_codes(user_id, expires_at DESC);
