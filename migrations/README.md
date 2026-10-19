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
- `0020_seed_cookie_terms_url.sql`: seeds the Terms of use link for the cookie banner (INSERT OR IGNORE).

- `0021_media_library.sql`: shared staff-managed media assets, folders, visibility, hashes and upload metadata. Images are public on upload; documents remain private until reviewed and explicitly published by an authorized administrator.

- `0022_sprint25_security_baseline.sql`: adds confidential-by-default price visibility, optional safe public media URL slugs, and expiring single-use buyer email-code challenges.
- `0023_sprint26_opportunity_integrity.sql`: indexes the opportunity review queue and version history.
- `0024_sprint27_audit_operations.sql`: indexes audit events by action, entity type and actor alongside descending creation time for the audit review filters.
- `0025_sprint29_staff_session_controls.sql`: indexes active staff sessions and per-user session activity for the super-administrator session inventory.

- `0026_sprint30_buyer_session_controls.sql`: adds an index for active buyer-session inventory and last-activity ordering.

### 0027 — Sprint 27 review queue indexes
Adds indexes for pending review, assigned-broker review queues, and stale verification checks. Safe to apply after `0026_sprint30_buyer_session_controls.sql`.

### 0028 — Sprint 29 compliance access tier
Rebuilds the grant/document tables with a tier-3 option while preserving existing rows and indexes. Tier 3 is enforced server-side for super administrators only and requires a detailed approval reason. Apply only after taking a verified staging backup and checking the target migration history.

### 0029 — Sprint 29 signed NDA uploads
Adds integrity and scanner-provenance fields for buyer-uploaded signed NDA PDFs. The upload route requires a verified clean scanner result, stores the object only in private R2, and audits staff downloads.

### 0030 — Sprint 30 NDA legal gate
Deactivates the repository-seeded NDA acknowledgement if it is still the active template and has no managed private R2 object. This prevents an unreviewed bootstrap document from being presented as an approved NDA. Create a managed, counsel-approved version and explicitly activate it before enabling NDA requests in staging or production.

Sprint 32 adds no migration. The numbered set remains 0001 through 0030.

- `0032_seller_enquiries.sql`: seller enquiry table and a unique logical-notification key on `notification_jobs`. Additive.
- `0033_audit_append_only.sql`: triggers making `audit_logs` append-only (rollback: drop the two triggers). Apply to staging first.
- `0034_seller_staff_workflow.sql`: seller notes, communications, status history, qualification reviews; extra columns on `staff_tasks` (task_type, outcome, reminder/escalation state). Additive.
- `0035_seller_history_append_only.sql`: append-only triggers for the four tables above (rollback: drop the eight triggers).
- `0036_sellers_authority_publication.sql`: sellers, seller changes, seller-opportunity links, authority/mandate records and events, publication reviews and events; `seller_enquiries.seller_id`. Additive.
- `0037_seller_publication_gate_triggers.sql`: append-only triggers for the new history tables and the seller publication gate on `opportunities` (rollback: drop the triggers named in the file). Apply to staging first and confirm existing publication flows still work.
