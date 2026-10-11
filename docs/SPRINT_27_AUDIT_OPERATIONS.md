# Sprint 27 — Audit operations and governance visibility

## Base

Sprint 27 builds on the Sprint 26 archive and preserves the existing authentication, opportunity confidentiality, publication, buyer access, media visibility, and import/export policies.

## Delivered

- Added a dedicated staff audit-log page at `/dashboard/audit/ui` for administrators, auditors, and super administrators.
- Fixed staff navigation to open the page rather than the JSON API.
- Added server-side pagination (50 by default, maximum 100) and filters for text search, action substring, exact entity type, and date range.
- Added stable ordering by timestamp and event ID, a total count, bounded page numbers, and private/no-store API responses.
- Added an accessible read-only table, paging controls, expandable metadata, and clear empty/error states.
- Audit metadata is inserted using DOM text nodes; it is not interpreted as HTML.
- Added indexes for action/date, entity/date, and actor/date queries in migration `0024_sprint27_audit_operations.sql`.
- Added static unit assertions for the new routes, query bounds, index definitions, and safe DOM rendering.

## API

`GET /dashboard/audit?page=1&limit=50&search=&action=&entityType=&from=YYYY-MM-DD&to=YYYY-MM-DD`

Only `admin`, `auditor`, and `super_admin` roles may access the page or API. Date ranges are inclusive at the selected day boundaries. Invalid dates or a start date after the end date return HTTP 422. The endpoint returns `data`, `page`, `limit`, `total`, and `pages` and is marked `private, no-store`.

## Validation and release status

The new migration is additive and does not alter existing audit events. Syntax checks and all migrations should be validated before release. This source archive has not been deployed to Cloudflare. Full dependency-backed typecheck/lint/tests, staging D1 migration, authenticated role checks, browser testing, and release gates remain required; Sprint 27 must not be considered production-ready until these pass.
