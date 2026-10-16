# Sprint 7 — security verification and staging readiness

## Scope and honest status

This increment adds repeatable local security checks and a release-gate plan around the Sprint 6 source. It does **not** claim a production malware scanner, a live Cloudflare staging deployment, or full application test success. Those require provider credentials, dependency installation, and an actual staging environment.

## Added

- `scripts/sprint7-preflight.mjs`: dependency-free preflight checks for required security invariants in the checked-in source and migrations.
- `test/unit/sprint7-security-invariants.test.ts`: Vitest regression checks for fail-closed document scan defaults and source-level release/download gates.
- This sprint report and a staging execution checklist.

## Security invariants checked

1. Migration 0009 defaults document scan status to `pending` and constrains values to `pending`, `clean`, or `rejected`.
2. Uploaded files are persisted with `pending` status and a SHA-256 digest.
3. Buyer document listing/download queries exclude non-clean documents.
4. The staff release endpoint requires a reason and requires a scanner reference when status becomes `clean`.
5. Release audit details include the document hash, so operators can correlate the decision with the exact file digest.

The preflight is a source guard, not a substitute for behavioural integration tests. It does not prove authorization correctness, runtime behavior, or that a scanner reference is truthful.

## Malware scanning integration: still a release blocker

The current release endpoint accepts a staff-supplied scanner reference; it does not verify a scanner's signature or independently scan the file. Keep this workflow disabled for production release until an adapter is selected and implemented. The adapter must:

- scan the exact private R2 object bytes and compare the computed SHA-256 with the database digest;
- fail closed on timeout, unsupported file, scanner error, digest mismatch, or missing verdict;
- accept only an authenticated scanner result (signed callback or server-to-server API), not a free-text reference;
- persist provider, scan job ID, verdict, scanned digest, timestamp, and engine/signature version;
- make `clean` transitions atomic and auditable, and prevent stale results from releasing a changed object;
- include tests for clean, malicious, timeout, invalid signature, wrong digest, duplicate callback, and deleted document.

## Required execution in a connected development environment

Run from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm exec prettier --check .
node scripts/sprint7-preflight.mjs
```

The supplied Sprint 6 archive does not include `pnpm-lock.yaml`; therefore `pnpm install --frozen-lockfile` is expected to fail until the team generates and commits a lockfile. Do not remove `--frozen-lockfile` from CI to hide that issue.

## Staging checklist

- [ ] Generate and commit the lockfile from the approved package manifest.
- [ ] Install dependencies and capture real output for typecheck, lint, tests, and formatting.
- [ ] Add the scanner adapter and provider-specific secrets/bindings; test against a non-production bucket.
- [ ] Verify buyer downloads return denied for `pending` and `rejected`, and work only for `clean` + active grant + eligible opportunity.
- [ ] Verify expired/revoked grants, unpublished/unapproved opportunities, wrong buyer, and insufficient tier are denied.
- [ ] Verify staff role enforcement, CSRF/origin policy, and audit log records for every release/rejection.
- [ ] Test OTP delivery, rate limits, session expiry/revocation, and real email provider in staging.
- [ ] Verify D1 migrations are applied through a controlled migration workflow before deploy.
- [ ] Keep all 198 legacy records unpublished until reviewed and approved individually.
- [ ] Record staging URL, deployment ID, migration result, test logs, and rollback owner.

## Exit criteria

Sprint 7 is not production-ready until the checklist items marked above are evidenced with real command output and a staging run. This archive is a source increment and verification scaffold, not a claim that those external checks have already passed.
