# Sprint 6 — buyer portal, NDA review, and document release controls

## Implemented in source

- Buyer account page at `/account` with email-code sign-in, saved opportunities, NDA request/access status, and authorized document downloads.
- Buyer NDA/access status API (`GET /api/buyer/nda-requests`).
- Staff NDA review interface at `/dashboard/nda-requests/ui`, connected to the existing role-protected review API.
- Upload content-signature checks for PDF, JPEG, PNG, DOCX, and XLSX; filenames are normalized before storage and responses.
- SHA-256 integrity hashes stored for newly uploaded files.
- Migration `0009_document_integrity.sql` adds document hashes and a fail-closed scan status (`pending`, `clean`, `rejected`).
- Buyer document listing and download are restricted to documents marked `clean`, in addition to active grant, tier, and published/approved opportunity checks.
- Admin-only release gate at `PATCH /dashboard/documents/:id/scan-status`; releasing a file requires a scanner reference and a reason, and every decision is audited.
- Download authorization now also requires the opportunity to remain published, approved, and public.

## Important security limitations

- Signature checks are basic format checks, not full parsers; ZIP signatures do not prove DOCX/XLSX structure or safety.
- No malware-scanning service is integrated. The clean-status endpoint is a controlled release gate that requires an external scanner reference; it does not itself scan a file. Do not mark a file clean unless a real scanner has checked the exact SHA-256 hash.
- Files uploaded before migration 0009 receive the default `pending` scan status and are therefore not downloadable until scanned and explicitly released.
- NDA acknowledgement remains an acknowledgement, not a qualified electronic signature. Obtain legal review of the NDA text and signature process.
- Buyer accounts must be provisioned by staff; public sign-up remains intentionally disabled.

## Validation status

Source syntax and SQL migration checks should be run after dependencies are installed. Full typechecking, automated tests, lint, browser checks, malware scanner integration, and live Cloudflare staging tests remain unverified in this environment.
