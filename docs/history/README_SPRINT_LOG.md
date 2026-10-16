# Casinos of Mayfair Platform

A confidential B2B brokerage platform for casino and casino-hotel investment opportunities. This is a
Cloudflare Workers / TypeScript foundation, not a deployed or launch-ready application yet.

## Sprint 0 status

Implemented in this repository:

- Strict TypeScript configuration and a single Hono Worker entry point.
- Minimal `/healthz` endpoint, safe error responses, request IDs, and baseline security headers.
- Wrangler environment structure for `dev`, `staging`, and `production` with D1, private R2, KV, and
  queue bindings named consistently across environments.
- Workers Vitest integration-test setup, lint/format configuration, and GitHub Actions workflows.
- Architecture, security, deployment, testing, runbook, decisions, and limitations documentation.
- An untouched copy of the supplied legacy project under `legacy-source/mayfair/` for later review.

Not yet completed or verified:

- No dependency installation, lockfile generation, typecheck, lint, tests, or Wrangler validation could
  be run in the authoring environment because the npm registry was unreachable.
- Cloudflare resource IDs are explicit placeholders. No resources were created and no deployment was
  performed; Cloudflare credentials and owner-controlled account configuration are required.
- No domain cut-over, buyer/staff authentication, CMS, import, email, NDA, or document workflow exists
  in Sprint 0.

## Requirements

- Node.js 22+
- pnpm 10.18.3 (Corepack may install it when the package registry is reachable)
- A Cloudflare account with Workers, D1, R2, KV and Queues permissions for deployment stages

## Local development

1. Install pnpm and dependencies: `corepack enable && corepack prepare pnpm@10.18.3 --activate && pnpm install`.
2. Replace placeholder resource IDs and bucket/queue names in `wrangler.jsonc` with resources created
   in your Cloudflare account before using remote resources or deploying.
3. Start local Worker: `pnpm dev`.
4. Run checks: `pnpm typecheck`, `pnpm lint`, and `pnpm test`.
5. Open `/healthz`; expected body: `{"status":"ok","service":"mayfair-platform"}`.

Once dependencies can be resolved in a network-enabled environment, generate and commit `pnpm-lock.yaml`;
CI is intentionally configured with `--frozen-lockfile` and will not deploy without it. Do not treat a deployment as successful
until the GitHub Actions run and the deployed `/healthz` endpoint are independently checked.

## Environment configuration

Each Wrangler environment must have its own D1 database, private R2 bucket, KV namespace, and queues.
Never reuse production storage for local or staging tests. See `docs/DEPLOYMENT.md` for provisioning
and secrets guidance.

## Scope guardrails

Sprint 0 is only the foundation. Do not place confidential files in `public/`, do not expose R2 public
URLs, do not add secrets to source control, and do not import or publish legacy listing content before
it has passed the data and content review described in the Blueprint.

## Sprint 1 status — data and public-site foundation

Implemented in the current workspace:

- Fourteen numbered D1 migrations covering core identity/sessions, opportunities and versions, enquiries/CRM, buyer profiles/NDA/data room, audit/notifications, reference data, buyer auth security, staff tasks, document integrity, legacy listings, broker assignment, Sprint 12 fields and custom staff authentication.
- An idempotent legacy SQL generator and verifier for the 198 supplied listings.
- Public SSR pages for home, directory search/filter/pagination, opportunity detail, country market pages, casino-hotel listings, archive, services, about, FAQ, contact, legal placeholders, `robots.txt`, and `sitemap.xml`.
- Responsive red/gold site styling and the legacy image assets copied into `public/static/img/`.
- A single explicit opportunity serializer and publication checks requiring lifecycle `published`, content review `approved`, and `public_visibility = 1`.

Local static verification performed: the original six migrations and generated import SQL were applied twice to an in-memory SQLite database; the import remained idempotent with 198 rows, 198 unique slugs, 198 pending content reviews and zero publicly visible records. This validates SQL compatibility against local SQLite, not Cloudflare D1 deployment behavior.

At Sprint 1, contact capture and runtime checks were still pending; contact capture was added in Sprint 3 and notification delivery/task operations were added in Sprint 5. Dependencies remain unavailable in this authoring environment, so full typecheck, lint, Vitest and Wrangler validation have not been completed. Legal pages remain placeholders. Do not deploy or publish listings until runtime checks, Cloudflare D1 verification, content review and legal review are complete.

## Sprint 2 status — staff access and opportunity CMS API

Implemented in the current workspace:

- Email + password sign-in for staff on `/dashboard/*` (PBKDF2-SHA256 hashes, hashed server-side session tokens in an HttpOnly cookie, lockout after repeated failures), followed by an active staff-user lookup in D1 on every request. Staff accounts are only created by the first-administrator setup or by a super administrator.
- Role-gated opportunity creation, editing, review, publication-state changes, and audit-log read endpoints.
- SSR dashboard overview, opportunity search/filter API, version snapshots, and audit events.
- Opportunity edits return the record to pending review and force public visibility off; publication requires approved content and a verification timestamp.

See `docs/SPRINT_2.md` and `scripts/provision-staff.sql.example` for Access configuration, role mapping and endpoint details. The interactive CMS editor is not complete; CMS write operations are API endpoints in this increment. Full typecheck, lint, test suite and Wrangler validation remain unverified because dependencies cannot currently be downloaded. This project is still not deployed or launch-ready.

## Sprint 3 — Enquiries and CRM

See [`docs/SPRINT_3.md`](docs/SPRINT_3.md) for the public enquiry form, CRM API, rate limiting, audit trail, and queue handoff. Email delivery was implemented in Sprint 5; live provider configuration and staging verification remain launch blockers.

## Sprint 4 — Buyer access and private data room

See [`docs/SPRINT_4.md`](docs/SPRINT_4.md) for buyer password/session APIs, NDA request/review, access grants, and private R2 document access. Sprint 25 retains custom email/password authentication and adds email one-time-code login as an alternative for buyers; Cloudflare Access is not required. Sprint 5 added notification delivery source code; live provider setup, `OTP_ENCRYPTION_KEY`, buyer provisioning, malware scanning, NDA review UI, and a full browser-facing buyer portal remain launch blockers.

## Sprint 5 — operational delivery and staff follow-ups

- Notification Queue consumer supports password reset / set-password emails, new enquiry alerts, and NDA review alerts through Resend. Set `RESEND_API_KEY`, `EMAIL_FROM`, and `OPS_EMAIL` as Worker secrets/vars as appropriate; verify the sender domain with your email provider first. `OTP_ENCRYPTION_KEY` must be a base64-encoded 32-byte key for encrypted OTP payloads. Never place real secrets in `wrangler.jsonc` or commit them.
- A five-minute scheduled recovery pass re-enqueues due notification jobs and resets jobs stuck in `processing` for over ten minutes. Delivery attempts are capped at five before a job becomes `dead`; administrators can retry eligible jobs from `/dashboard/notifications/ui`. Queue delivery is at-least-once, so notification templates and operational workflows must tolerate rare duplicate sends.
- Staff task API and interface: `/dashboard/tasks/ui`. Create, assign, prioritize, set due dates, and update task status. Assignee must be an active staff user ID.
- Staff can revoke an access grant with `POST /dashboard/access-grants/:id/revoke` and a required reason. The change is audited.
- Browser state-changing requests to `/api/buyer/*` and `/dashboard/*` require an exact same-origin `Origin` header. API clients outside a browser must deliberately supply the platform origin.
- Notification job APIs: `GET /dashboard/notifications/jobs` and `POST /dashboard/notifications/jobs/:id/retry`. Job payloads, buyer codes, and message bodies are never included in the operational status view.

### Sprint 5 configuration and validation

Create the Cloudflare Queues named for the selected environment before deployment and verify each queue consumer binding. Configure the cron trigger, sender domain, email secrets, `OTP_ENCRYPTION_KEY` (also encrypts password-reset links at rest) and resource IDs independently for staging and production. This repository has not been deployed to Cloudflare. TypeScript typechecking, lint, integration tests, queue provider delivery, and live D1/R2/Access checks remain required before launch.

## Sprint 6 additions

See [`docs/SPRINT_6.md`](docs/SPRINT_6.md) for the buyer account portal, staff NDA review interface, file signature checks, SHA-256 metadata, and fail-closed document release gate. Documents must be externally scanned before staff can mark them clean; the platform does not yet include a malware scanner.

## Sprint 7 verification

See `docs/SPRINT_7.md` for the security-invariant checks, malware scanner integration requirements, and staging exit checklist. Run `pnpm preflight:sprint7` for dependency-free source checks.

## Sprint 10 — staging-blocker implementation

Sprint 10 supersedes earlier statements that the opportunity CMS and buyer provisioning are absent. The package now includes `/dashboard/opportunities/ui`, `/dashboard/buyers/ui`, `/dashboard/nda-templates/ui`, a signed-result scanner adapter, broker ownership/scoping, public enquiry task and broker-notification routing, CSP-safe dashboard CSS, configurable SEO metadata, short public cache policy and encrypted D1 backup workflow. See [`docs/history/SPRINT_10.md`](docs/history/SPRINT_10.md), [`docs/BACKUPS_AND_RESTORE.md`](docs/BACKUPS_AND_RESTORE.md), and [`docs/PRODUCT_DECISIONS.md`](docs/PRODUCT_DECISIONS.md).

Sprint 10 is still a staging candidate, not a verified production release. The scanner engine must be deployed/configured, Cloudflare resource IDs and secrets must be set, the pinned pnpm lockfile must be generated, and full CI and staging evidence must be produced. The NDA bootstrap wording is a legal-review draft, all 198 legacy records remain pending/private, and R2 document backups, a restore drill, full role/CSRF/OTP/queue/XSS/Playwright suites, accessibility/load tests and rollback rehearsal remain outstanding.

## Sprint 13 integration (deployed Sprint 11 baseline)

Sprint 13 ports the missing Sprint 12 portal and listing-management features into the existing project while preserving `wrangler.jsonc`, Cloudflare environment/resource bindings, deployment scripts, and `pnpm-lock.yaml`.

- Staff entry: `/admin/login` (email + password). Forgot password: `/admin/forgot-password`. Change password: `/admin/change-password`. Super administrators manage staff at `/dashboard/staff/ui`.
- One-time first administrator setup: `/admin/setup`; configure `ADMIN_BOOTSTRAP_TOKEN` as a Worker secret with at least 32 random characters. The form collects name, email and password and creates the **super administrator**; it closes once any staff user exists, unless an existing active staff account still has no password — that account's email plus the same token sets its first password (credential migration). No external identity provider is required.
- Buyer registration: `/register`; new accounts remain invited until staff approve them at `/dashboard/buyers/ui`. Registration requires privacy consent and is rate-limited.
- Listing studio: `/dashboard/opportunities/ui`; supports classification, up to 12 labels, and private R2 JPEG/PNG images with signature and SHA-256 checks. Images are delivered only while their listing is published, approved, public-visible, and classified public.
- Access grants: `/dashboard/access-grants/ui`; revocation remains audited and immediately applies on the next authorization check.
- Apply migrations `0013_sprint12_port.sql` and `0014_custom_staff_auth.sql` before using the new fields and custom staff login. It preserves previously public/approved/published listings by classifying them public; imported legacy records remain private and confidential.

The source integration is not a substitute for running the deployed project's full checks. After merging, run `pnpm check`, `pnpm preflight:final`, `pnpm preflight:sprint10`, and verify the complete workflows in staging before deployment. Do not change the existing deployment resource identifiers or bindings as part of this feature port.

Sprint 16 verification note: all 16 SQL migrations were applied in order to in-memory SQLite and the new TypeScript/JavaScript passed syntax transpilation. Full typecheck, lint and Vitest were not run because dependencies could not be installed in the authoring environment; run `pnpm check` and `pnpm test` before staging.

## Authentication (Sprint 16: unified email + password)

Staff use custom **email + password** authentication without Cloudflare Access. Buyers can sign in with a password or request an emailed one-time code. Buyers who register without a password can set one later or continue using codes.

| Flow                 | Buyer                                                | Staff                                                        |
| -------------------- | ---------------------------------------------------- | ------------------------------------------------------------ |
| Sign in              | `/account`                                           | `/admin/login`                                               |
| Register             | `/register` (account stays `invited` until approved) | first admin: `/admin/setup`; others created by a super admin |
| Forgot password      | `/forgot-password`                                   | `/admin/forgot-password`                                     |
| Reset (emailed link) | `/reset-password?token=…`                            | `/admin/reset-password?token=…`                              |
| Change password      | `/account/change-password`                           | `/admin/change-password`                                     |

Passwords are hashed with PBKDF2-SHA256 (100,000 iterations, the Workers maximum) and a per-user salt; minimum length 12 with letters and numbers. Five wrong passwords lock the account for 15 minutes; sign-in, reset and registration are also rate limited per IP and email. Reset links are single-use, expire after 60 minutes (invites after 3 days), and a successful reset or password change signs out all other sessions. Responses never reveal whether an email is registered. Apply `migrations/0016_auth_hardening.sql` (builds on 0014 and 0015) before deploying. Hashes from Sprint 14/15 with a different iteration count are accepted and silently upgraded at the next successful login.

**Existing buyers have no password yet; existing staff may not either.** Buyers and staff can use _Forgot password_ (needs `RESEND_API_KEY`, `EMAIL_FROM` and `OTP_ENCRYPTION_KEY`). Password-less staff can also use `/admin/setup` with their email and `ADMIN_BOOTSTRAP_TOKEN`. Otherwise generate a hash with `node scripts/hash-password.mjs` and set it with the SQL in `scripts/provision-staff.sql.example`. See `docs/SPRINT_14.md`.

## Sprint 25 — security baseline

Sprint 25 adds an explicit `price_visibility` policy (confidential by default), public-tier serialization that redacts prices unless explicitly approved public, buyer email-code login, password-optional buyer registration, and configurable safe media URL slugs. Images remain public by default and can be changed to private; public media responses use `no-store` so visibility changes are not held in a shared cache. See [`docs/SPRINT_25_SECURITY_BASELINE.md`](docs/SPRINT_25_SECURITY_BASELINE.md).

## Sprint 24 — shared media library

The staff workspace now includes a searchable Media library at `/dashboard/media/ui`. It supports image and document uploads, metadata/folder editing, visibility controls, copying public URLs, downloading private files, and removal. The shared media picker is automatically added to dashboard fields that represent image URLs (logos, favicons, OG/featured images, covers, backgrounds, avatars, thumbnails and hero media) and document URLs (PDFs, attachments, policy/terms links). Existing opportunity-specific listing media and confidential data-room files remain separate.

Apply `migrations/0021_media_library.sql` before deploying Sprint 24. JPEG, PNG, WebP and GIF images are public by default so staff can immediately use them on public pages; PDF, DOCX and XLSX documents default to private. Only administrators can publish images and only super administrators can publish documents. Review rights and confidentiality before making an asset public. See [`docs/SPRINT_24_MEDIA_LIBRARY.md`](docs/SPRINT_24_MEDIA_LIBRARY.md) for the deployment and staging checklist.


## Sprint 26 — opportunity integrity and recovery

Sprint 26 adds a version-history panel and safe restore-as-draft workflow, reasoned bulk content review (up to 50 records per request), administrator-only CSV export, and a controlled CSV import that updates existing IDs only (up to 100 rows per batch). CSV cells are quoted and formula-like values are prefixed to reduce spreadsheet formula injection risk. Restores never reinstate publication: restored records become private drafts and require fresh review.

Apply migration `0023_sprint26_opportunity_integrity.sql` after Sprint 25 migration `0022_sprint25_security_baseline.sql`. See `docs/SPRINT_26_OPPORTUNITY_INTEGRITY.md` for endpoints, safeguards, and validation limitations.

## Sprint 27 — audit operations

Sprint 27 adds a dedicated, read-only audit log page at `/dashboard/audit/ui`, with server-side search, action/entity/date filters, bounded pagination, private caching headers and safe metadata rendering. The JSON endpoint remains at `/dashboard/audit`. Apply `migrations/0024_sprint27_audit_operations.sql` after migration 0023. See [`docs/SPRINT_27_AUDIT_OPERATIONS.md`](docs/SPRINT_27_AUDIT_OPERATIONS.md).


## Sprint 29 — staff session controls

Sprint 29 adds a super-administrator-only staff session inventory at `/dashboard/sessions/ui`. Authorized operators can inspect active staff sessions and revoke a selected session; the current session is protected from self-revocation. Session tokens and cookie values are never exposed, revocations are recorded in the audit log, and the endpoints use private/no-store caching. Apply `migrations/0025_sprint29_staff_session_controls.sql` after migration 0024. See [`docs/SPRINT_29_STAFF_SESSION_CONTROLS.md`](docs/SPRINT_29_STAFF_SESSION_CONTROLS.md).

## Sprint 30 — Buyer session controls

Super administrators can review active buyer sessions and revoke an individual session from `/dashboard/buyer-sessions/ui`. Revocation is audited and does not suspend the account or change data-room grants. See `docs/SPRINT_30_BUYER_SESSION_CONTROLS.md`. Full dependency-backed tests and staging validation remain required before release.


## Sprint 31 cumulative completion hardening

The Sprint 30 cumulative source has additional implementation for buyer profile/requirements, review queue and verification dates, safe media reference handling, public media hash verification, public directory sorting, tier-3 access controls, signed NDA PDF upload/scanning, and a private data-room document management UI. See `docs/handoffs/SPRINT_31_HANDOFF.txt`, `docs/SPRINT_30_RELEASE_RUNBOOK.md`, and run `pnpm preflight:sprint31`. These source changes are not a production certification; follow the full staging, external-provider and restore gates before deployment.

## Sprint 32 — completion hardening (staging candidate, not certified production)

Additive on the Sprint 23-30 candidate: no deletions, no new migration, dependencies and lockfile unchanged.

- Redaction: all money amounts are withheld from public text for confidential-price listings (`src/domain/opportunities/redaction.ts`).
- Lifecycle state machine enforced on publication; `GET /dashboard/opportunities/lifecycle-transitions`.
- Reconciliation: `GET /dashboard/opportunities/reconciliation` and `pnpm audit:reconcile`.
- Fixed: buyer email-code request threw on every call (`generic()`); static tests now run in Node and are excluded from `tsc`.
- Generated role matrix: `docs/ROLE_ROUTE_MATRIX.md` (`pnpm docs:role-matrix`).
- Audits you can run with Node 22.18+ and no install: `pnpm audit:leaks`, `pnpm audit:reconcile`, `pnpm preflight:sprint32`.
- `e2e/` Playwright suite for staging (separate package), `docs/MONITORING_AND_ALERTS.md`, R2 document backup workflow.

Read `docs/SPRINT_32_COMPLETION.md` for what was verified and, more importantly, what was not. `pnpm check` has not been run on this source.

