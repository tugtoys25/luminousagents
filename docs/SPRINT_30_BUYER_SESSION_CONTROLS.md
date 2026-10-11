# Sprint 30 — Buyer session controls

## Base and scope

Sprint 30 is built on the Sprint 29 source tree. It adds super-administrator inventory and individual revocation of active buyer sign-in sessions. It does not replace the buyer's password or email-code authentication, suspend an account, or modify NDA/data-room grants.

## Implemented

- Added migration `0026_sprint30_buyer_session_controls.sql`, with an index supporting active buyer-session inventory.
- Added `/dashboard/buyer-sessions/ui`, `/dashboard/buyer-sessions`, and `POST /dashboard/buyer-sessions/:id/revoke`, all restricted to `super_admin`.
- The inventory is limited to 500 active, unexpired buyer sessions and shows buyer email/name, account status, created time, last activity and expiry.
- Session token hashes and cookie values are not returned.
- Revocation is conditional on an unrevoked buyer session, returns conflict if another action already revoked it, and creates a `buyer.session_revoked` audit event.
- The page confirms before revocation, renders server values with DOM `textContent`, and uses private/no-store API responses.
- Added `test/unit/sprint30-buyer-session-controls.test.ts` and linked the page from super-administrator navigation.

## Validation and limitations

The source package should be checked with `pnpm check` and migration `0026` applied to isolated staging before release. This authoring environment may not have project dependencies or Cloudflare credentials; no production deployment is implied by this sprint document. Confirm both authorized and unauthorized access, buyer session invalidation, repeat revocation, audit event creation, and no-store headers in staging.
