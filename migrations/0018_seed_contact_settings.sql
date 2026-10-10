-- Seed public contact channels adopted from the Mayfair brand material.
-- INSERT OR IGNORE: never overwrites values already edited in the dashboard.
INSERT OR IGNORE INTO platform_settings (setting_key, value_json, updated_by, updated_at) VALUES
  ('contact_phone_mobile',   '"+44 (0) 781 702 7077"',               NULL, '2026-10-10T00:00:00.000Z'),
  ('contact_phone_office',   '"+44 (0) 1424 221226"',                NULL, '2026-10-10T00:00:00.000Z'),
  ('contact_email',          '"casinosofmayfair@btinternet.com"',    NULL, '2026-10-10T00:00:00.000Z'),
  ('contact_email_chairman', '"briancasinosofmayfair@gmail.com"',    NULL, '2026-10-10T00:00:00.000Z'),
  ('whatsapp_number',        '"447817027077"',                       NULL, '2026-10-10T00:00:00.000Z'),
  ('whatsapp_message',       '"Hello Casinos of Mayfair, I would like to discuss a casino or casino-hotel opportunity."', NULL, '2026-10-10T00:00:00.000Z');
