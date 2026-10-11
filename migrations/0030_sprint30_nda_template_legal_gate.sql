-- Sprint 30 launch hardening: the repository bootstrap NDA is not legal-approved content.
-- Keep it out of buyer flows until counsel-approved content is stored as a managed R2 version.
UPDATE nda_templates
SET status = 'draft'
WHERE r2_key IS NULL
  AND name = 'Mayfair NDA Acknowledgement'
  AND status = 'active';
