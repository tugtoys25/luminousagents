# Sprint 13 — Preserve deployment baseline and integrate Sprint 12

## Baseline and deployment safety

The uploaded Sprint 11 project is the canonical baseline. `wrangler.jsonc`, `pnpm-lock.yaml`, `.github` deployment workflows, package manager version, existing D1/R2/KV/queue names, environment names, and deployment scripts were retained. No deployment or Cloudflare resource mutation was performed by this build task.

## Delivered

- Added a dedicated `/admin/login` entry page for the Cloudflare Access-protected staff workspace.
- Added one-time `/admin/setup` and `/api/admin/bootstrap` for first `super_admin` creation, gated by the Worker secret `ADMIN_BOOTSTRAP_TOKEN`, a 32-character minimum, and absence of any existing staff user. After bootstrap, setup returns HTTP 410 and its login-page link is hidden. The new admin must still be provisioned in Cloudflare Access and use the same email identity.
- Added buyer registration at `/register` and `/api/buyer/register`, with consent capture, versioned privacy-consent metadata, generic duplicate-account response, per-email/IP KV throttling, audit event, invited status, and queued operations notification. Registration does not activate accounts or grant data-room access.
- Added staff approval/suspension controls at `/dashboard/buyers/ui`; status changes revoke sessions when the buyer is not active and are audited.
- Added `/dashboard/access-grants/ui` list/revoke workflow using the existing audited revoke endpoint.
- Added listing classification and labels to the CMS. Public visibility now requires approved content, published lifecycle, verification timestamp, and `classification = 'public'`.
- Added private R2 listing image upload/removal, JPEG/PNG byte-signature checks, 8 MiB limit, alt-text requirement, SHA-256 metadata, and audited changes. Public image serving re-checks the listing state, object size, and hash.
- Updated public listing cards/detail pages to render cover images and label chips, with responsive styles.
- Added migration `0013_sprint12_port.sql`; prior explicitly public listings remain public, while other records default confidential.
- Added operations email handling for buyer-registration review notifications.

## Configuration required

Set `ADMIN_BOOTSTRAP_TOKEN` as a Cloudflare Worker secret only when initial setup is needed. Use a cryptographically random value of at least 32 characters; do not commit it or put it in ordinary Wrangler vars. After creating the first administrator, remove/rotate the bootstrap secret. Ensure Cloudflare Access protects the staff workspace and allows the administrator's work email. Configure `RESEND_API_KEY`, `EMAIL_FROM`, `OPS_EMAIL`, and other existing notification secrets as already required by the deployed baseline.

## Verification status

The merged source passed TypeScript syntax transpilation (35 TypeScript files, zero syntax diagnostics), browser/deployment JavaScript syntax checks, the Sprint 13 static integration gate, the Sprint 7 source preflight, and the Sprint 9 workflow source gate. All 13 SQL migrations executed successfully against in-memory SQLite; the migration preserved 198 legacy rows as private/pending and retained public classification for previously public approved rows. Full typecheck and Vitest could not run because dependencies are not installed and Corepack could not reach the npm registry in this execution environment. No production deployment was performed.

## Local source checks

From the project root run `node scripts/sprint13-integration-gate.mjs`, `node scripts/sprint7-preflight.mjs`, `node scripts/sprint9-workflow-gate.mjs`, and `node scripts/sprint10-readiness.mjs`. The strict release gate still depends on actual Cloudflare IDs and secrets.

## Staging acceptance checklist

1. Apply migration 0013 in staging and confirm existing public listings are still public while imported legacy rows remain private.
2. With zero staff users and a configured bootstrap secret, create the first administrator once; confirm repeat setup returns 410.
3. Confirm Cloudflare Access identity email matches the new active `super_admin` user.
4. Submit buyer registration, verify privacy consent fields/audit row and ops email; confirm account stays invited and cannot request an OTP until staff activates it.
5. Approve and suspend a buyer; confirm sessions are revoked on suspension.
6. Create a listing with type, classification, labels and image; confirm image remains private before approval/publication.
7. Publish only after content review and verification; confirm card/detail images and labels display, and tampered R2 bytes return 404.
8. Revoke a data-room grant; confirm document listing/download fails immediately and audit record contains the reason.
9. Run the existing deployment preflight scripts and complete a rollback drill before any production rollout.
