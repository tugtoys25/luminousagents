# Sprint 16 — unified email + password authentication on the Sprint 15 platform

Sprint 16 merges two independently built authentication implementations: the Sprint 14/15 staff-only login and a complete staff + buyer password system. The Sprint 15 platform-management features (settings, GA4 consent, WhatsApp widget, managed pages and forms, compliance pages) are unchanged.

## Result

| Flow                    | Buyer                                        | Staff                                                                                |
| ----------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------ |
| Sign in                 | `/account`                                   | `/admin/login`                                                                       |
| Register                | `/register` (stays `invited` until approved) | first admin or password-less staff: `/admin/setup`; others via `/dashboard/staff/ui` |
| Forgot / reset password | `/forgot-password`, `/reset-password`        | `/admin/forgot-password`, `/admin/reset-password`                                    |
| Change password         | `/account/change-password`                   | `/admin/change-password`                                                             |
| Sign out                | button on `/account`                         | `/admin/logout`                                                                      |

APIs: `POST /api/{admin|buyer}/auth/{login,logout,forgot-password,reset-password,change-password}`, `POST /api/admin/bootstrap`, `POST /api/buyer/register`. Super admins: `GET/POST /dashboard/staff`, `PATCH /dashboard/staff/:id`, `POST /dashboard/staff/:id/reset-password`.

## Decisions taken in the merge

- **Base:** Sprint 15 codebase. Its auth files (`password-routes.ts`, `portal-*.js`) were replaced, not layered.
- **Hashing:** PBKDF2-SHA256 at **100,000 iterations**. Sprint 15 used 600,000, which exceeds the Workers WebCrypto cap that several sources report (confirm on staging with the smoke test below). Existing hashes with other iteration counts are still accepted and are upgraded at the next successful login (`needsRehash`).
- **Kept from Sprint 15:** `/admin/setup` can give an existing, active staff account with no password its first password using email + `ADMIN_BOOTSTRAP_TOKEN` (credential migration). Accounts that already have a password are never changed there.
- **Kept from Sprint 14/15 migrations:** 0014 and 0015 are untouched. `0016_auth_hardening.sql` adds lockout/forced-change columns, `sessions.session_type` (existing sessions of staff users are backfilled to `staff`) and `password_reset_tokens.purpose`. The Sprint 15 reset-token column `used_at` is reused.
- **Reset email path:** reset and set-password links now go through the notification queue with AES-GCM-encrypted payloads, so `OTP_ENCRYPTION_KEY` (plus `RESEND_API_KEY` and `EMAIL_FROM`) is **required** for forgot-password. Sprint 15 sent staff reset mail directly and did not need the key.
- **Test infrastructure restored:** Sprint 15 had removed `test/apply-migrations.ts`, `vitest.node.config.ts` and the migration setup in `vitest.config.ts`, which would make every D1-backed test fail with "no such table". These are restored from Sprint 14, along with the `test` / `test:node` scripts.
- **Not changed (flagged):** Sprint 15 loosened the CSP (`style-src 'unsafe-inline'`, `img-src https:`, Google Tag Manager/Analytics hosts) for branding and GA4. Review whether that is acceptable for authenticated pages.

## Security behaviour

- Password policy: ≥12 characters, letters and numbers, not common, must not contain the email name.
- 5 failed attempts lock an account for 15 minutes (D1), plus KV rate limits per IP and per email on login, reset and registration.
- Uniform responses for unknown emails (login, forgot-password, registration); dummy hashing keeps timing similar.
- Reset links: single-use, SHA-256 hashed at rest, 60 minutes (3 days for invites). Reset or password change revokes other sessions; suspending staff or buyers revokes theirs.
- Staff sessions: 8 hours, HttpOnly + Secure + SameSite=Lax, separate cookies for staff and buyers.
- Super admins cannot change their own role/status. All staff changes are audited.

## Rollout

1. Apply migrations: `npx wrangler d1 migrations apply <db> --remote --env staging` (applies 0015 and 0016, plus 0014 if not yet applied).
2. Set secrets: `OTP_ENCRYPTION_KEY` (base64 of 32 random bytes), `RESEND_API_KEY`, `EMAIL_FROM`; set `ADMIN_BOOTSTRAP_TOKEN` only if you need first-admin or password-less-staff setup, then delete it.
3. Remove any Cloudflare Access application still protecting `/dashboard/*`.
4. **Smoke test on staging:** `/admin/setup` or login (this exercises PBKDF2 on Workers), change password, forgot/reset for staff and buyer, buyer register → admin approve → buyer login, super admin creates and suspends staff, `/dashboard/settings/ui` still saves.
5. Existing buyers have no password: they use _Forgot password_, or staff re-provision them (sends a set-password email).

## Breaking changes from Sprint 14/15 builds

- Endpoints moved: `/api/admin/login` → `/api/admin/auth/login`, `/api/admin/logout` → `/api/admin/auth/logout`, `/api/admin/password/{forgot,reset,change}` → `/api/admin/auth/{forgot-password,reset-password,change-password}`.
- Buyer OTP endpoints (`request-code`, `verify-code`) are removed; `buyer_login_codes` is unused but kept.

## Verification status

All 16 migrations apply in order on in-memory SQLite (including the session backfill); the PBKDF2 module was exercised in Node (including verification of a 600,000-iteration legacy hash); all TypeScript and browser scripts parse. `pnpm typecheck`, `pnpm lint`, `pnpm test` and live Cloudflare checks were **not** run (no network for `pnpm install`). Run `pnpm check` before staging.
