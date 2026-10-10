> **Superseded by Sprint 16** (`docs/SPRINT_16_UNIFIED_AUTH.md`): staff and buyers now share one password system; endpoints moved to `/api/admin/auth/*` and the PBKDF2 cost is 100,000.

# Sprint 14 — Custom staff authentication

This sprint replaces Cloudflare Access JWT authentication with native application authentication for staff. Cloudflare Access is not required for `/dashboard`.

## Implemented

- `/admin/login` email/password form and `/api/admin/login` endpoint.
- PBKDF2-HMAC-SHA-256 password hashes with random 128-bit salts and 310,000 iterations; raw passwords are never stored.
- Cryptographically random 256-bit session tokens; only SHA-256 token hashes are stored in D1.
- `HttpOnly; Secure; SameSite=Lax` host-only session cookies, 12-hour sliding idle expiry, session revocation on logout, and active staff user checks on each protected request.
- Per-IP and per-email login throttling using KV; generic login errors avoid confirming whether an email is a staff account.
- One-time `/admin/setup` supports initial super-admin creation and password provisioning for an existing active staff account whose password has not yet been configured. Both require `ADMIN_BOOTSTRAP_TOKEN` (32+ characters).
- Migration `0014_custom_staff_auth.sql` adds `users.password_hash` without deleting users or sessions.
- Staff role authorization remains enforced by the existing `requireRole` middleware.

## Staging rollout

1. Apply the migration before deploying code that queries `password_hash`: `npx wrangler d1 migrations apply mayfair-platform-staging --remote --env staging`.
2. Deploy this sprint to the staging Worker using the existing `wrangler.jsonc` environment and bindings.
3. Set a high-entropy bootstrap token: `npx wrangler secret put ADMIN_BOOTSTRAP_TOKEN --env staging` and enter at least 32 random characters. Do not put it in `vars`, source control, chat logs, or build logs.
4. Open `/admin/setup`. If no staff user exists, create the first super-admin. If a staff user already exists without a password hash, enter that exact staff email to provision its password. The route only allows the initial creation or a password-null active staff account.
5. Sign in at `/admin/login` and verify `/dashboard`, a forbidden role action, logout, and re-login.
6. Immediately remove the bootstrap secret after setup: `npx wrangler secret delete ADMIN_BOOTSTRAP_TOKEN --env staging`. If later needed for another unconfigured staff account, re-enable it only during a controlled maintenance window and remove it again.
7. Apply and verify the same migration and auth setup separately for production only after staging acceptance.

## Notes and release gates

- The existing user records and all unrelated Cloudflare bindings/configuration are preserved.
- Cloudflare Access can remain disabled for the Worker. If you use Access at the edge as an optional additional gate, users must still pass the application's own login; it is not a substitute for this auth flow.
- Test and typecheck must run against the actual dependency lockfile before treating the sprint as production-ready. Do not deploy this ZIP without reviewing CI results.
- Browser cookie authentication requires HTTPS because the session cookie is `Secure`; use HTTPS staging for end-to-end verification.
