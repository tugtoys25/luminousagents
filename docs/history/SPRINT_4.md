# Sprint 4 — Buyer accounts, NDA approval and private data room

## Implemented in source

- Buyer email OTP request and verification endpoints. Codes expire after ten minutes, have a five-attempt limit, are stored as SHA-256 digests, and are never returned by the API. Pending delivery payloads are AES-GCM encrypted in D1 using `OTP_ENCRYPTION_KEY` (base64 encoding of 32 random bytes). Requests use generic responses and a KV throttle to reduce account enumeration and abuse.
- Opaque random session tokens stored only as SHA-256 hashes in D1, with a 12-hour expiry, `HttpOnly`, `Secure`, `SameSite=Lax` cookie, session revocation on logout, and audit entries.
- Buyer profile identity endpoint, save/unsave published opportunities, and list saved opportunities.
- NDA request records bound to the active NDA template, acceptance name/timestamp, and a manual staff review workflow. Approval creates a time-limited access grant; rejection records the reason. Reviewer actions are audited.
- Staff-only private document uploads to R2 with a 20 MB limit and allowlisted MIME types, tier metadata, database rollback cleanup if metadata persistence fails, and audit logs.
- Buyer document listing/download checks the buyer session, opportunity publication state, grant expiry/revocation and document tier. Downloads stream from private R2 with private/no-store and nosniff headers and are audited.

## API endpoints

- `POST /api/buyer/auth/request-code` `{ email }`
- `POST /api/buyer/auth/verify-code` `{ email, code }`
- `POST /api/buyer/auth/logout`
- `GET /api/buyer/me`
- `GET /api/buyer/opportunities`
- `POST|DELETE /api/buyer/opportunities/:id/save`
- `POST /api/buyer/opportunities/:id/nda-requests` `{ acceptanceName, templateId? }`
- `GET /api/buyer/opportunities/:id/documents`
- `GET /api/buyer/documents/:documentId/download`
- Staff: `GET /dashboard/nda-requests?status=pending`, `PATCH /dashboard/nda-requests/:id/review`, `POST /dashboard/opportunities/:id/documents`, `DELETE /dashboard/documents/:id`

## Production blockers and limitations

- Email OTP delivery was added in Sprint 5 through a Resend queue consumer. Configure `OTP_ENCRYPTION_KEY` as a Worker secret (base64 of 32 cryptographically random bytes), plus `RESEND_API_KEY` and `EMAIL_FROM`. Live delivery has not been verified. Never log or return codes to the browser. If the encryption key is missing, requests return the generic accepted response but no OTP is created.
- No buyer registration/self-service invitation flow; a buyer account must be provisioned by an authorised process before OTP login succeeds.
- NDA acceptance currently records an acknowledgement name and timestamp. It is not a qualified electronic signature and must not be represented as legal e-signature. Legal counsel must approve the template and wording.
- Active NDA template upload/management, dedicated grant revocation UI, malware scanning, file content inspection, signed PDF generation, full data-room UI, and comprehensive integration tests remain to be completed. Sprint 5 added a grant revocation API, notification delivery source, and same-origin mutation checks; staging verification remains outstanding.
- Add migration `0007_buyer_auth_security.sql` to each target D1 database before deploying this code. Configure real Cloudflare bindings and secrets. This code has not been deployed or verified against a live Cloudflare account.
