# NDA and confidential data room

Buyer access requires a provisioned active buyer, verified session, accepted current NDA template, active opportunity publication/approval, unexpired opportunity-specific grant, sufficient access tier, and document scan status `clean`. Re-check all conditions on every download request. Revocation must affect the next request. Store the exact NDA template SHA-256 and salted IP hash with each acceptance. Provide signed-PDF upload as an alternative only after legal defines validation and retention rules. A typed-name acknowledgement is not a qualified electronic signature. The active NDA template and all legal wording require counsel approval before production.

Documents are private R2 objects, never public URLs. Release must verify a trusted scanner's completed clean verdict for the exact SHA-256. Do not log document contents, OTPs, secrets, or signed NDA contents.

## Buyer dashboard additions

`/account` is now a buyer workspace (same design tokens as the staff dashboard). It adds: an NDA template download (`GET /api/buyer/nda-template/download`, hash-verified, audited as `nda.template_downloaded`); a four-step NDA completion tracker per request (acknowledged, optional signed copy, team review, access granted); an optional in-page document preview (`GET /api/buyer/documents/:id/preview`, audited as `document.previewed`) that re-runs every download check and only serves PDF, PNG/JPEG/GIF/WebP and plain text inline; clearly visible Download buttons; and a prominent Register button on the sign-in screen. Preview responses use a locked-down CSP and may be framed only by the same origin. `public/static/js/buyer-account.js` is retained but no longer loaded.

