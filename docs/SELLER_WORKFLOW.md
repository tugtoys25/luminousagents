# Seller enquiry workflow

Status: **Phase 1 of 4 written, not yet run.** See "Verification status" below.

## Phase plan
1. (this change) Public `/sell-a-casino`, `POST /api/sell-a-casino`, persistence, references, seller acknowledgement and internal alert emails, audit append-only protection.
2. Staff inbox, assignment, transition matrix, notes, communications, tasks and reminders.
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

## Not in Phase 1 (deferred, not stubbed)
Staff inbox and dashboard route (the alert links to `/dashboard` until Phase 2 changes `SELLER_DASHBOARD_PATH`), new permissions/roles, sellers, authority/mandates, tasks, communications table, follow-up and material-interest templates, retention job, e2e browser tests.

## Known limitations
- Turnstile hostname/action validation is not added (shared verifier in `turnstile-core.ts` unchanged).
- Per-session rate limiting is not implemented; only per-IP.
- No automatic duplicate detection beyond the idempotency key (by design: no merging by email or asset name).
- Privacy notice version is the version of the acknowledgement text (`seller-form-privacy-ack-v1`); it is not linked to the managed `/legal/privacy` page revision. Legal must review that page before launch.

## Verification status (honest)
Written but **not executed**: no dependencies are installed in the authoring environment and the network is disabled. Only `node --check` on the client script and a syntax-level `tsc` pass over the new files were run; the latter showed no syntax errors, but full `pnpm typecheck`, `pnpm lint`, `pnpm test`, the migrations, and any staging check are outstanding.
