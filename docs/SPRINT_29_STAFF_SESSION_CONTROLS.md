# Sprint 29 — Staff Session Controls

## Scope

Sprint 29 builds on Sprint 28 and adds a super-administrator-only view of active staff sessions with the ability to revoke a selected session.

## Behaviour

- `GET /dashboard/sessions/ui` renders the session-management page.
- `GET /dashboard/sessions` returns up to 500 active, unexpired staff sessions with staff identity, role, creation, last-activity and expiry timestamps. It never returns token hashes or cookie values.
- `POST /dashboard/sessions/:id/revoke` revokes an active staff session and records `staff.session_revoked` in the audit log.
- The currently authenticated session is identified by hashing the cookie token and cannot be revoked from the page.
- The API is restricted to `super_admin`, and list/revoke responses use private/no-store caching.
- The UI uses DOM text nodes for data rendering and confirms before revoking a session.
- Migration `0025_sprint29_staff_session_controls.sql` adds indexes for active-session inventory and per-user activity queries.

## Security notes

The UI intentionally omits IP addresses and raw session tokens because neither is needed for the workflow and no IP field is stored in the session schema. Revocation takes effect on the next request using that session because authentication checks `revoked_at` on each request.

## Verification still required

Run the pinned dependency checks (`pnpm check`) and exercise the endpoints with real super-admin, non-super-admin, current-session, expired-session and already-revoked cases in an isolated staging D1 database. No production deployment is implied by this source change.
