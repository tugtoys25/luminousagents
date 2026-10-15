-- OPTIONAL content seed: Chairman profile, social links, e-mail widget defaults, the "More from Mayfair" blocks
-- and the standard header / footer menus.
--
-- Ported from the PHP edition (sql/updates/0012 and 0013). This is NOT a numbered migration on purpose:
--   * it is public marketing copy that someone should approve before it goes live, and
--   * the release gates assert that the numbered set is exactly 0001..0030.
-- The site works without it: every value has a built-in default identical to the previous text.
--
-- Safe to re-run. INSERT OR IGNORE never overwrites a value already saved in Platform settings, and the
-- homepage_sections UPDATE only fills a list that is still empty. Everything is editable afterwards in
-- Dashboard -> Platform settings. Apply with:
--   wrangler d1 execute <DATABASE_NAME> --remote --file=scripts/seed-php-parity-content.sql
--
-- Deliberately not seeded: third-party recommendations, personal history, and the Instagram address
-- (not supplied, so that icon stays hidden until a link is saved).

INSERT OR IGNORE INTO platform_settings (setting_key, value_json, updated_by, updated_at) VALUES
  ('chairman_name', '"Brian Minister"', NULL, '2026-10-15T00:00:00.000Z'),
  ('chairman_title', '"Chairman, Casinos of Mayfair International Ltd"', NULL, '2026-10-15T00:00:00.000Z'),
  ('chairman_bio', '"We opened our first office in the centre of Mayfair, London in 1994 to fill a niche in the sale of casinos worldwide, starting with only two casinos for sale. Today we present a worldwide portfolio of land-based casino and casino-hotel opportunities, with prices from under $1 million to over $1 billion.\n\nI have served the casino industry for more than 50 years. Our brokerage department works with a database of almost 3,000 investors, alongside casino management, recruitment and staff training for owners and operators.\n\nIf you wish to discuss any casino for sale or casino hotel personally, please contact me directly. Every enquiry is treated in strict confidence, and opportunities are advertised in a way that protects the identity and location of the property."', NULL, '2026-10-15T00:00:00.000Z'),
  ('chairman_expertise', '"Mergers & Acquisitions (M&A)\nInvestment Banking\nReal Estate Development\nReal Estate Transactions\nFinancial Analysis\nBusiness Management\nContract Recruitment\nMarketing Strategy\nMedia Planning"', NULL, '2026-10-15T00:00:00.000Z'),
  ('chairman_languages', '"English, Spanish"', NULL, '2026-10-15T00:00:00.000Z'),
  ('linkedin_url', '"https://www.linkedin.com/in/1649250"', NULL, '2026-10-15T00:00:00.000Z'),
  ('instagram_url', '""', NULL, '2026-10-15T00:00:00.000Z'),
  ('email_widget_enabled', '"on"', NULL, '2026-10-15T00:00:00.000Z'),
  ('email_widget_address', '""', NULL, '2026-10-15T00:00:00.000Z'),
  ('email_widget_subject', '"Enquiry from the Casinos of Mayfair website"', NULL, '2026-10-15T00:00:00.000Z');

INSERT OR IGNORE INTO platform_settings (setting_key, value_json, updated_by, updated_at) VALUES
  ('homepage_sections', '[{"title": "Over fifty years in the casino industry", "body": "Our Chairman, Brian Minister, has served the casino industry for more than 50 years. Casinos of Mayfair International Ltd was established in London in 1994 to fill a niche in the sale of casinos worldwide.", "url": "/about", "linkText": "About the Chairman"}, {"title": "Casino brokerage, management and recruitment", "body": "Beyond casino sales and purchases, we provide casino management, recruitment and staff training, and consulting for owners, buyers and investors evaluating gaming opportunities.", "url": "/services", "linkText": "Our services"}, {"title": "A worldwide investor network", "body": "Our brokerage department works with a database of almost 3,000 investors and presents more than 50 casinos for sale from owners worldwide, from stand-alone casinos from $1 million to major casino groups.", "url": "/casinos-for-sale", "linkText": "View opportunities"}]', NULL, '2026-10-15T00:00:00.000Z');

UPDATE platform_settings SET value_json = '[{"title": "Over fifty years in the casino industry", "body": "Our Chairman, Brian Minister, has served the casino industry for more than 50 years. Casinos of Mayfair International Ltd was established in London in 1994 to fill a niche in the sale of casinos worldwide.", "url": "/about", "linkText": "About the Chairman"}, {"title": "Casino brokerage, management and recruitment", "body": "Beyond casino sales and purchases, we provide casino management, recruitment and staff training, and consulting for owners, buyers and investors evaluating gaming opportunities.", "url": "/services", "linkText": "Our services"}, {"title": "A worldwide investor network", "body": "Our brokerage department works with a database of almost 3,000 investors and presents more than 50 casinos for sale from owners worldwide, from stand-alone casinos from $1 million to major casino groups.", "url": "/casinos-for-sale", "linkText": "View opportunities"}]', updated_at = '2026-10-15T00:00:00.000Z'
 WHERE setting_key = 'homepage_sections' AND value_json IN ('', '[]', '""');

-- ---------------------------------------------------------------------------------------------
-- Standard menus (PHP v5.1 seeded these). The values are exactly the links the site already shows by
-- default, so nothing changes visually; they simply appear ready to edit in Platform settings.
-- Trade-off: once a menu is saved, a link added to the built-in default later will not appear on its own.
-- INSERT OR IGNORE keeps any menu you have already saved; the UPDATEs only fill a menu that is still empty.
INSERT OR IGNORE INTO platform_settings (setting_key, value_json, updated_by, updated_at) VALUES
  ('header_navigation', '[{"label":"Opportunities","url":"/casinos-for-sale"},{"label":"Services","url":"/services"},{"label":"About","url":"/about"},{"label":"FAQ","url":"/faq"},{"label":"Contact our team","url":"/contact"}]', NULL, '2026-10-15T00:00:00.000Z'),
  ('footer_explore_navigation', '[{"label":"Opportunities","url":"/casinos-for-sale"},{"label":"Services","url":"/services"},{"label":"About us","url":"/about"}]', NULL, '2026-10-15T00:00:00.000Z'),
  ('footer_navigation', '[{"label":"FAQ","url":"/faq"},{"label":"Contact","url":"/contact"},{"label":"Privacy","url":"/legal/privacy"},{"label":"Terms","url":"/legal/terms"},{"label":"Cookies","url":"/legal/cookies"},{"label":"AML / KYC","url":"/legal/aml-kyc"},{"label":"Sanctions","url":"/legal/sanctions"},{"label":"Anti-bribery","url":"/legal/anti-bribery"},{"label":"Listing disclaimer","url":"/legal/disclaimer"},{"label":"Complaints","url":"/legal/complaints"}]', NULL, '2026-10-15T00:00:00.000Z');

UPDATE platform_settings SET value_json = '[{"label":"Opportunities","url":"/casinos-for-sale"},{"label":"Services","url":"/services"},{"label":"About","url":"/about"},{"label":"FAQ","url":"/faq"},{"label":"Contact our team","url":"/contact"}]', updated_at = '2026-10-15T00:00:00.000Z'
 WHERE setting_key = 'header_navigation' AND value_json IN ('', '[]', '""', 'null');
UPDATE platform_settings SET value_json = '[{"label":"Opportunities","url":"/casinos-for-sale"},{"label":"Services","url":"/services"},{"label":"About us","url":"/about"}]', updated_at = '2026-10-15T00:00:00.000Z'
 WHERE setting_key = 'footer_explore_navigation' AND value_json IN ('', '[]', '""', 'null');
UPDATE platform_settings SET value_json = '[{"label":"FAQ","url":"/faq"},{"label":"Contact","url":"/contact"},{"label":"Privacy","url":"/legal/privacy"},{"label":"Terms","url":"/legal/terms"},{"label":"Cookies","url":"/legal/cookies"},{"label":"AML / KYC","url":"/legal/aml-kyc"},{"label":"Sanctions","url":"/legal/sanctions"},{"label":"Anti-bribery","url":"/legal/anti-bribery"},{"label":"Listing disclaimer","url":"/legal/disclaimer"},{"label":"Complaints","url":"/legal/complaints"}]', updated_at = '2026-10-15T00:00:00.000Z'
 WHERE setting_key = 'footer_navigation' AND value_json IN ('', '[]', '""', 'null');
