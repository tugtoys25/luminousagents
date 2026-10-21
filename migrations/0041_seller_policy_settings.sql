-- Editable seller policy settings. Deliberately NOT stored in platform_settings: that table is readable by editors through
-- GET /dashboard/settings, and these values include internal recipient addresses and sensitive controls.
CREATE TABLE IF NOT EXISTS seller_policy_settings (
  setting_key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL
);
