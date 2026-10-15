# PHP-edition features integrated into the Cloudflare build

The cPanel PHP edition (`casinosofmayfair-php-staging-final-v6`) began as a port of this build, then gained
features of its own. This document records what was found, what was integrated here, and what was
deliberately left out. Nothing existing was removed; every default behaves exactly as before until a
setting is filled in.

## Integrated

| # | Feature (PHP origin) | Where it lives now | Default when unset |
|---|---|---|---|
| 1 | Round WhatsApp icon button (`whatsapp-widget.php`) | `src/web/branding.ts` (`whatsappFabHtml`), injected in `src/index.ts` | Same link, class `mayfair-whatsapp` and accessible name as the old text pill |
| 2 | Floating e-mail icon button above WhatsApp (`email-widget.php`) | `emailFabHtml`; settings `email_widget_enabled`, `email_widget_address`, `email_widget_subject` | On; address falls back to the contact e-mail, then the built-in one |
| 3 | WhatsApp / e-mail / Instagram / LinkedIn icon rows on the Chairman card, contact card and footer (`social-icons.php`, `social.css`) | `socialRowHtml`, `sections.tsx`, `base.tsx`, `public/static/css/social.css` | Instagram and LinkedIn stay hidden until a link is saved |
| 4 | Editable Chairman profile: name, title, bio, expertise tags, languages | `ChairmanSection`; settings `chairman_*` | Previous fixed text |
| 5 | Chairman photo and alt text setting | `chairman_image_url`, `chairman_image_alt` | `/static/img/brian-minister.png` |
| 6 | Open Graph / Twitter / JSON-LD share image setting | `og_image_url`, applied by `applyBrand` | `/static/img/roulette.jpg` |
| 7 | Apple touch icon, 192 and 512 px app icons | `apple_touch_icon_url`, `icon_192_url`, `icon_512_url` | None |
| 8 | Dynamic `/manifest.webmanifest`, `/favicon.ico` and `/apple-touch-icon.png` redirects (`branding.php`) | `src/web/branding-routes.ts` | 404 / static `/site.webmanifest`, as before |
| 9 | Logo on sign-in, buyer and staff-dashboard pages (not only the public site) | `applyBrand`; `mf-logo` meta read by `dashboard-shell.js` | Default "M" mark |
| 10 | Footer "Explore" links manageable in the dashboard | `footer_explore_navigation` | Standard links |
| 11 | A managed header link to `/contact` keeps the call-to-action style | `src/index.ts` | n/a |
| 12 | SVG and ICO uploads in the media library, with a strict SVG screen and sandboxing CSP | `src/security/svg-sanitizer.ts`, media upload route, security headers | n/a |
| 13 | WebP and GIF accepted for listing images (upload and library attach) | `src/admin/routes.ts` | JPEG/PNG still work |
| 14 | ETag / 304 for public media and listing images (answered before any storage read) | `src/index.ts`, `src/web/pages/public.tsx`, `src/middleware/public-cache.ts` | n/a |
| 15 | `decoding="async"` on listing images; hero image aspect-ratio and placeholder colour (layout-shift fix) | `opportunity-card.tsx`, `public.tsx`, `site.css` | n/a |
| 16 | Settings UI groups, placeholders and validation for all of the above | `src/admin/routes.ts`, `dashboard-json-editors.js`, `dashboard-settings.js` | n/a |
| 17 | Optional content seed (expanded Chairman copy, LinkedIn link, "More from Mayfair" blocks) | `scripts/seed-php-parity-content.sql` | Not applied unless you run it |

## Behaviour changes to review

* The WhatsApp control is now a round icon, not a "WhatsApp ↗" text pill (as in the PHP v5.1 request).
* The e-mail button appears by default on every page that shows WhatsApp. Turn it off with
  `email_widget_enabled = off`.
* **Media cache policy.** `publicCacheMiddleware` previously forced `no-store` on everything under `/media/`,
  overriding the headers the media handlers set. Responses that carry an ETag now keep their own policy:
  `/media/:id` is `max-age=0, must-revalidate` (revalidated on every use, still 404 once no longer public) and
  listing images are `max-age=300`, as the handler already declared. Other `/media/` responses are unchanged.
  Consequence: a listing image can stay visible for up to five minutes after unpublishing, in browsers and
  shared caches that already hold it.
* Header navigation settings previously dropped the call-to-action style on `/contact`; it is now kept.

## Not integrated, and why

| PHP feature | Reason |
|---|---|
| Cached 480/800/1280 px image variants (PHP GD) | Needs Cloudflare Images (an `IMAGES` binding) or Image Resizing on the zone, which this project does not configure. Original files are served. |
| `file[]` upload field name | PHP-specific. This build keeps `file`. |
| Signed-NDA "scan pending" labels in `buyer-dashboard.js` / `dashboard-nda.js` | The PHP scanner is asynchronous. Here the upload route scans inline and reports `clean`, and the API does not expose a pending state. |
| HMAC scanner callback endpoint, scan-event inventory | Replaced here by the scanner service (`scanner-service/`). |
| MySQL job queue, dead-letter table, cron worker | Replaced here by Cloudflare Queues with a DLQ. |
| `bin/check-*.php`, `invariants.json`, `.htaccess`, private-folder layout | cPanel deployment tooling. |
| Legacy listing editor, Homepage-sections manager, Navigation manager | Retired in the PHP edition itself; superseded here by the opportunity CMS and Platform settings. |
| Seeded default header/footer menus | Empty lists already keep the standard links; seeding would only freeze today's links. |
| `promote-super-admin.php` | `scripts/provision-staff.sql.example` covers staff provisioning. |

## Applying

1. Deploy as usual. No numbered migration was added (the release gates assert 0001–0030).
2. Optional: review and run `scripts/seed-php-parity-content.sql`.
3. Set links and images in **Dashboard → Platform settings** (new groups: *Icons, sharing image and chairman photo*,
   *Chairman profile and social links*; the e-mail button lives under *Contact and analytics*).

## Verification status

Not run here (no dependencies or network in the build environment): `pnpm typecheck`, `pnpm lint`, `pnpm test`,
`prettier --check`, and a live Worker. What was run: a TypeScript parse of every changed file; a strict-mode type
check of the new standalone modules; behavioural tests of the SVG screen, URL validators, social rows and the
HTML brand pass; and a before/after evaluation of the existing source-invariant test assertions (no new failures).
Run `pnpm check` and a staging smoke test (home, About, contact, a listing image, `/dashboard/settings/ui`,
upload an SVG logo) before release.

## Audit addendum (second pass)

Independent audit of the delivered build against `casinosofmayfair-php-staging-final-v6`:

* Every item in the table above was confirmed present in source; the 14 changed and 8 added files parse cleanly.
* Re-checked as already present in this build (no change needed): honeypot field on contact and managed forms,
  analytics consent, failed/dead notification view (`/dashboard/notifications`), login lockout, audit CSV export,
  scanner switch, request IDs, legacy-listing import.
* Added: `fetchpriority="high"` on the opportunity detail cover image (PHP v4.9 image-priority attribute).
* Added: `scripts/check-listing-images.sql`, a read-only D1 diagnostic equivalent to the PHP `bin/check-images.php`.
* Deliberately not added: stylesheet version query strings (`/static/*` is cached for one hour, not immutable, so
  changed CSS refreshes on its own), gzip configuration (Cloudflare compresses at the edge).
* SVG screen re-tested with 10 hostile samples (script, handlers, javascript: URLs, external href/url(), @import,
  foreignObject, ENTITY, protocol-relative use, non-SVG root): all rejected; a clean SVG accepted.
* Still Unverified: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `prettier --check`, live Worker (no dependencies or
  network here). Run `pnpm check` before pushing.
