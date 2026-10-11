# Sprint 26 — Opportunity data integrity and CMS workflow

## Base and intent

Sprint 26 builds on Sprint 25. It focuses on opportunity record recovery and controlled review workflows without changing the Sprint 25 authentication, public price confidentiality, or media visibility policies.

## Delivered

- **Review/version indexes:** migration `0023_sprint26_opportunity_integrity.sql` adds indexes for review queues and version-history lookups.
- **Version history API:** `GET /dashboard/opportunities/:id/versions` returns up to 100 recent version metadata entries, subject to broker ownership scoping.
- **Restore-as-draft:** `POST /dashboard/opportunities/:id/versions/:versionNumber/restore` requires a reason, validates the snapshot, restores editable content, resolves a slug collision, writes a new version and audit event, and resets lifecycle/review/public visibility to `draft` / `pending` / private. Broker assignment is not restored from historical snapshots.
- **Bulk content review:** `POST /dashboard/opportunities/bulk-review` accepts 1–50 unique opportunity IDs (including legacy non-UUID IDs) and a reason, is publisher-role restricted, audits each record, and always keeps public visibility off. Missing IDs are returned as `not_found`; records are not bulk-published.
- **CSV export:** `GET /dashboard/opportunities/export.csv` is restricted to admin/super-admin, audits the export, returns private/no-store headers, quotes CSV cells, and prefixes spreadsheet-formula-like values. Export includes confidential opportunity fields and must be handled accordingly.
- **Controlled CSV import:** `POST /dashboard/opportunities/import.csv` is restricted to admin/super-admin, accepts up to 1 MB and 100 data rows, requires unique `id` and `title` headers, rejects unknown IDs and invalid fields before writing, and applies updates/version snapshots/audit rows in one D1 batch. It updates existing records only; it does not create new records. Imported records become private drafts and need fresh review. Export-only system columns are accepted but ignored during import.
- **CMS interface:** record selection, select-visible, bulk approve/reject, admin-only import/export controls, version history and restore actions.

## API contracts

Bulk review request: `{ "ids": ["UUID"], "decision": "approved" | "rejected", "reason": "..." }`. The endpoint limits a request to 50 IDs and requires a 3–500 character reason.

Restore request: `{ "reason": "..." }`. Restoring content does not restore the prior lifecycle, approval, or public visibility. A restored opportunity must be reviewed and published through the existing separate workflow.

## Data integrity notes

- The base project contains 198 legacy opportunity rows in its migration seed; applying migrations `0001` through `0023` to in-memory SQLite preserved all 198 rows during this validation. This is not a check of a live Cloudflare D1 database.
- Migration 0023 adds indexes only; it does not modify or delete opportunity rows.
- CSV export is a privileged operation because it includes confidential pricing and other internal fields.
- The pre-existing version snapshots are created on create/edit. Review and publication actions are still represented in audit logs rather than full content snapshots.

## Validation performed

- All SQL migrations `0001`–`0023` applied in order to an in-memory SQLite database.
- The seeded opportunity count remained 198.
- JavaScript syntax check passed for `public/static/js/dashboard-opportunities.js`.
- TypeScript parser syntax checks passed for `src/admin/routes.ts` and `test/unit/sprint26-opportunity-integrity.test.ts`.
- Full project typecheck, lint, Vitest, browser/E2E tests, Cloudflare D1 staging migration and deploy were not run in this environment because project dependencies are not installed and network package installation was unavailable.

## Required next checks before release

1. Install locked dependencies and run `pnpm check`.
2. Test version restore, broker scoping, bulk review and export permissions against isolated staging D1.
3. Verify CSV export with formula-like values and confirm that no public endpoint exposes private export content.
4. Test CSV export/import round-trip with quoted commas, embedded newlines, duplicate IDs, unknown IDs, invalid JSON labels, and formula-like cells.
5. Exercise the CMS in a browser at desktop/mobile widths and inspect the browser console.
6. Configure actual Cloudflare resource IDs and secrets; run the full release gates before deployment.
