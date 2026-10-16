# Sprint 15 — Platform management, recovery and configurable public site

## Included

- Staff password change at `/admin/change-password` and password reset at `/admin/forgot-password` / `/admin/reset-password`.
- One-time, expiring password-reset tokens are random, hashed before storage, rate limited through KV, invalidated after use, and revoke existing staff sessions. Reset links are sent through Resend (`RESEND_API_KEY`, `EMAIL_FROM`, `PUBLIC_BASE_URL`).
- Dashboard platform settings at `/dashboard/settings/ui`, persisted in D1. Supported keys include platform name/description, logo and logo text, favicon URLs, GA4 ID, WhatsApp contact and default message, colours, font families, header/footer navigation, homepage and geographic sections, and staff notification email.
- GA4 loads only after explicit analytics consent. A consent banner supports accept/reject and stores the selection in the browser. Review jurisdiction-specific consent requirements before enabling analytics.
- Floating WhatsApp contact widget is rendered only when a valid phone number is configured. The number and message are configurable in dashboard settings, not source code.
- Managed content pages at `/dashboard/pages/ui`; published pages render at `/pages/:slug`. User-entered page body is escaped plain text with line breaks; raw HTML is not executed.
- Managed forms at `/dashboard/forms/ui`; published forms render at `/forms/:slug`. Field definitions are schema-validated. Submissions are stored in D1, include optional published listing association (`?opportunity=listing-slug`), and queue a durable Resend staff notification.
- Existing contact enquiries already retain their originating published listing via the `opportunity` slug field. Contact, buyer registration, NDA and custom-form notifications use `platform_settings.notification_email` when configured, falling back to `OPS_EMAIL`.
- Expanded compliance information pages: AML/KYC, sanctions, anti-bribery, complaints, investment/listing disclaimer and human rights/modern slavery, plus substantive privacy, terms and cookie information.

## New migration

`migrations/0015_platform_management.sql`

Adds `password_reset_tokens`, `platform_settings`, `managed_pages`, `managed_forms` and `managed_form_submissions`. It does not delete or rewrite existing platform data.

## Staging release sequence

1. From the project root, install from the lockfile and run `pnpm typecheck`, `pnpm test` and `pnpm lint`.
2. Apply the migration: `npx wrangler d1 migrations apply mayfair-platform-staging --remote --env staging`.
3. Ensure `RESEND_API_KEY`, `EMAIL_FROM`, `OPS_EMAIL` and `PUBLIC_BASE_URL` are configured as staging secrets/variables.
4. Deploy: `npx wrangler deploy --env staging`.
5. Sign in to the staff dashboard and configure the notification email, branding, favicon URLs, WhatsApp number, font families, colours, navigation and sections.
6. Submit a contact enquiry and a published custom form. Confirm the records are saved, listing association is present when submitted from a listing, and Resend delivers staff notifications.
7. Test password change, forgot-password email delivery, expiry, single-use reset and session revocation.
8. Configure GA4 only after verifying the cookie/analytics consent experience and the applicable legal requirements.

## Settings JSON examples

Header/footer navigation:

```json
[
  { "label": "Opportunities", "url": "/casinos-for-sale" },
  { "label": "Services", "url": "/services" },
  { "label": "Contact", "url": "/contact" }
]
```

Homepage / geographic sections:

```json
[
  {
    "title": "European hospitality opportunities",
    "body": "Qualified introductions for casino and hospitality assets across selected markets.",
    "url": "/casinos-for-sale",
    "linkText": "Explore opportunities"
  }
]
```

A custom font family is a CSS font-family stack, such as `Arial, sans-serif` or `Georgia, serif`. Only use fonts available to the visitor's system unless a properly licensed and configured web-font source is separately deployed.

## Operational notes

- Reset emails require a verified Resend sender domain/address. The API intentionally returns a generic response to avoid disclosing whether a staff account exists.
- Set a valid `notification_email` in dashboard settings for all staff-facing form notifications. Keep `OPS_EMAIL` configured as fallback.
- Uploaded logo/favicon assets must be hosted on the site or an HTTPS origin permitted by the content security policy. The dashboard currently accepts URLs; it does not upload logo/favicon files.
- Custom form definitions are JSON field arrays; supported field types are `text`, `email`, `tel`, `textarea` and `select`.
- Content in managed pages is rendered as escaped plain text, not rich Markdown/HTML. This avoids stored XSS until a reviewed Markdown parser is introduced.
- Compliance pages are substantive operational drafts, not jurisdiction-specific legal advice. The operating entity should complete legal identity/contact details and obtain appropriate counsel review before production launch.
- Full dependency-based typecheck/test/lint must run in a network-enabled build environment. Local syntax transpilation and SQLite migration application are not a substitute for those checks.
