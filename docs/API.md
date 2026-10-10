# API security conventions

- `/api`, `/account`, and `/dashboard` responses are private/no-store unless a route has an explicitly reviewed exception.
- Public HTML and static assets may be cached only when no buyer, staff, session, or confidential data can enter the response.
- Validate request bodies and query parameters; use prepared D1 statements.
- Mutating routes require same-origin validation and CSRF protection appropriate to the authentication mechanism.
- Staff APIs require a signed-in staff session (`POST /api/admin/auth/login`) plus route role and item-level authorization.
- Auth endpoints (both prefixes `/api/admin/auth` and `/api/buyer/auth`): `login`, `logout`, `forgot-password`, `reset-password`, `change-password`. `POST /api/admin/bootstrap` creates the first super administrator; `POST /api/buyer/register` creates an `invited` buyer.
- Super admins only: `GET/POST /dashboard/staff`, `PATCH /dashboard/staff/:id`, `POST /dashboard/staff/:id/reset-password`.
- Buyer APIs require active sessions and re-check grant, expiry, publication, NDA, tier and scan status on every protected request.
- Return generic errors to clients; do not disclose whether a protected object exists when doing so would leak confidential data.
- Audit authorization changes, publication changes, NDA decisions, document release/rejection and downloads without recording secrets or document contents.

## Sprint 10 routes

- `POST /dashboard/documents/:id/scan` — admin/super-admin; reads the exact private R2 bytes, recomputes SHA-256, calls the configured scanner, verifies the HMAC result, and atomically records the verdict and audit trail. Manual clean release is disabled.
- `GET /dashboard/opportunities/ui` — staff CMS for create/edit, review queue, approval and separate publication.
- `GET /dashboard/buyers/ui`, `GET /dashboard/buyers`, `POST /dashboard/buyers/provision` — admin/super-admin buyer provisioning; public registration remains disabled.
- `GET /dashboard/nda-templates/ui`, `GET /dashboard/nda-templates`, `POST /dashboard/nda-templates`, `POST /dashboard/nda-templates/:id/activate` — versioned private NDA template management with hash verification.
- `GET /api/buyer/nda-template` — active template content and digest for an authenticated buyer, verified against the database hash.

- `GET /dashboard/brokers` — active broker accounts for opportunity assignment. Broker identities are scoped to their assigned opportunities, enquiries, NDA request lists and tasks.
