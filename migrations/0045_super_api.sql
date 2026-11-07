-- Control plane (Super API) support, release 2.7.1.
-- Only used when the site is provisioned and managed by the Lummet control plane; harmless otherwise.
--
--   super_api_nonces       one row per accepted request nonce (replay protection), pruned after 10 minutes
--   super_api_rate_limits  one row per accepted request (120 per minute per credential), pruned after 1 minute
--   platform_state         small signed values pushed by the control plane: the site access state (serving, suspended,
--                          closed) and the storage cap, each with a generation so a replayed older push changes nothing
CREATE TABLE IF NOT EXISTS super_api_nonces (
  credential_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (credential_id, nonce)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_super_api_nonces_created ON super_api_nonces(created_at);

CREATE TABLE IF NOT EXISTS super_api_rate_limits (
  credential_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_super_api_rate_limits_window ON super_api_rate_limits(credential_id, created_at);

CREATE TABLE IF NOT EXISTS platform_state (
  key TEXT PRIMARY KEY CHECK (key IN ('site_access', 'storage_limit')),
  value TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  updated_at TEXT NOT NULL
);
