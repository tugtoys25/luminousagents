# Sprint 18 final: staff workspace redesign

Base: stable Sprint 18 (Sprint 17 + dev-team Sprint 18). Reference: Lummet tenant v18.7 patterns (sticky action bar,
numbered step cards, search-result preview with counters, unsaved-changes state, Ctrl/Cmd+S, slug from title).
No migrations. No API, authorization, or data-model changes. All existing element ids and form field names are unchanged.

## What changed

**Workspace shell** (`public/static/js/dashboard-shell.js`, rewritten)

- One canonical, grouped menu on every page (Workspace, Deal management, Operations, Content & site, Governance) with icons and
  the current page highlighted. Sprint 18 built the menu from each page's own link list, so the sidebar differed page to page and
  some links landed in the wrong group. Any legacy link not in the canonical list is kept under "More".
- Role-aware: Staff accounts appears for `super_admin` only (the server still enforces it). The role and name come from a small
  meta tag added by the middleware in `src/index.ts` (escaped).
- Command palette (Ctrl/Cmd+K or `/`): jump to any page, run quick actions, switch theme. Menu filter in the sidebar.
- Breadcrumb top bar, collapsible sidebar (remembered), mobile drawer with overlay, user chip with account links.
- Three themes, remembered per browser: Forest (default), Ivory, Midnight.

**Design system** (`public/static/css/dashboard.css`): token-based colours, cards, tables, badges, buttons (primary, secondary,
danger), banners, toasts, focus rings, reduced-motion and print rules. Pages without JavaScript keep the legacy styles and nav.

**Forms and edit flows**

- Opportunity CMS: list panel with search-as-you-type and status badges; editor in three numbered steps (opportunity, summary and
  detail, search appearance) with a sticky bar showing title, status badges, "Unsaved changes" state, New and Save draft. Review
  and publication, and listing images, are separate cards.
- Pages: list panel with status badges, Edit and View, New page button; three-step editor; slug is generated from the title for new pages.
- Platform settings: fields grouped into four sections; colour swatches; live JSON validation for navigation and section fields.
- All editor forms: character counters, search-result preview (Google-style) for SEO fields, Ctrl/Cmd+S, leave-page warning when
  there are unsaved changes, status messages shown as banners and toasts.
- Dynamic lists (buyers, grants, NDA requests, tasks, jobs, pages, forms, submissions) and long tables get a filter box.

**Overview**: key-number cards (linked), quick actions, review queue and recent opportunities with status badges.

## Tests

- New `test/unit/sprint18-security-invariants.test.ts` (runs under `pnpm test:node`): no dynamic code in the shell, every menu link has
  a server route, Staff accounts stays `super_admin` only on the server, injected identity meta is escaped, themes defined.

## Verified in this build environment

- Headless Chromium against the real page markup with mocked API responses: shell and menu, current-page highlight, palette, three
  themes, CMS select/edit flow with badges and unsaved state, slug generation, mobile drawer without horizontal scroll, no console errors.
- Syntax checks on all changed JS and TS.

## Not run here (run in CI before release)

- `pnpm install`, `pnpm check` (typecheck, lint, tests), `pnpm preflight:final`. This environment had no pnpm and broken `node_modules` links.
- `pnpm format` once (long lines were added in `routes.ts` settings groups).
- Check by hand with each staff role: tasks, buyers, access grants, NDA requests/templates, forms, staff, audit and enquiries pages
  received the shared shell, theme and generic form styling only; their markup and scripts are unchanged and were not browser-tested with live data.
