# Sprint 10 — staging blockers and readiness

## Implemented in this source package

- `src/security/malware-scanner.ts`: reads the exact private R2 object, recomputes SHA-256, sends raw bytes to a configured scanner service, verifies an HMAC-signed provider response, and returns clean/malicious/unsupported verdicts. The staff scan route atomically persists the verdict metadata and audit record; clean is only possible through this verified scan path.
- Migration `0010_sprint10_readiness.sql`: adds scanner provenance columns, stores NDA template hash on acceptance, and seeds a versioned active bootstrap template hash.
- Migration `0011_seed_legacy_listings.sql`: repeatable legacy seed of 198 records. All remain `draft`, `pending`, and `public_visibility=0`.
- Migration `0012_broker_assignment.sql`: broker ownership and scoped staff views for opportunities, enquiries, NDA requests and tasks. Opportunity enquiries resolve to their assigned broker, create a follow-up task due the next working day, queue a broker notification and visitor acknowledgement, and require Turnstile plus IP-hash configuration in staging/production.
- NDA template API and UI: private R2-backed version creation, hash verification, activation, buyer-side display of the exact active template, and salted IP hash plus template hash captured on acceptance.
- Staff buyer provisioning UI and endpoints; public self-registration remains disabled.
- Staff opportunity CMS UI for create/edit, pending-review queue, approval/rejection, and separate publication action.
- Dashboard and buyer inline CSS moved into static stylesheets; CSP-compatible external scripts/styles.
- Short CDN caching for anonymous public GET pages and static asset caching. Publication route attempts Cloudflare URL purge when a scoped zone token is configured; without it the 60-second shared-cache TTL remains the fallback.
- Configurable canonical domain, sitemap/robots base URL, Organization/WebSite/BreadcrumbList/FAQPage JSON-LD, and web manifest.
- D1 backup workflow writes encrypted exports to private staging and production R2 buckets rather than GitHub artifacts. R2 deal documents still need a separate backup/replication policy and the restore drill is not done.
- Removed the unused `AUDIT_QUEUE` binding and added scanner-focused unit tests and a Sprint 10 source readiness script.

## External prerequisites and known incomplete items

1. The real scanner engine/provider is not bundled. Deploy a trusted HTTPS scanner service that implements the contract in `src/security/malware-scanner.ts`, then configure `MALWARE_SCANNER_API_URL`, `MALWARE_SCANNER_API_TOKEN`, `MALWARE_SCANNER_SIGNING_SECRET`, and optionally `MALWARE_SCANNER_PROVIDER`. Confirm data-processing/privacy terms before sending confidential files to any third party.
2. No lockfile could be generated because Corepack could not reach `registry.npmjs.org` in this environment. Run pinned `pnpm@10.18.3 install`, commit `pnpm-lock.yaml`, then run typecheck, lint, Prettier check, unit tests and E2E tests.
3. Replace D1/KV placeholder IDs, create the private R2 buckets, notification queues and DLQs for all environments, and configure required Cloudflare secrets/vars. No Cloudflare account credentials were available here.
4. Configure private backup buckets and GitHub `staging`/`production-backup` environment secrets, verify the CLI workflow, and complete/document a restore drill. R2 deal documents are not yet included in backup workflow.
5. The seeded NDA wording is a draft placeholder for hash/version flow, not legal advice. Counsel must approve or replace it before production.
6. The 198 legacy records were imported as private/pending. A human must review authority to market, accuracy, rights, confidentiality, duplicates and staleness individually, then publish one at a time.
7. Still required before production: complete role-by-route and CSRF/OTP brute-force suites, queue retry/duplicate delivery suites, Playwright smoke, load/Lighthouse/WCAG evidence, alerts/error reporting, and staging/rollback rehearsal.

## Evidence status

- Verified locally: SQL migrations execute successfully against SQLite; 198 legacy rows load with `pending` review and zero public visibility; JS syntax checks and Wrangler JSON syntax checks pass; source readiness gate passes except for missing lockfile.
- Not verified: dependency installation, typecheck, lint, Prettier, unit/E2E execution, scanner provider integration, Cloudflare resource configuration, browser CSP console, staging, production, backup execution, restore drill, legal approval, accessibility or load test.
