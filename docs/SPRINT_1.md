# Sprint 1 — Data and public-site foundation

## Implemented in the authoring workspace

- Additive migrations `0001` through `0006` for users/sessions, opportunities and versions, enquiries/tasks, buyer/NDA/data-room entities, audit/notification jobs, and initial app settings.
- Legacy importer that validates the 198-record source, escapes SQL values, creates deterministic unique slugs, preserves original price text and legacy status, and emits a reviewable SQL import file.
- Import verifier that checks source IDs and generated statement counts.
- All imported opportunities remain `public_visibility = 0` and `content_review_status = 'pending'`. Public pages only query records with `lifecycle = 'published'`, `content_review_status = 'approved'`, and `public_visibility = 1`. Re-running the import resets legacy records to pending/non-public.
- Hono SSR homepage, opportunity directory filters, published detail pages, services/about/FAQ/contact/legal placeholder pages, `robots.txt`, and `sitemap.xml`.
- Red/gold/neutral design tokens, responsive layout, keyboard skip link, reduced-motion support, canonical metadata and no inline scripts.
- A single opportunity serialization function used by public listing and detail routes. Legacy `body_html` is never rendered as trusted HTML.

## Content and launch gates

- The legacy source contains stale and potentially misleading claims. No record is automatically published by import.
- The contact route is informational only; it does not yet capture an enquiry. Production form handling is Sprint 3.
- Privacy and terms pages are explicit placeholders requiring owner/counsel review. Do not launch until replaced with approved text.
- Canonical URLs use the legacy domain `https://casinosofmayfair.com`; confirm DNS ownership and canonical-domain preference before launch.
- No D1 remote migration or deployment has been run from this workspace.

## Verification performed

- The importer generated 198 insert statements from 198 source rows, with 198 unique legacy IDs and 198 unique slugs.
- All six migration files applied successfully to a local in-memory SQLite database using Python's SQLite engine.
- The generated import SQL applied twice successfully to that database: 198 opportunities, zero public records, 198 pending content reviews, and no duplicate slugs. Re-import is idempotent in this SQLite verification.
- TypeScript, ESLint, Vitest and Wrangler checks remain unverified because project dependencies cannot be installed while npm registry DNS is unavailable.
