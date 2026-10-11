# Cumulative remediation report — Sprint 23 through Sprint 30

## Candidate basis

This candidate preserves the Sprint 23 source and deployment configuration by integrating the existing cumulative Sprint 24–30 source, then applying the remediation described below. The original Sprint 23 workspace remains untouched. `wrangler.jsonc` and `pnpm-lock.yaml` are preserved from the Sprint 30 cumulative archive; only the package scripts were extended.

## Implemented in this candidate

### Sprint 25 — security baseline

- Expanded the central opportunity serializer's viewer tier type to include tier 3 while retaining public tier 0 as the default.
- Fixed a confidential-data side channel in buyer saved-opportunity responses by returning central-serializer output instead of raw opportunity summary text.
- Prevented numeric/currency/price-oriented public directory searches from returning confidential listings merely because the raw private price phrase matches.
- Public media delivery now checks stored size and SHA-256 against the D1 record before serving bytes; media responses are not shared-cacheable.
- Added provider idempotency keys for email delivery retries.

### Sprint 26 — opportunity integrity and CMS

- Added an authenticated review queue that identifies pending review, missing country/summary, never-verified/stale content, and publication invariant problems.
- Added a publisher-authorized “mark verified” endpoint with required reason and audit event; verification does not publish content.
- Added supporting review-queue indexes.
- Added directory sorting by newest, title and market, with a whitelist and pagination links that preserve the sort selection.

### Sprint 27 — public website and SEO

- Added a defensive filter against price-oriented search side channels.
- Added regression checks for central serializer use in buyer saved listings, public search behavior, and the review queue.
- Existing public pages, canonical metadata, JSON-LD, sitemap and robots remain in the cumulative source; they still require complete browser and content review.

### Sprint 28 — CRM and notification reliability

- Added stable Resend `Idempotency-Key` values derived from notification-job IDs so provider retries can avoid duplicate sends where the provider's idempotency window applies.
- Scheduled recovery now re-enqueues due `failed` jobs below the attempt limit and marks exhausted failed jobs dead.
- Existing enquiry transaction creates enquiry, task, audit and durable notification rows; real email delivery and provider-failure recovery remain staging acceptance tests.

### Sprint 29 — buyer, NDA and data room

- Added buyer profile and acquisition-requirements GET/PUT APIs and account UI, with validation, budget range checks, deduplicated country preferences, private/no-store responses and audit logging.
- Added signed NDA PDF upload for the owning buyer only, strict PDF signature/size checks, private R2 storage, mandatory trusted malware scan, SHA-256/scanner provenance, duplicate-upload/race protection, audit event and staff notification.
- Added staff-only audited signed-PDF download with hash verification.
- Added tier 3 to access-grant and document constraints. Tier 3 grant and upload operations are super-admin-only; tier-3 approvals require a detailed justification. Migration `0028` rebuilds the two tables while preserving existing rows and scan metadata.
- Added a staff data-room document UI for private uploads, scan state, explicit scan action and deletion; files remain unavailable to buyers unless the trusted scanner marks them clean.
- Added reference-aware media deletion and public URL slug-change guards for settings, managed pages/forms and opportunity content.

### Sprint 30 — release hardening

- Added migration `0029` for signed NDA PDF hash and scan provenance. Added migration `0030` to ensure the repository-seeded NDA draft is not active until a managed counsel-approved template is explicitly activated.
- Added `docs/SPRINT_30_RELEASE_RUNBOOK.md` with staging, backup/restore, rollback and production acceptance gates.
- Added a static source gate `pnpm preflight:sprint31` and a new regression test file.

## Local verification performed

- TypeScript/TSX syntax transpilation using the installed TypeScript compiler: **57 files, zero syntax diagnostics**.
- `node --check` on modified browser scripts: passed.
- All 30 numbered SQL migrations applied in sequence to a local in-memory SQLite database.
- Migration seed preserved all 198 opportunities; all 198 default to confidential price visibility.
- SQLite `PRAGMA foreign_key_check`: no violations.
- Migration 0028 data-preservation test: existing grant/document rows and scan metadata survived the table rebuild.
- `scripts/sprint31-completion-gate.mjs`: 13/13 static source checks passed.
- Existing static preflights: Sprint 7, Sprint 10, Sprint 13 and Sprint 16 passed.

## Not verified — do not call this production-certified yet

- Full `pnpm check`, Vitest, ESLint and Prettier were **not run** because project dependencies are absent and registry access was unavailable. `tsc --noEmit` is blocked at missing `@cloudflare/vitest-pool-workers`, `@cloudflare/workers-types` and `vitest/globals` type definitions. Syntax transpilation is not a substitute for typechecking.
- No Playwright/browser E2E run was completed.
- No live Cloudflare D1/R2/KV/Queue deployment, scanner, Turnstile or Resend test was performed.
- `wrangler.jsonc` retains its existing environment configuration. The production/default D1/KV placeholder IDs are not to be replaced with invented values; use actual owner-controlled Cloudflare IDs.
- Staff MFA expectations, NDA/legal approval, listing publication authority/rights, privacy/terms/cookie approval, operational monitoring and a real D1/R2 restore drill remain external release gates.
- No migration was applied to live Cloudflare resources and no deployment was performed.

## Acceptance recommendation

Use this as a **remediated staging candidate**, not an already-certified production release. Install the pinned dependencies, fix all typecheck/lint/test failures, run browser journeys against isolated staging resources, complete scanner/email/Turnstile tests, perform a D1/R2 restore rehearsal, and obtain owner/legal approval before production release.
