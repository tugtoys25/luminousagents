# Sprint 32 — completion record

Base: the cumulative Sprint 23–30 remediated candidate (which already includes the "Sprint 30 remediation patch").
The Sprint 23 source is untouched. Sprint 32 is additive: no file was removed, no migration was added, and
`package.json` dependencies and `pnpm-lock.yaml` are unchanged, so `pnpm install --frozen-lockfile` stays valid.

**This is a hardened staging candidate. It is not certified production-ready.** The items under
"Not done / needs evidence" cannot be closed from source code.

## What changed

### Confidentiality

- New `src/domain/opportunities/redaction.ts`. For a public (tier 0) viewer of a confidential-price listing, the
  serializer now replaces the asking price **and every other money amount in free text** (turnover, debt, rent,
  deposits, funding) with `[amount withheld]`. Previously only the exact stored price string and "price …"
  phrases were scrubbed, so a price written as `$360,000,000` slipped past a stored `$360m` (confirmed on
  `listing-47`).
- Non-money text is preserved: `5-star`, `75% funding`, `330 rooms`, and floor areas such as `600 2m` are unchanged.
- `serialize.ts` now imports the module. Staff and tier 1+ viewers are unaffected.
- Over-redaction is deliberate. Redaction is a safety net, **not a substitute for reviewing each listing**.

### Lifecycle state machine

- New `src/domain/opportunities/lifecycle.ts` and enforcement in `POST /dashboard/opportunities/:id/publication`.
  Invalid moves return `409 INVALID_LIFECYCLE_TRANSITION` with the allowed next states. A draft can no longer jump
  straight to published, even for a super administrator.
- `admin` and `super_admin` get a small explicit set of correction moves (for example reopening a sold or
  archived listing for review).
- The existing publication guard (approved content, public classification, verification date) is unchanged.
- `GET /dashboard/opportunities/lifecycle-transitions` returns the matrix for the caller's role.
- The audit event now records `fromLifecycle`.

| From | Standard next states | Extra for admin / super_admin |
| --- | --- | --- |
| draft | in_review, archived | |
| in_review | draft, published, archived | |
| published | in_review, on_hold, under_offer, sold, off_market, archived | |
| on_hold | published, in_review, off_market, archived | |
| under_offer | published, on_hold, sold, off_market, archived | |
| sold | archived | in_review, on_hold, off_market |
| off_market | in_review, archived | draft, on_hold |
| archived | none | draft, in_review |

Staying in the same state is always allowed, which is how visibility is changed on its own.

### Reconciliation

- `GET /dashboard/opportunities/reconciliation` (admin, auditor, super_admin) reports totals, groupings, duplicate
  checks and publication-invariant blockers, and whether the set is publishable.
- `node scripts/sprint32-reconcile.mjs` runs the same checks offline against the migrations in an in-memory SQLite
  database. It reads the check list from `reconciliation.ts`, so the two cannot drift apart.

### Defects found and fixed in the candidate

1. **Buyer email-code sign-in could never succeed.** In `POST /api/buyer/auth/request-code`, `generic` was an
   object but was called as `generic()`, which throws `TypeError` on every request (a real account after the email
   was sent, an unknown address immediately). Fixed; guarded by a test. A working type check would have caught this,
   which is evidence `pnpm check` had not been run on that code.
2. **Static source tests could not run.** The Sprint 24–31 tests read repository files with `node:fs` but were not
   excluded from the Workers test pool (the repo's own `vitest.config.ts` says that cannot work) and not excluded
   from `tsc`. They now run in Node via `vitest.node.config.ts` and are excluded from the type check, the same way
   Sprints 7, 10 and 16 already were. This has not been run under real Vitest here; see below.
3. Two dashboard data routes had no explicit `requireRole`. They already scoped brokers to assigned records; roles
   are now named explicitly (same six roles, no behaviour change).

### Role-by-route matrix

`docs/ROLE_ROUTE_MATRIX.md` is generated from the code by `node scripts/sprint32-role-matrix.mjs` (94 routes).
`--check` fails if it is out of date. It describes route-level access only; record-level rules (a broker seeing
only assigned rows) live in the handlers and still need per-role tests.

### Test and operations additions

- Tests: `sprint32-redaction`, `sprint32-lifecycle`, `sprint32-legacy-public-leak` (reads the real 198-row seed
  and renders public pages from a fixture), `sprint32-security-invariants`.
- `e2e/`: a Playwright suite for staging, kept in its own folder and package so the root lockfile is untouched.
- `.github/workflows/r2-documents-backup.yml`: copy-only backup of the private R2 bucket (data room, signed NDAs,
  media) to a second bucket with checksum verification. Never run.
- `docs/MONITORING_AND_ALERTS.md`, `docs/SPRINT_32_OWNER_DECISIONS.md`.
- `pnpm preflight:sprint32`, `pnpm audit:leaks`, `pnpm audit:reconcile`, `pnpm docs:role-matrix`.

## Verified in the build environment

| Check | Result |
| --- | --- |
| All 30 migrations apply in order (Node built-in SQLite) | Pass; 198 listings; foreign keys clean |
| All 198 listings are private, pending review, confidential classification | Pass |
| `scripts/sprint32-leak-audit.mjs`: real serializer, anonymous viewer, all 198 listings | Pass: 0 price fields, 0 money-like text, 0 asking prices |
| Same audit run against the previous serializer | Fails with 111 findings (so the audit does discriminate) |
| Pure tests (`sprint32-redaction`, `sprint32-lifecycle`) and the existing `opportunity-serialization` and `sprint25` tests, run through a minimal harness in Node | 35 of 35 pass |
| Static guard mutation check (re-introduce `generic()`) | The guard fails, as intended |
| `sprint32-role-matrix.mjs --check`, `sprint32-reconcile.mjs` | Pass |

The harness was a hand-written stand-in for Vitest's `describe`/`it`/`expect`, not Vitest itself.

## Not done / needs evidence

These could not be done from source, or were not possible in the build environment. None is closed.

- **`pnpm install` and `pnpm check` were not run** (the package registry was unreachable). Whether the project
  typechecks, lints and passes its full Vitest suite is **unknown**. Run `pnpm install --frozen-lockfile && pnpm check`
  first and fix whatever it reports.
- **Workers-pool tests were not executed**, including `sprint32-legacy-public-leak.test.ts`, which renders public
  pages and the sitemap. Run them in CI.
- **Playwright suite not executed** (no browser or network).
- **wrangler.jsonc** still has placeholder D1 and KV ids for the default and production environments. Real,
  owner-controlled ids are required; none were invented.
- **Real services**: malware scanner, Resend sender domain (SPF, DKIM, DMARC), Turnstile keys, queue dead-letter
  behaviour. All need staging proof.
- **Backups**: the D1 workflow and the new R2 workflow have never run. No restore drill has been done.
- **Monitoring and alerting**: documented, not configured.
- **Staff MFA, a compliance role, access tier 3 policy, Decision 3, media-permission roles, sold-listing
  visibility**: owner decisions, not guessed. See `SPRINT_32_OWNER_DECISIONS.md`.
- **Legal**: counsel-approved NDA text, privacy, terms, cookies, AML/KYC/sanctions and gaming-regulation review.
  The seeded NDA remains a draft and no NDA is active for buyers until a counsel-approved version is uploaded.
- **Content**: every one of the 198 listings still needs human review. Reconciliation shows, on the seed:
  198 pending review, 198 never verified, 198 classified confidential (none can go public until a person
  changes that), 66 with no country, 7 with no summary, 189 with price text but no structured amount.
- **Not built, by design (Phase 2)**: seller portal, deal pipeline, e-signature and workflows, analytics,
  scheduled publishing, buyer matching, AI search.

## Behaviour changes to be aware of

- Public text for confidential listings is more aggressively redacted than before.
- Publication requests that skip lifecycle steps are now refused with 409.
- Public media is still served with caching disabled and a SHA-256 check on every request, which costs a full
  object read per image view. Measure this in staging before launch and decide whether to cache by content hash.

## Correction to the earlier audit

The earlier audit report said `listing-32` also leaked its asking price. Re-checking against the old serializer
shows it did not; that was a false positive from a digit-matching heuristic. `listing-47` was a real leak.
