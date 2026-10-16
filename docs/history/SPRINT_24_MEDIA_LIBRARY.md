# Sprint 24 — Managed media library

## Scope

Built on the Sprint 23 stable codebase, borrowing the media-library workflow from Lummet Tenant while retaining Casinos of Mayfair's Hono/D1/R2 architecture and staff authorization model.

- Added a searchable media-library dashboard with image/document filters, visibility filters, metadata editing, folders, downloads, URL copying, and deletion.
- Added shared image/document picker controls to dashboard fields whose names or labels indicate image, logo, favicon, Open Graph, featured image, cover, background, avatar, thumbnail, hero, document, PDF, attachment, NDA, file or download URLs. Dynamically inserted fields are enhanced too.
- Supports JPEG, PNG, WebP, GIF, PDF, DOCX and XLSX. Uploads are limited to 10 files per request, 25 MiB per file and 50 MiB combined per request; MIME type and file signatures are checked, filenames are normalized, and SHA-256 hashes are stored.
- Media is stored in the existing private R2 bucket. A D1 metadata row controls public visibility; public media is served through `/media/:id` only when the database row is explicitly public. Private assets are delivered only through an authenticated staff download endpoint.
- Images default to public to enable immediate selection in public site fields. Documents default to private. Only administrators can publish images; only super administrators can publish documents. Review rights and confidentiality before publishing any asset.
- Added audit events for upload, metadata changes and deletion, plus the `0021_media_library.sql` migration.

## Deployment

1. Back up D1 and verify the active R2 bucket binding.
2. Apply migration `0021_media_library.sql` to the target D1 database before deploying the worker.
3. Deploy the Sprint 24 worker and static assets.
4. In staging, upload a test image and PDF; verify the image gets a public URL, the PDF remains private, a super administrator can intentionally publish a test PDF, and private downloads redirect/authenticate through the staff session.
5. Test URL pickers on Platform Settings and any other forms with image URL fields, including mobile layout and keyboard use.
6. Run `pnpm check` and `pnpm preflight:final` in a fully installed project environment.

## Important behavior and limits

- The library is a URL/media registry, not an automatic rewrite of every hard-coded image in legacy content.
- Existing opportunity-specific listing media and confidential data-room document workflows remain separate and retain their existing review/access controls.
- SVG, HTML, JavaScript, executable files, video and archives are not accepted by the shared library. DOCX/XLSX are checked for ZIP container signatures but not deeply parsed.
- Publishing a file makes it publicly accessible. Avoid publishing confidential transaction material; deleting an asset may break pages that reference its URL.
- Full TypeScript, integration and browser E2E verification must be run after installing dependencies and applying the migration in a staging environment.
