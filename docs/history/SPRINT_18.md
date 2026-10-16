# Sprint 18 — Staff workspace polish and contact-form finish

## Delivered

- Added a consistent staff workspace shell to dashboard HTML responses, with a persistent desktop sidebar, responsive mobile drawer, active-page state, grouped navigation and a searchable menu (`/` focuses search; `Escape` closes the mobile drawer).
- Applied a responsive dashboard design system: calmer Mayfair forest/ivory/gold palette, stronger typography and spacing, refined cards/tables/forms, keyboard focus states and reduced-motion support. Existing pages retain their server-side authorization and route-specific behavior.
- Finished public contact-form interaction with a live message-length counter, native validity reporting, disabled/busy submit state to prevent accidental duplicate clicks, and refined mobile/desktop form styling.
- Kept the contact form progressive-enhancement friendly: it still posts to the existing server endpoint without JavaScript. Existing consent, honeypot, Turnstile configuration, validation, rate limiting, durable enquiry/job writes and audit logging remain server-side.

## Production readiness notes

- Configure `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`, `IP_HASH_SECRET`, `PUBLIC_BASE_URL`, database/queue bindings and notification delivery secrets for production; validate them using the release preflight before deploy.
- The existing privacy notice explicitly contains operator-specific launch placeholders. Replace these with the legal entity, privacy contact, jurisdictions, lawful bases, retention periods and international transfer details applicable to the operator.
- Run the complete CI suite in the repository's supported Node 22 + pnpm environment. This execution environment did not provide pnpm and the bundled `node_modules` links were incomplete, so local automated test/typecheck execution was not possible here.

## Acceptance checklist

- [ ] Verify all dashboard links with each staff role and on a phone-sized viewport.
- [ ] Verify keyboard navigation, menu search, Escape-to-close and visible focus states.
- [ ] Submit valid/invalid contact forms with and without JavaScript; test Turnstile success/failure, honeypot, rate-limit response and notification-job recovery.
- [ ] Run `pnpm check` and `pnpm preflight:final` in CI before release.
