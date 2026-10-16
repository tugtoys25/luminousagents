# Sprint 3 — Enquiries and CRM

## Delivered in this increment

- Public contact form with server-side Zod validation, explicit consent, field limits, and a honeypot.
- `POST /api/enquiries` stores the enquiry, audit event, and a durable notification job in a single D1 batch. Public responses do not disclose internal processing details.
- Basic KV rate limiting (five submissions per IP-key per ten-minute window). When `IP_HASH_SECRET` is configured, IP-derived keys use HMAC-SHA-256; raw IP addresses are not stored in D1.
- Optional Turnstile verification when configured; production submissions fail closed unless both `TURNSTILE_SECRET_KEY` and `IP_HASH_SECRET` are set.
- Staff-only CRM API: list/filter enquiries, retrieve enquiry plus notes, update status/assignee, and add internal notes. Changes are audited.
- Queue messages contain only an opaque enquiry ID; personal details stay in D1.

## Required production configuration

- Set a high-entropy `IP_HASH_SECRET` as a Worker secret.
- Configure `TURNSTILE_SECRET_KEY` as a Worker secret and set `TURNSTILE_SITE_KEY` as a non-secret Worker variable. The contact form renders the widget when the site key is configured; server-side verification is implemented.
- Configure and test the `NOTIFICATIONS_QUEUE` consumer/provider. This sprint writes durable `notification_jobs` rows and emits queue messages, but does not yet deliver email; failed queue sends leave a recoverable job row.
- Replace and approve the privacy notice before collecting real personal data. The current notice is explicitly a placeholder.
- Configure a real rate-limiting strategy appropriate to expected traffic; KV counters are eventually consistent and are a basic abuse barrier, not a strict distributed quota.

## Endpoints

- `POST /api/enquiries` — public form submission (form-encoded or JSON).
- `GET /dashboard/enquiries` — staff list/filter.
- `GET /dashboard/enquiries/:id` — staff enquiry detail and internal notes.
- `PATCH /dashboard/enquiries/:id` — status and/or assignee update.
- `POST /dashboard/enquiries/:id/notes` — add an internal note.

All CRM routes require a verified Cloudflare Access identity and an active staff record. Actual D1, KV, queue, Turnstile, and Access integration must be validated in a configured Cloudflare environment before production use.
