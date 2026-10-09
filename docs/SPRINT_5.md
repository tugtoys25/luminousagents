# Sprint 5 — notifications, tasks, and operational hardening

## Implemented in source

1. Notification queue consumer for buyer login codes, public enquiries, and NDA review requests.
2. Resend API integration with escaped HTML content, plain-text fallback, secret-based credentials, and no raw email body/payload logging.
3. Retry handling with capped attempts and exponential backoff; durable D1 job state; scheduled recovery for queued jobs and stale `processing` jobs.
4. Staff notification operations view at `/dashboard/notifications/ui`, with payload-free status display and manual retry for eligible jobs.
5. Staff task API and interface at `/dashboard/tasks/ui`: create tasks, assign to active staff users, set priorities/due dates, and update status.
6. Audited access-grant revocation route requiring a reason.
7. Exact same-origin validation for state-changing buyer and staff requests.
8. Migration `0008_operations_tasks.sql` for staff task records and notification recovery index.

## Configuration

- Worker secrets: `RESEND_API_KEY`, `OTP_ENCRYPTION_KEY`.
- Worker vars/secrets: `EMAIL_FROM`, `OPS_EMAIL`, `PUBLIC_BASE_URL` (canonical base URL).
- Configure queue producer and consumer resources for each environment and confirm cron triggers are active.
- `OTP_ENCRYPTION_KEY` must decode from base64 to exactly 32 random bytes. Do not reuse a key between environments.

## Security and reliability notes

- Queue processing is at-least-once. Rare duplicate email delivery remains possible when the provider accepts an email but the worker fails before persisting `sent`.
- Job payloads are not exposed by the status API. Login-code payloads remain encrypted at rest in D1.
- After five delivery attempts a job enters `dead`; an administrator may retry it through the dashboard.
- Same-origin checks rely on the incoming request URL host. Validate Cloudflare/proxy host handling in staging before production.
- Access-grant revocation blocks subsequent data-room authorization checks; it cannot revoke files already downloaded by a buyer.

## Validation status

Local validation completed: TypeScript transpilation/syntax check passed for 18 source/test/config TypeScript files; all eight SQL migrations applied to an in-memory SQLite database; task insert smoke test passed; Wrangler JSON parsed. A full `tsc --noEmit` attempt stopped because `@cloudflare/workers-types` and `vitest/globals` are not installed. Vitest, ESLint, Wrangler validation, Cloudflare deployment, and live email delivery have not been verified.

## Remaining launch blockers

- Typecheck, lint, test suite, and Wrangler validation.
- Live staging tests for Queue retry/dead-letter, cron recovery, Resend, Access JWT, D1 transactions, R2 private objects, and buyer authorization.
- NDA review UI/template lifecycle, upload magic-byte validation and malware scanning, full buyer data-room UI, legal content, and end-to-end security review.
