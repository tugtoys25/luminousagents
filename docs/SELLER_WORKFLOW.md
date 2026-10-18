# Seller enquiry workflow

Status: **Phases 1 and 2 of 4 written. Not production-ready; see "Launch blockers".** See "Verification status" below.

## Phase plan
1. (done) Public `/sell-a-casino`, `POST /api/sell-a-casino`, persistence, references, seller acknowledgement and internal alert emails, audit append-only protection.
2. (done) Staff inbox, assignment, transition matrix, notes, communications, qualification, follow-up tasks and reminders.
3. Seller records, authority/mandate review, draft opportunity linking, server-side publication gates.
4. Seller follow-up and material-interest approval flows, retention review, runbook completion.

## What Phase 1 does
- `GET /sell-a-casino` renders the form (no upload, no account). Submission is JSON via `public/static/js/sell-form.js`; the page needs JavaScript (also required by Turnstile). The browser never puts form data or the reference in a URL.
- `POST /api/sell-a-casino`: JSON only, 32 KB limit, Turnstile (existing middleware, fail-closed outside dev), per-IP rate limit (5 per 10 minutes, KV, keyed hash of IP), honeypot, Zod validation shared in `src/seller/schema.ts`, unknown fields stripped (project policy).
- Idempotency: the browser sends a per-page-load key; only its HMAC is stored (`idempotency_hash`, UNIQUE). A repeat gets the same neutral 202 and reference and inserts nothing.
- Reference `CM-S-XXXXXX` from a CSPRNG, UNIQUE in the database, retried on collision.
- One D1 batch writes the enquiry (status `NEW`), an audit row, and two `notification_jobs` rows (the durable outbox) with logical keys `seller_enquiry_ack:<id>` and `seller_enquiry_internal_alert:<id>` (unique index `idx_notification_jobs_dedupe`). Enqueue happens afterwards; if it fails, the existing 5-minute recovery cron re-enqueues.
- Email: `seller_enquiry_received_v1` and `seller_enquiry_internal_alert_v1` (HTML + plain text, escaped). 4xx provider errors other than 408/429 are permanent and go straight to `dead`; others use the existing backoff (max 5 attempts). **"sent" means accepted by Resend, not delivered to an inbox.**
- Original submission is preserved in `original_submission_json`; later edits belong on seller records (Phase 3).
- Raw IPs and anti-abuse tokens are never stored.

## Configuration (all optional unless noted; see `.dev.vars.example`)
`SELLER_ALERT_RECIPIENTS` (**required for alerts**; unset => job retries then goes `dead`, visible in the notification monitor), `SELLER_EMAIL_FROM`, `SELLER_REPLY_TO`, `SELLER_COMPANY_WEBSITE`, `SELLER_ALERT_INCLUDE_PHONE`, `SELLER_ALERT_INCLUDE_PRICE`, `SELLER_MARKETING_CONSENT_ENABLED` (default off: checkbox hidden, consent never stored). Staging/production also need the existing `IP_HASH_SECRET`, Turnstile keys, `RESEND_API_KEY`, `EMAIL_FROM`, `OTP_ENCRYPTION_KEY`.

## Migrations
- `0032_seller_enquiries.sql`: `seller_enquiries`; `notification_jobs.dedupe_key` plus partial unique index. Additive.
- `0033_audit_append_only.sql`: triggers abort UPDATE/DELETE on `audit_logs`. Rollback: drop both triggers. Verified by grep that no application code updates or deletes audit rows. **Confirm the trigger migration applies under `wrangler d1 migrations apply` and the vitest migration reader before production.**

## Phase 2: staff workflow
- UI: `/dashboard/seller-enquiries/ui` (menu: Seller enquiries). List shows reference, name/organisation, status, asset, owner, next follow-up, received date; no email, phone or free text. Search matches reference, name, organisation or email. Filters: status, broker (incl. unassigned), asset type, country, received date range, follow-up overdue/due today. 25 per page.
- API (all under `/dashboard`, JSON): `GET /seller-enquiries`, `GET /seller-enquiries/:ref`, `POST /seller-enquiries/:ref/{assign,status,notes,communications,followups,qualification}`, `POST /seller-enquiries/:ref/followups/:taskId/complete`. Staff URLs use the public reference, not the database id; the id is stripped from responses. Unknown, malformed and out-of-scope references all return the same 404.
- Access: brokers see and work only enquiries assigned to them; admin/super_admin see all. Assignment, decline and close are manager-only (`seller_enquiries.assign` / `.close`). Editors, publishers and auditors have no seller access. There is **no separate compliance role**: authority review (Phase 3) will map to admin. New permissions are in `src/permissions/permissions.ts`; route role lists in `src/admin/shared.ts`; `docs/ROLE_ROUTE_MATRIX.md` regenerated.
- Lifecycle (`src/seller/lifecycle.ts`, enforced server-side): NEW→ASSIGNED|CONTACT_ATTEMPTED; ASSIGNED→CONTACT_ATTEMPTED; CONTACT_ATTEMPTED→AWAITING_SELLER|QUALIFICATION; AWAITING_SELLER→CONTACT_ATTEMPTED|QUALIFICATION; QUALIFICATION→AWAITING_SELLER|AUTHORITY_REVIEW|QUALIFIED; AUTHORITY_REVIEW→QUALIFICATION|QUALIFIED; QUALIFIED→CONVERTED; every open status→DECLINED|CLOSED. DECLINED, CLOSED and CONVERTED are terminal. Rules: decline/close need a reason (5+ characters) and confirmation; QUALIFIED, AUTHORITY_REVIEW also need confirmation; progressing needs an owner; QUALIFIED needs a recorded PASS qualification review; ASSIGNED only via the assign action; **CONVERTED is not reachable through the status endpoint** (explicit conversion arrives in Phase 3).
- Concurrency and atomicity: status/assignment changes use `version` optimistic locking; the history and audit rows are written in the same D1 batch and only if the row changed (`WHERE changes() > 0`). A stale request gets 409 `VERSION_CONFLICT`.
- Records (migrations 0034/0035; append-only by trigger): staff notes (audit stores id and classification, never text), communications, status/assignment history, qualification reviews (11-item checklist; "compliance routed" records only that the matter was sent to your legal/KYC/AML process, never that checks passed). The acknowledgement email is recorded as a system communication marked "accepted by provider".
- Follow-ups reuse `staff_tasks` (`related_entity_type = 'seller_enquiry'`, plus type/outcome/reminder/escalation columns), so they also appear on the existing Tasks page. A broker can only schedule follow-ups for themselves. Completing a task checks it belongs to the enquiry in the URL.
- First response: set when the first human outbound communication is recorded (the automatic acknowledgement does not count).
- Reminders (`seller_followup_due_v1`): the existing cron runs `runSellerReminders`; one job per task per reminder window and one escalation per task, enforced by the unique `dedupe_key`. Completed or closed-out work is skipped at send time. Configuration: `SELLER_REMINDERS_ENABLED` (default on; `false` disables), `SELLER_REMINDER_INTERVAL_HOURS` (default 24), `SELLER_ESCALATION_AFTER_HOURS` and `SELLER_ESCALATION_RECIPIENTS` (escalation off unless both set). These are environment settings, not a dashboard screen. Nothing here is a commitment to sellers.

## Not yet built
Phase 3: seller records, authority and mandate review, conversion (CONVERTED), draft opportunity linking, publication gates. Phase 4: staff-sent follow-up email and material-interest approval flow, retention review, export, runbook completion. Also not built: email notification to a newly assigned broker, audit of permission denials, MFA step-up on close/decline, dashboard-editable reminder settings, browser end-to-end tests.

## Known limitations
- Turnstile hostname/action validation is not added (shared verifier in `turnstile-core.ts` unchanged).
- Per-session rate limiting is not implemented; only per-IP.
- No automatic duplicate detection beyond the idempotency key (by design: no merging by email or asset name).
- Privacy notice version is the version of the acknowledgement text (`seller-form-privacy-ack-v1`); it is not linked to the managed `/legal/privacy` page revision. Legal must review that page before launch.

## Verification status (honest)
Written but **not executed**: no dependencies are installed in the authoring environment and the network is disabled. What did run: `node --check` on the client scripts; `node scripts/role-matrix.mjs --check` (passes, 109 routes); `node scripts/check-structure.mjs` (passes); a hand-run of the static invariants (route guards, no innerHTML, no leaked columns); and a syntax-level `tsc` pass that shows no errors in the new code beyond missing-dependency noise. Not run: `pnpm typecheck`, `pnpm lint`, `pnpm test` (all new unit tests are unexecuted), the migrations on D1 (0033 and 0035 contain triggers and need confirming), and any staging check.

## Notes from applying Phase 1
- Migration 0033 (append-only `audit_logs`) made four existing tests fail because their cleanup deleted audit rows (`buyer-download-e2e`, `password-auth`, `staff-mfa`, `portal-repo`). They were fixed by dropping the trigger inside the test database before cleanup. Consequences: (a) after those tests run, the trigger is gone for the rest of that test database, so no test currently proves it holds; (b) production code, scripts, workflows and docs contain no update or delete of `audit_logs` (searched), so the trigger does not affect runtime. If you ever add an audit-retention job, it will need a deliberate, audited exception to this trigger.
- Strict compiler flags (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`) and the `no-control-regex` lint rule apply to this code; Phase 2 follows the same fixes you made after Phase 1.

## Launch blockers (nothing below is verified)
1. `pnpm typecheck`, `pnpm lint`, `pnpm test` (including all Phase 1-2 tests) must pass in CI; none has been run on this code by its author.
2. Migrations 0032-0035 must be applied and checked on staging (the triggers in 0033 and 0035 in particular), with a restore-drill backup taken first.
3. Real Turnstile and Resend verification on staging: submit `/sell-a-casino`, confirm the acknowledgement and internal alert arrive, confirm a bad recipient is not retried indefinitely, confirm a duplicate submit creates one record.
4. Set `SELLER_ALERT_RECIPIENTS`, a verified `SELLER_EMAIL_FROM`/`SELLER_REPLY_TO`, and confirm `IP_HASH_SECRET` exists in staging and production.
5. Legal review of the privacy notice, declaration wording, retention periods, marketing consent and cross-border processing.
6. Phases 3 and 4 (authority/mandate gates, opportunity conversion and publication gates, staff follow-up and material-interest sending, retention and export, runbook) are not built, so the end-to-end workflow in the brief is incomplete.
7. No browser end-to-end tests exist for the seller flow.
