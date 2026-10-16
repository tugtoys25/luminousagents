# Sprint 25 — Security and release baseline

## Base and owner decisions
- Base archive: Sprint 24.
- Staff authentication remains custom email/password; Cloudflare Access is not required.
- Buyers may use password sign-in or email one-time-code sign-in. Code-only buyers may later set a password.
- Images remain public by default; documents remain private by default. Authorized staff can change visibility.
- Public prices are confidential by default and are only serialized publicly when `price_visibility = 1`.

## Implemented in this source increment
- Additive migration `0022_sprint25_security_baseline.sql`: explicit price visibility, safe media URL slug, and buyer email-code challenges.
- Public opportunity serialization now defaults to tier 0 and redacts prices unless explicitly approved public; authorized tiers may still see prices.
- Public pages and structured-data inputs use the public serialization tier.
- Buyer email-code request/verification endpoints with generic account-existence responses, rate limiting, expiry, attempt caps, single-use challenge consumption, and session creation.
- Buyer registration can omit a password; a buyer who signs in by code can later set one.
- Media library accepts a URL-safe optional slug, keeps image uploads public by default and documents private, audits visibility changes, and disables HTTP caching on public media responses to avoid stale public cache after a switch to private.
- Added source invariant tests for Sprint 25.

## Not yet proven / environment-dependent
- No Cloudflare deployment or D1 migration was run. Wrangler configuration still requires the owner to verify real account resources and secrets; placeholder IDs must not be deployed.
- Email-code flow requires `RESEND_API_KEY`, `EMAIL_FROM`, and `OTP_ENCRYPTION_KEY` to be configured in each environment.
- Full typecheck/lint/Vitest/browser checks must run after dependencies are installed. This container did not include `node_modules` at start.
- Actual email deliverability, live account lifecycle, and production cache behavior need staging verification.
- The media public route intentionally uses no-cache headers for immediate visibility revocation; this trades CDN caching performance for confidentiality safety.

## Run locally
1. `pnpm install --frozen-lockfile`
2. `pnpm check`
3. `pnpm exec wrangler d1 migrations apply mayfair-platform-staging --env staging --remote` only after verifying the account, database ID and intended target.
4. Deploy to staging only after all required secrets and bindings are configured; never run production migration/deploy as an automatic part of this sprint.
