# Sprint 28 — Filtered audit export

## Base

Sprint 28 builds on Sprint 27 and preserves the existing staff authentication, role policy, audit browsing filters, opportunity confidentiality controls, and publication workflow.

## Delivered

- Added `GET /dashboard/audit/export.csv`, restricted to `admin`, `auditor`, and `super_admin` roles.
- Reuses the audit page's search, action, entity type, and date filters.
- Validates dates using the same calendar-date rules as the audit API.
- Exports a maximum of 5,000 matching rows per request. Larger result sets return HTTP 422 and ask staff to narrow the filters.
- Exports event ID, UTC timestamp, actor email/type, action, entity, request ID, and metadata JSON.
- Quotes CSV cells and neutralizes values that could be interpreted as spreadsheet formulas.
- Sets `private, no-store`, `nosniff`, and an attachment filename on downloads.
- Records an `audit.exported` event with result count and filter-presence metadata; raw search terms are not copied into that event.
- Added an “Export filtered CSV” control to the audit page and static unit assertions.

## Validation and release status

The implementation is source-packaged only. Run the repository's dependency-backed typecheck, lint, unit and Node tests, then verify role denial/allowance, date boundaries, formula-injection handling, and the 5,000-row limit against a staging D1 database. Do not consider this production-ready until the existing Cloudflare resource placeholders and release gates are resolved.
