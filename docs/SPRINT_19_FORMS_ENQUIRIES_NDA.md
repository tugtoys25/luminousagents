# Sprint 19: forms, enquiries and NDA workflow

Base: Sprint 18 final plus the `$` replacement fix in `src/index.ts`.

## What changed

**Enquiries inbox** (`/dashboard/enquiries/ui`, new `dashboard-enquiries.js`)

- The sidebar "Enquiries" item used to open raw JSON. It now opens a real inbox: status filter, search, full message, status change, assignment (admin, editor, super admin), internal notes, reply by email link.
- Brokers still only see enquiries assigned to them; auditors and publishers are read-only. Authorization is unchanged and enforced by the existing API routes.
- New `GET /dashboard/assignees` (admin, editor, super_admin) feeds the assignee list. The notification emails now link to the inbox.

**Managed form submissions** (Forms page)

- Migration `0017_forms_nda_workflow.sql` adds `status` (new, in_progress, closed, spam), `internal_note` and `updated_at`. **Apply it before deploying this code.**
- Filter by status and search submitted details; update status and note (admin, super_admin, editor, broker); every change is audited.
- `GET /dashboard/form-submissions/export.csv` (admin, super_admin only) honours the same filters, neutralises spreadsheet formulas, is `no-store` and audited.
- Public `POST /api/forms/:slug/submit` is rate limited (8 per 10 minutes per client per form).

**NDA**

- Approving or rejecting a request now queues an email to the buyer (`nda.decision`): approval includes the access expiry; rejection includes the reviewer's note.
- Fix: an approved request used to block a new request forever, even after the access grant expired or was revoked. A buyer can now request again once no pending request or live grant exists.

## Tests

`test/unit/sprint19-forms-nda-invariants.test.ts` (runs under `pnpm test:node`).

## Not run here

Typecheck, lint, vitest and the D1 migration were not run (no registry access in the build environment). Run `pnpm format && pnpm check`, apply migration 0017 on staging, then test: submit a contact enquiry and a managed form, triage both, request and approve an NDA as a buyer, check the buyer email, let a grant expire (or revoke it) and request again.
