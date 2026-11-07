# Running as a Lummet control plane tenant

luminousagents is the **brokerage** application line of the Lummet control plane. The control plane releases it to R2,
provisions it for customers who create a *Brokerage Site*, deploys it, and can suspend it or cap its storage. This page is
everything this repository does for that. None of it changes how the site behaves when it is NOT managed by a control plane
(no `SUPER_API_*` values are set, so the Super API answers 503 and the gate never blocks anything).

## What a provisioned site looks like

| Binding | Value |
|---|---|
| `DB`, `CACHE` | the site's own D1 database and KV namespace |
| `PRIVATE_FILES` | the site's own R2 bucket (data room documents, signed NDAs, media) |
| `ASSETS` | `public/` (static files), served first except for the paths in `assets.run_worker_first` |
| `APP_ENV`, `LOG_LEVEL`, `PUBLIC_BASE_URL`, `EMAIL_FROM` | set by the control plane |
| `IP_HASH_SECRET`, `OTP_ENCRYPTION_KEY`, `ADMIN_BOOTSTRAP_TOKEN` | derived per site from the platform's `TENANT_SECRET_ROOT` |
| `SUPER_API_CREDENTIAL_ID`, `SUPER_API_SECRET`, `DEPLOYMENT_ID`, `SITE_URL` | the control plane's signed channel to the site |
| cron | `*/5 * * * *` (notification recovery) |

There is no Cloudflare Queue per site. `src/operations/inline-queue.ts` stands in for `NOTIFICATIONS_QUEUE`: a message is
handed to the normal consumer with `waitUntil`, and because every notification is a durable row in D1 first, a failed
delivery is retried by the five minute cron. A site that does have a real `NOTIFICATIONS_QUEUE` binding uses it unchanged.

## The Super API (`src/super-api/`)

Signed server-to-server routes under `/en/api/super/*` (the prefix the control plane calls). Every request carries
`Authorization: Bearer <credential id>`, `X-Lummet-Timestamp`, `X-Lummet-Nonce` and `X-Lummet-Signature`, the hex HMAC-SHA256
under `SUPER_API_SECRET` of `METHOD \n PATH \n TIMESTAMP \n NONCE \n SHA256(BODY)`. Timestamps must be within 5 minutes, a
nonce is accepted once, and a credential may make 120 requests a minute. A failed request gets one generic answer; the reason
is only logged.

| Route | Purpose |
|---|---|
| `GET handshake` | platform name, host, api version, capabilities (the control plane's connection test) |
| `GET health`, `GET capabilities` | liveness (checks D1) and what this site supports |
| `PUT site-access-state` | `serving`, `suspended` or `closed`, signed, newest generation wins |
| `PUT storage-limit` | the plan's storage cap in bytes (or none), signed, newest generation wins |
| `GET storage-usage` | bytes held in the media library, listing media, data room documents and seller evidence |

A **suspended** site answers every page and API request with 503 (`Retry-After`), a **closed** one with 410. `/healthz` and
the Super API itself are never blocked, so a suspended site still passes health checks and can be resumed. State is stored in
D1 (`platform_state`) and mirrored to KV; a read failure serves the site, it never locks it out.

The **storage cap** refuses `multipart/form-data` uploads to `/dashboard/*` and `/api/*` that would pass the cap with
`413 STORAGE_LIMIT_REACHED`. Set `STORAGE_METERING_MODE=off` to report usage without enforcing.

## First administrator

A new site has no staff. Its owner opens the control plane's **Admin setup** page for the site (Deployments, brokerage sites
only), which shows `https://<site>/admin/setup` and the setup code (the site's `ADMIN_BOOTSTRAP_TOKEN`). That page creates the
first super administrator, who then enrols MFA and invites the rest of the team as usual.

## Releasing

`.github/workflows/release-tenant.yml` (manual run) checks typecheck, lint and the release gates, then runs
`tools/release/publish-tenant-release.mjs --line brokerage`, which bundles the Worker with `wrangler deploy --dry-run`,
reads `migrations/*.sql`, hashes `public/` (without `_headers`) and sends the release to the control plane. The release
carries the static-file rules (`assets.run_worker_first` from `wrangler.jsonc` and `public/_headers`); bindings, cron and the
health URL come from the control plane, never from a release. Publishing makes it the release new sites are provisioned
with; live sites move when you roll it out (tick *rollout*, or use the staff Deployments page).

Set up once (GitHub environment `control-plane`): secret `LUMMET_STAFF_TOKEN` (release:publish, rollout:run) and variable
`LUMMET_CONTROL_PLANE_URL`. `tools/release/` is a copy kept in sync from the control plane repo
(`node scripts/sync-release-tools.mjs --to <this repo>/tools/release`); do not edit it here.

**Keep the migrations backward compatible.** A release's migrations run on every live site when it is rolled out, in order,
once each. New tables and columns are fine; do not rename or drop anything the previous release still reads.

Local checks: `/en/api/super/*` must stay in `assets.run_worker_first` (otherwise static assets would shadow it).
