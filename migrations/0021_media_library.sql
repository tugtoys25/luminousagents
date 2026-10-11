-- Managed site media library. Public files are served only when explicitly marked public.
CREATE TABLE IF NOT EXISTS media_assets (
  id TEXT PRIMARY KEY,
  r2_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  sha256 TEXT NOT NULL,
  alt_text TEXT NOT NULL DEFAULT '',
  caption TEXT NOT NULL DEFAULT '',
  folder TEXT NOT NULL DEFAULT 'general',
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('public','private')),
  uploaded_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_assets_created ON media_assets(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_assets_type ON media_assets(content_type);
CREATE INDEX IF NOT EXISTS idx_media_assets_folder ON media_assets(folder);
CREATE INDEX IF NOT EXISTS idx_media_assets_visibility ON media_assets(visibility);
