# Operations runbook

## Deployment

1. Confirm a reviewed commit and passing CI on the exact SHA.
2. Verify secrets/resource IDs for the target environment and run release preflight.
3. Export D1 backup and confirm backup artifact exists; separately verify R2 backup coverage.
4. Apply migrations using the protected migration workflow; verify migration list.
5. Deploy only through the environment-protected workflow. Run health and buyer/staff smoke tests.
6. If checks fail, stop rollout, disable affected routes or roll back to the last known-good Worker version, and follow the incident process. Never roll back D1 schema blindly; use a forward fix where data has changed.

## Scanner incident

If scanner is unavailable or returns an unknown verdict, do not release files. Keep documents pending, alert operations, preserve request IDs and scanner references, and retry after service recovery. Never manually mark clean based solely on a reference string.

## Data incident

Restrict access, preserve audit logs, notify the incident owner and legal/privacy contact, assess scope, and follow counsel-approved notification obligations. Never place buyer data or secrets in public issue trackers.

## Backup/restore

Nightly workflow exports staging D1 only. Production backup, R2 object backup, retention, encryption, and restore are separate operational requirements. Conduct a restore drill in an isolated environment and record duration, row/object counts and integrity checks before production launch.

## P0 operations

- **Locked-out admin:** another super admin resets MFA at `/admin/mfa`; if none, run `DELETE FROM staff_mfa WHERE user_id = '<id>'` on D1 and log it.
- **Turnstile outage or misconfiguration (login/forms returning 503/422):** fix the keys; as a short-lived measure set `TURNSTILE_ENFORCEMENT=log-only`, deploy, then remove it and confirm no `turnstile_bypassed` events.
- **Bad release:** redeploy the previous Worker version; leave migrations applied (additive).
- **Tracing an error:** find `request_failed` in Workers Logs, search by `requestId`.
