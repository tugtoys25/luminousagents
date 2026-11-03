# Site content (dashboard: Settings > Site content)

All public wording, layout and appearance that used to be hard-coded is a **collection** in
`src/site-content/registry-*.ts`. The registry is the single definition used by the validator, the admin API and the
dashboard form, so adding a field in one place adds it everywhere.

| Area | Collections |
| --- | --- |
| Home page | `hero`, `home_sections` (order, hide, custom sections), `copy` (all section wording) |
| Lists | `trust`, `stats`, `services`, `offices`, `markets`, `faqs` |
| Navigation | `nav_header`, `nav_footer_explore`, `nav_footer_info` |
| Appearance | `theme` (colours, fonts, size, corners, page width, header style, button shape, page background) |
| Search and footer | `seo`, `footer` |

## How defaults work
- A collection with no row in `site_content_collections` shows its **built-in** content (code defaults).
- First edit copies the built-in content into `site_content_items`; from then on the database is the whole truth,
  so staff can also delete every item. **Reset** removes the override and the built-ins return.
- Brand identity defaults live in `src/brand/defaults.ts`. The older Platform settings (site name, logo, contact, cookie
  banner, social links) still work; where both exist, a customised Site content collection wins for navigation
  and theme.

## API (`/dashboard/site-content/api`, staff only, audited)
`GET schema` · `GET :collection` · `POST :collection/customise` · `POST :collection/items` · `PUT :collection/items/:id` ·
`DELETE :collection/items/:id` · `POST :collection/reorder` · `PUT :collection/singleton` · `DELETE :collection` (reset).
Read and write: admin, super_admin, editor. Delete and reset: admin, super_admin.

## Safety
Links are same-site paths, `#anchors` or https; colours are `#rrggbb`; fonts are a fixed list plus a sanitised stack;
all output is escaped by the JSX renderer. No custom CSS or script is accepted.

## One footer everywhere
The footer is a single component (`src/web/components/site-footer.tsx`). Public pages render it through `BaseLayout`;
dashboard, buyer, seller and sign-in pages get the same markup injected by `withSharedFooter`
(`src/web/shared-footer.tsx`), so editing **Footer and brand line** changes all of them. Two switches in that block
turn it off for the staff dashboard or for buyer, seller and sign-in pages. The workspace shell places the dashboard
copy under the page content.
