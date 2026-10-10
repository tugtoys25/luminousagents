# Database migrations

Migrations are numbered, additive and forward-only unless a separately documented rollback is safe and necessary.

- `0001_core_users_sessions.sql`: users and hashed session-token records.
- `0002_opportunities.sql`: opportunities, content-review gate, versions and media metadata.
- `0003_enquiries_crm.sql`: enquiry inbox, notes and tasks.
- `0004_nda_dataroom.sql`: buyer profiles, saved opportunities, NDA templates/requests, access grants and document metadata.
- `0005_audit_notifications.sql`: audit events and notification-job records.
- `0006_seed_reference_data.sql`: minimal app settings.
- `0007_buyer_auth_security.sql`: buyer OTP and NDA/access indexes.
- `0008_operations_tasks.sql`: staff tasks and notification recovery index.
- `0009_document_integrity.sql`: document SHA-256 hashes and fail-closed scan status.

The legacy import is generated separately by `pnpm import:legacy` and checked with `pnpm verify:import`. It deliberately sets every imported listing to `public_visibility = 0` and `content_review_status = 'pending'`. Never publish legacy records without content review.

- `0010_sprint10_readiness.sql`: scanner provenance, NDA acceptance template-hash snapshot, and the version-1 bootstrap NDA template hash.
- `0011_seed_legacy_listings.sql`: repeatable seed of all 198 legacy records; all remain draft, pending review and non-public.
- `0012_broker_assignment.sql`: broker ownership for opportunities and scoped staff workflows.

The SQL seed is idempotent by `legacy_id`; it is not a substitute for the team's `verify:import` run against the configured D1 environment. Confirm row counts and status distribution after applying migrations in staging.

- `0013_sprint12_port.sql`: adds listing classifications/labels, media integrity metadata, and buyer privacy-consent versioning. Previously public, approved records retain public classification; all other records default confidential.

- `0014_custom_staff_auth.sql`: adds nullable staff password hashes for native email/password login; existing staff rows are preserved and can be provisioned through the one-time setup route.
- `0015_platform_management.sql`: platform settings, managed pages/forms/submissions and `password_reset_tokens`.
- `0016_auth_hardening.sql`: Sprint 16 unified email + password auth. Adds `password_updated_at`, `failed_login_count`, `locked_until`, `must_change_password` to `users`, `session_type` to `sessions` (existing staff sessions are backfilled as `staff`), and `purpose` to `password_reset_tokens`. `buyer_login_codes` is no longer used but kept (forward-only).
- `0017_forms_nda_workflow.sql`: managed-form submission triage columns and an active-grant index. Apply before deploying Sprint 19 code.
- `0018_seed_contact_settings.sql`: seeds public contact settings (phones, emails, WhatsApp) with INSERT OR IGNORE so dashboard edits are never overwritten. Apply before deploying Sprint 21 UI changes.
- `0019_seed_cookie_banner.sql`: seeds the cookie/privacy banner settings (INSERT OR IGNORE). Apply before deploying the configurable banner.
