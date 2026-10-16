# Casinos of Mayfair — Sprint 8

## Production blockers: security integration, workflow verification, deployment controls, and legacy publication audit

**Increment type:** production-readiness hardening. **Status:** source and operating dossier prepared; live integrations and staging evidence remain unverified.

## Objective

Close the highest-risk gaps identified after Sprint 6/7 without weakening fail-closed behavior or claiming that source checks equal production verification.

## Workstream A — Trusted malware scanning (P0)

The current implementation has file-signature checks, SHA-256 metadata, a `pending` default, and a staff release gate. A staff-entered scanner reference is not evidence of a real scan. Do not release buyer-visible documents until this workstream is complete.

Required implementation contract:

1. Choose an approved malware scanning provider and document data residency, retention, maximum file size, supported formats, service authentication, and incident handling.
2. Scan the exact private R2 object version/bytes. Compute SHA-256 from the bytes read by the scanner adapter and compare it with the persisted upload digest.
3. Accept only an authenticated server-to-server response or verified signed callback. Never accept a buyer/staff free-text reference as proof.
4. Persist provider, provider job ID, verdict, scanned digest, scan timestamp, engine/signature version, and sanitized error details.
5. Fail closed for timeout, provider outage, unsupported format, missing verdict, malicious verdict, invalid signature, digest mismatch, deleted object, and stale/duplicate callbacks.
6. Release `clean` atomically only if the current document row, object identity/version, expected digest, and scan job still match. Record an audit event with the exact digest and provider result.
7. Restrict release transitions to a dedicated service path. Staff may request/resubmit a scan, but must not manually declare a file clean.

Required tests: clean verdict; malware verdict; timeout; provider 5xx; invalid signature; wrong digest; changed object; deleted object; duplicate callback; out-of-order callback; unsupported file; audit write failure; and concurrent release attempts.

## Workstream B — Buyer/staff end-to-end authorization (P0)

Add tests against a disposable D1 database and non-production R2 bucket. Cover:

- buyer without a session; wrong buyer; no grant; pending NDA; rejected NDA;
- active grant; expired grant; revoked grant; grant tier lower than document tier;
- opportunity draft, unpublished, on hold, rejected review, and approved/public;
- document pending, clean, and rejected scan states;
- list and direct-download endpoints independently (a hidden link is not authorization);
- staff role denied/allowed cases for NDA decisions, publication, and scan resubmission;
- audit event for allow/deny-sensitive actions without leaking file bytes, tokens, or secrets;
- OTP rate limiting, session expiry/revocation, origin/CSRF policy, and notification failures.

Assertions must verify status code, response body shape, and absence of document bytes on every denied download. Use fixtures, never production buyer data.

## Workstream C — Reproducible build and Cloudflare staging (P0)

1. Use Node 22 and the package manager version declared in `package.json` (`pnpm@10.18.3`).
2. Generate `pnpm-lock.yaml` from the approved manifest in a network-enabled development environment and commit it. Do not hand-author dependency integrity values.
3. Run `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm exec prettier --check .`, and `node scripts/sprint7-preflight.mjs`.
4. Replace placeholder D1 database IDs and KV namespace IDs in each environment with real, environment-specific IDs. Confirm R2 bucket and queue names exist and are correctly bound.
5. Keep secrets out of `wrangler.jsonc`; provision them through Cloudflare secrets and document required secret names without values.
6. Apply D1 migrations to a disposable database first, then staging using the reviewed migration workflow. Capture migration output and rollback/recovery plan.
7. Deploy staging only after all CI checks pass. Record commit SHA, deployment ID, staging URL, migration results, test artifacts, and rollback owner.
8. Do not deploy production from this increment without explicit release approval and evidence review.

## Workstream D — 198 legacy opportunity records (P0)

All 198 imported records remain non-public until each record is reviewed. Before any publication:

- export a dated inventory with ID, slug, lifecycle, `public_visibility`, content-review status, source provenance, reviewer, and decision;
- confirm every record is not publicly eligible unless lifecycle is `published`, content review is `approved`, and public visibility is enabled;
- review current ownership/authority to market, status, location, content accuracy, image/document rights, confidentiality, and stale/duplicate records;
- require named reviewer, timestamp, and reason for approval/rejection; audit each decision;
- verify public list, search, sitemap, SEO pages, API endpoints, and direct slug access all apply the same publication predicate;
- publish one approved record at a time; do not bulk-publish based on import success.

Run a read-only inventory query first:

```sql
SELECT id, slug, title, lifecycle, public_visibility, content_review_status, updated_at
FROM opportunities
ORDER BY created_at ASC;

SELECT COUNT(*) AS total,
       SUM(CASE WHEN lifecycle = 'published' AND public_visibility = 1 AND content_review_status = 'approved' THEN 1 ELSE 0 END) AS eligible_public,
       SUM(CASE WHEN lifecycle != 'published' OR public_visibility != 1 OR content_review_status != 'approved' THEN 1 ELSE 0 END) AS not_publicly_eligible
FROM opportunities;
```

The actual total must be checked in the target database; do not assume it remains 198 after later imports.

## Release gates

A gate is complete only when evidence is attached:

- [ ] Trusted scanner configured and security test matrix passes.
- [ ] Direct-download authorization matrix passes in automated integration tests.
- [ ] Staff authorization and audit checks pass.
- [ ] Lockfile committed and frozen install succeeds.
- [ ] Typecheck, lint, formatting, and all tests pass with logs retained.
- [ ] Cloudflare staging resources verified and migrations tested.
- [ ] Staging buyer/staff workflow tested with non-production data.
- [ ] Legacy inventory reconciled; all unreviewed records remain non-public.
- [ ] Security/release owner signs off on evidence and rollback plan.

## Acceptance criteria

Sprint 8 may be called **staging-verified** only after the gates above have evidence from the team's connected environment. It may be called **production-ready** only after the scanner, legal/NDA approval, operational monitoring, security review, and release approval are complete. Preparing this dossier or passing static checks does not satisfy those criteria.

## Handoff note

This archive deliberately does not invent a malware provider, credentials, Cloudflare resource IDs, scanner signatures, or deployment results. The team must select/configure the provider and run integration tests in a safe staging environment.
