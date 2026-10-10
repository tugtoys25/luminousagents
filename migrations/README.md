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
