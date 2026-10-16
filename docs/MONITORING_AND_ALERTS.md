# Monitoring and alerts

Status: **specified, not configured.** Nothing here is live until each alert has been created and tested by
deliberately triggering it. Assign a named owner and a backup to every row before launch.

## What to watch

| Signal | Where it comes from | Alert when | Owner | Backup |
| --- | --- | --- | --- | --- |
| Site down | External uptime check on `GET /healthz` and on `/` | Two consecutive failures, or `/healthz` not 200 | | |
| Error spike | Cloudflare Workers observability: error rate and 5xx count | Error rate above the agreed baseline for 10 minutes | | |
| Notification backlog | `notification_jobs` rows with status `queued` older than 15 minutes, or status `failed` | Any `dead` job; more than 5 `failed` | | |
| Dead-letter queue | The Cloudflare queue dead-letter queue depth | Depth above 0 | | |
| Email provider | Resend dashboard bounces, complaints and API errors | Any bounce or complaint on enquiry mail; API errors | | |
| Malware scanner | `documents` rows with a scan status other than `clean` for more than 30 minutes; scanner timeouts in logs | Any document stuck unscanned; scanner unreachable | | |
| Sign-in abuse | `429 RATE_LIMITED` counts on the login and code endpoints; `buyer.email_code_requested` volume in `audit_logs` | Sudden rise against baseline | | |
| Backups | The D1 and R2 backup workflow runs | Any failed or missing run; no success in 26 hours | | |
| Publication invariants | `GET /dashboard/opportunities/reconciliation` returns `blockers` | Any blocker (a public record that is not approved, verified or published) | | |
| Certificates and domain | TLS expiry and DNS | Expiry within 21 days | | |

## Structured log events

Logs are one JSON line per event (`src/lib/logger.ts`: `level`, `event`, `ts`, `env`, plus fields). Keys that look
sensitive (password, token, email, ip, message, cookie, session, otp, mfa) are redacted and strings are truncated;
error messages are never logged, only the error name. Filter in Workers Logs by `event`:

| Event | Meaning | Action |
| --- | --- | --- |
| `request_failed` | An unhandled 5xx (fields: requestId, method, path, status, errorType) | Alert on rate; trace by requestId |
| `scheduled_recovery_failed` | The 5-minute cron could not recover queued notifications | Alert on any occurrence |
| `notification_delivery_failed`, `notification_recovery_enqueue_failed` | Email or queue problems | Check Resend and the DLQ |
| `turnstile_bypassed` | `TURNSTILE_ENFORCEMENT=log-only` let a failed challenge through | Must be zero once rollout ends |

## How to check the database signals

Run these read-only against the environment's D1 (for example with `wrangler d1 execute <db> --remote --command "..."`):

```sql
-- Notification backlog
SELECT status, COUNT(*) FROM notification_jobs GROUP BY status;
SELECT COUNT(*) FROM notification_jobs WHERE status = 'queued' AND created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-15 minutes');

-- Documents not yet clean
SELECT scan_status, COUNT(*) FROM documents GROUP BY scan_status;
```

Column names are those used by the current schema; confirm them against `migrations/` before relying on a query.

## Incident response outline

1. Acknowledge the alert and name an incident lead in the team channel.
2. Contain: for a suspected data exposure, set affected listings to `public_visibility = 0` through the dashboard
   publication route (never by direct database edit), and revoke relevant buyer or staff sessions from
   `/dashboard/sessions/ui` and `/dashboard/buyer-sessions/ui`.
3. Preserve evidence: export the audit log for the window (`/dashboard/audit/export.csv`) and note request ids.
4. Fix, deploy through CI to staging first, run the end-to-end suite, then release.
5. Record what happened, the time to detect and to recover, and what will prevent a repeat.

Rollback is a redeploy of the previous tagged release. Migrations are forward-only, so any release that adds a
migration needs a written reversal plan before it ships.

## Evidence required before this is marked done

- Screenshot or export of each alert rule, and a record of one deliberate test of each.
- The named owners above, filled in.
- One completed restore drill (`docs/BACKUPS_AND_RESTORE.md`) covering both D1 and the R2 documents bucket.
