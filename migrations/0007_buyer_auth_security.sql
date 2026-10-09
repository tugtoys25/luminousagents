CREATE TABLE IF NOT EXISTS buyer_login_codes (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_buyer_codes_email ON buyer_login_codes(email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_buyer_codes_expiry ON buyer_login_codes(expires_at);
CREATE INDEX IF NOT EXISTS idx_nda_user_opportunity ON nda_requests(user_id, opportunity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_grants_active ON access_grants(user_id, opportunity_id, expires_at, revoked_at);
CREATE INDEX IF NOT EXISTS idx_documents_opportunity_tier ON documents(opportunity_id, tier, created_at DESC);
