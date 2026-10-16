# Sprint 30 — controlled release and recovery runbook

## Status

This is an operational procedure, not evidence that a release has occurred. The cumulative candidate must not be deployed until the required automated checks pass and the owner verifies actual Cloudflare resources, secrets, legal approval and rollback access.

## Protected baseline and candidate

- Protected baseline: Sprint 23 source archive. Keep it read-only.
- Cumulative candidate: Sprint 30 plus the completion hardening changes documented in `SPRINT_31_COMPLETION_REPORT.md`.
- Never apply migrations to production during exploratory testing.
- Do not copy placeholder D1/KV IDs into a real environment. Use IDs obtained from the owner's Cloudflare account.

## Preflight

1. Confirm Node.js 22+ and pnpm 10.18.3.
2. Run `pnpm install --frozen-lockfile`.
3. Run `pnpm check`, `pnpm format:check`, all existing preflight scripts and `pnpm preflight:sprint31`.
4. Review every test failure; do not treat parser-only checks as typechecking.
5. Verify the target environment name and D1 database ID before running any migration command.
6. Confirm Resend sender-domain authentication, Turnstile, scanner URL/token/signing secret, `OTP_ENCRYPTION_KEY`, `IP_HASH_SECRET`, and cache-purge credentials are set as Worker secrets/variables, never committed.
7. Verify the queue, dead-letter queue, R2 bucket, KV namespace, D1 database and cron binding belong to the intended environment.

## Staging rehearsal

1. Take a D1 export and an R2 inventory/backup using the approved account procedure. Record timestamps and object counts.
2. Restore the backup to an isolated recovery target and compare migration history, table counts, opportunity counts, document hashes and media references.
3. Apply pending migrations to staging only. Confirm migrations 0001–0030 are applied exactly once.
4. Deploy the tagged candidate to staging.
5. Test public directory filters/sorting/pagination, public price redaction, sitemap/robots, private media transitions, media deletion/slug-reference guards, buyer profile editing, both buyer sign-in methods, NDA click-wrap, signed PDF upload and scan, access tiers 1–3, document download and revocation.
6. Submit enquiries and verify staff notification, buyer acknowledgement, broker assignment, follow-up task, queue retry, Resend idempotency, dead-letter recovery and audit events.
7. Test role denials with direct API calls, not just hidden UI controls.
8. Record screenshots/logs, test results, migration history and any accepted risks.

## Backup and rollback

- Prefer a previous immutable Worker deployment/version rollback for code rollback. Confirm the exact prior deployment and bindings before initiating rollback.
- Never assume rolling back code reverses D1 migrations. Migration 0028 rebuilds grant/document tables, migration 0029 adds NDA scan metadata, and migration 0030 deactivates the unapproved bootstrap NDA; validate backward compatibility before applying them.
- Before a migration, export D1 and verify a restore in isolation. For R2, back up object keys and hashes; a D1 export alone is insufficient.
- If a migration or deployment fails, stop further changes, preserve logs, restore the database/object state only under the approved recovery plan, then restore the previous Worker version. Do not improvise destructive SQL against production.
- Verify `/healthz`, public pages, staff login, buyer login, enquiry submission, private document denial/authorized download and queue health after rollback.

## Production release gate

Production release is blocked until all are true:

- [ ] Frozen install, typecheck, lint, formatting, unit/integration/security tests pass.
- [ ] Browser E2E tests pass for staff, broker, buyer, public visitor and unauthorized actors.
- [ ] Staging D1 migration and D1/R2 restore rehearsals pass.
- [ ] Trusted malware scanner, Resend, Turnstile and email sender are tested with real staging credentials.
- [ ] No unresolved critical/high security findings.
- [ ] Confidential prices are absent from unauthorized HTML, API, search results, SEO, structured data, exports and notification payloads.
- [ ] Legal/compliance owner approves NDA language, privacy/terms/cookies, listing claims and publication rights; a managed counsel-approved NDA template is active.
- [ ] Staff MFA decision is documented; custom auth remains the required authentication model and Cloudflare Access is not required.
- [ ] Actual production D1/KV/R2/Queue IDs and secrets are verified; no placeholders remain in the selected production configuration.
- [ ] Monitoring, queue/scanner/email alerts, incident contacts and rollback instructions are tested.
- [ ] Owner approves the exact release tag and deployment window.

## After release

Run the smoke suite, monitor errors and queue depth, check email/scanner health, confirm no unexpected public/private media transition, and retain the release evidence. Do not publish any of the 198 legacy opportunities without individual content/authority/rights review.
