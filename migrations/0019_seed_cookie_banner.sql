-- Seed the cookie / privacy banner settings so they are visible and editable in
-- Dashboard > Platform settings. INSERT OR IGNORE: never overwrites dashboard edits.
INSERT OR IGNORE INTO platform_settings (setting_key, value_json, updated_by, updated_at) VALUES
  ('cookie_banner_enabled',  '"on"',                    NULL, '2026-10-10T00:00:00.000Z'),
  ('cookie_banner_title',    '"Your privacy matters"',  NULL, '2026-10-10T00:00:00.000Z'),
  ('cookie_banner_text',     '"We use essential cookies to run this site. With your consent we also use analytics cookies to understand how it is used."', NULL, '2026-10-10T00:00:00.000Z'),
  ('cookie_accept_label',    '"Accept all"',            NULL, '2026-10-10T00:00:00.000Z'),
  ('cookie_reject_label',    '"Reject non-essential"',  NULL, '2026-10-10T00:00:00.000Z'),
  ('cookie_banner_position', '"bottom-left"',           NULL, '2026-10-10T00:00:00.000Z'),
  ('cookie_consent_days',    '"180"',                   NULL, '2026-10-10T00:00:00.000Z'),
  ('cookie_privacy_url',     '"/legal/privacy"',        NULL, '2026-10-10T00:00:00.000Z'),
  ('cookie_policy_url',      '"/legal/cookies"',        NULL, '2026-10-10T00:00:00.000Z');
