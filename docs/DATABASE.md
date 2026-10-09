# Database operations

D1 migrations are in `migrations/` and must be applied in order. Review SQL and take a verified backup before destructive changes. Use `.github/workflows/migrate.yml` to request staging or production migrations. Production must be a protected GitHub environment with required reviewers. Confirm `wrangler d1 migrations list ... --remote` before and after applying migrations. Do not edit already-applied migrations; add a new migration. Nightly staging SQL exports are created by `.github/workflows/nightly-backup.yml`; this does not back up R2 objects. Restore drill is mandatory before production and after material schema changes.

## Sprint 10 migrations

- `0010_sprint10_readiness.sql` adds scanner provenance fields to `documents`, a template-hash snapshot to `nda_requests`, and a version-1 active NDA template hash. The corresponding repository template is `docs/nda-template-v1.md`; it is a legal-review draft, not production-approved wording.
- `0011_seed_legacy_listings.sql` imports the 198 legacy records idempotently by `legacy_id`. All remain `draft`, `pending`, and `public_visibility=0`. Verified local SQLite counts: 198 records; legacy status distribution `OPPORTUNITY=109`, `SOLD / STATUS UPDATE=71`, `OFF THE MARKET=16`, `ON HOLD / UNDER OFFER=2`.
