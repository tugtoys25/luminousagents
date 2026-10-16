# Sprint 2 — Staff identity, dashboard and opportunity CMS

## Implemented in this increment

- Staff endpoints are gated by Cloudflare Access JWT verification (`Cf-Access-Jwt-Assertion`). The Worker verifies RS256 signatures against the team's Access JWKS and validates issuer, audience, subject, email, expiry and optional not-before/issued-at timestamps.
- A verified Access identity must also exist as an active `staff` row in D1. Staff are not auto-provisioned from email claims.
- Role-gated opportunity create/read/update, review, publication-state and audit-log endpoints.
- Dashboard overview includes record totals, review queue and recent changes. CMS API supports search and review-status filtering.
- Changes create immutable opportunity version snapshots and append audit rows. Editing resets content review to pending and disables public visibility.
- Publication is blocked unless lifecycle is `published`, review is `approved`, and a verification timestamp exists.

## Configure before use

1. Create a Cloudflare Access self-hosted application for the staff hostname and restrict it to the intended staff group with MFA.
2. Set `ACCESS_TEAM_DOMAIN` to the Access team domain (hostname or URL) and `ACCESS_AUD` to this application's exact audience tag as Worker secrets/vars for each environment.
3. Apply D1 migrations, then create individually approved staff records using `scripts/provision-staff.sql.example` as a template. Never use the example unchanged.
4. Restrict `/dashboard/*` at Cloudflare Access. Access is defense in depth; the Worker independently verifies the JWT and database user.
5. Confirm the deployed Access JWT assertion header is available to the Worker on every protected request.

## Roles

- `super_admin`: all staff actions
- `admin`: edit, publish/review, and audit
- `editor`, `broker`: create/edit opportunity records
- `publisher`: review and publication controls
- `auditor`: read audit log

## API surface

- `GET /dashboard` — SSR dashboard overview
- `GET /dashboard/opportunities?q=&review=` — list/filter records
- `POST /dashboard/opportunities` — create draft (editor roles)
- `GET /dashboard/opportunities/:id` — read record
- `PATCH /dashboard/opportunities/:id` — edit record, reset review (editor roles)
- `POST /dashboard/opportunities/:id/review` — approve/reject with reason (publisher roles)
- `POST /dashboard/opportunities/:id/publication` — set lifecycle/visibility with reason (publisher roles)
- `GET /dashboard/audit` — recent audit records (admin/auditor roles)

## Important limitations

- This is not an assertion that Cloudflare resources are provisioned or that the code is deployed. Access domain/audience, D1 IDs, KV IDs, R2 bucket and Queue names must be configured in the user's Cloudflare account.
- The staff UI is an overview shell; opportunity management is currently API-backed and needs a full interactive editor UI in the next increment.
- JWT keys are fetched per request in this increment; add a bounded in-isolate/JWKS cache with key-rotation handling before high-volume production use.
- CSRF protection should be added if any future mutation endpoint uses cookie authentication. Current admin mutations require Cloudflare's injected JWT assertion header.
- Full dependency installation/typecheck/test suite could not be run in this environment while npm registry DNS is unavailable. Run `pnpm install --frozen-lockfile` once a lockfile is generated in a network-enabled environment, then `pnpm check`.
