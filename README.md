# Casinos of Mayfair Platform

Confidential B2B brokerage platform for casino and casino-hotel investment opportunities. Cloudflare
Workers + Hono + TypeScript, with D1, private R2, KV, Queues (with DLQ) and a 5-minute cron.
The MVP is live; this tree is the **release candidate for the P0 production-hardening release**
(structure, staff MFA, Turnstile everywhere, observability, backups, content readiness).
Not certified until CI is green and the launch checklist has evidence.

## Quick start

```bash
corepack enable && corepack prepare pnpm@10.18.3 --activate
pnpm install --frozen-lockfile
pnpm check            # typecheck + lint + all tests
pnpm dev              # local Worker; /healthz should return {"status":"ok",...}
```

Requires Node 22+. Local secrets go in `.dev.vars` (copy `.dev.vars.example`; never commit it).

## Layout

| Path | Purpose |
| --- | --- |
| `src/index.ts` | App wiring: middleware order, route mounting, error handler, queue + cron |
| `src/admin/routes/*.ts` | Staff dashboard routes, one file per domain; `src/admin/routes.ts` only mounts them |
| `src/auth/` | Staff/buyer sign-in, sessions, TOTP MFA (`totp.ts`, `mfa*.ts`) |
| `src/security/` | Turnstile verification and enforcement middleware |
| `src/domain/` | Business rules (opportunities, redaction, reconciliation) |
| `src/lib/` | `logger.ts` (structured, PII-scrubbing), `money.ts` (price parser), `errors.ts` |
| `src/operations/queue.ts` | Notification queue consumer and cron recovery |
| `migrations/` | Forward-only D1 migrations (`0031` = staff MFA) |
| `scripts/` | Guards and audits (below) |
| `docs/` | Architecture, security, runbook, backups, monitoring, launch checklist; `docs/history/` = old sprint records |

Layering: routes → services → `*repo.ts` (SQL lives only in repositories). New code must follow it.

## Guards and tools (all offline, all run in CI)

| Command | What it enforces |
| --- | --- |
| `pnpm check:structure` | 400-line file limit and SQL only in repo files, with a ratchet allowlist (`scripts/structure-allowlist.json`) that can only shrink |
| `pnpm docs:role-matrix:check` | `docs/ROLE_ROUTE_MATRIX.md` matches the real route/role wiring |
| `pnpm audit:leaks` | Public output never carries private listing fields |
| `pnpm audit:reconcile` | Migrations + seed give 198 listings and no publication blockers |
| `pnpm audit:content` | Reviewer worklist: missing country, ambiguous prices, risky copy (`--csv`, `--sql`) |
| `pnpm verify:restore <export.sql>` | Restore-drill checks on a decrypted D1 export |

## Required configuration (staging and production)

| Name | Kind | Notes |
| --- | --- | --- |
| `TURNSTILE_SECRET_KEY` | secret | Without it, protected POSTs fail closed (503) outside dev |
| `TURNSTILE_SITE_KEY` | var | Public widget key |
| `OTP_ENCRYPTION_KEY` | secret | base64 32 bytes; also encrypts MFA secrets unless `MFA_ENCRYPTION_KEY` is set |
| `MFA_ENCRYPTION_KEY` | secret, optional | Dedicated key for MFA secrets |
| `STAFF_MFA_REQUIRED_ROLES` | var, optional | Default `super_admin,admin`; empty string disables |
| `IP_HASH_SECRET`, `RESEND_API_KEY`, `EMAIL_FROM`, `OPS_EMAIL`, `PUBLIC_BASE_URL` | secrets/vars | As before |
| `TURNSTILE_ENFORCEMENT` | var, temporary | `log-only` while rolling out; remove afterwards |

## Release order

1. Merge to `main` → CI runs typecheck, lint, tests and all guards.
2. Deploy workflows apply D1 migrations **first**, then deploy the Worker.
3. Set secrets/vars above **before** the first deploy of this release (Turnstile fails closed).
4. Super admin enrols MFA at `/admin/mfa`, then verify sign-in, enquiry form and a restore drill.

See `docs/RUNBOOK.md`, `docs/SECURITY.md`, `docs/LAUNCH_CHECKLIST.md`, `docs/BACKUPS_AND_RESTORE.md`,
`docs/MONITORING_AND_ALERTS.md`. Product decisions: `docs/PRODUCT_DECISIONS.md`.
