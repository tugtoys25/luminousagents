import { Hono } from 'hono';
import { requireRole } from '../../auth/staff-session';
import { listAuditForEntity } from '../../seller/audit-repo';
import { listInterests } from '../../seller/interest-repo';
import { loadSeller, sellerScopeOf } from '../../seller/seller-access';
import {
  getSeller, listSellerAuthority, listSellerChanges, listSellerCommunications, listSellerEnquiries, listSellerFollowups, listSellerLinks, listSellerNotes,
  listSellerContacts, listSellers, SELLER_PAGE_SIZE, updateSeller,
} from '../../seller/seller-repo';
import { sellerListQuery, sellerUpdateSchema } from '../../seller/seller-schemas';
import { jsonError, readJson } from '../../seller/staff-access';
import { authorityTransitions, isAuthorityStatus } from '../../seller/authority';
import { type AdminApp, id, now, sellerWorkRoles } from '../shared';

const admin = new Hono<AdminApp>();
const COLUMNS: Record<string, string> = {
  displayName: 'display_name', organisation: 'organisation', contactName: 'contact_name', contactEmail: 'contact_email',
  contactTelephone: 'contact_telephone', status: 'status', confidentialityRestrictions: 'confidentiality_restrictions',
};

admin.get('/sellers/ui', requireRole(...sellerWorkRoles), async (c) =>
  c.html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sellers · Casinos of Mayfair</title><link rel="stylesheet" href="/static/css/site.css"><link rel="stylesheet" href="/static/css/dashboard.css"></head><body><main class="admin"><p class="eyebrow">STAFF WORKSPACE</p><h1>Sellers</h1><nav class="admin-nav"><a href="/dashboard">Overview</a><a href="/dashboard/seller-enquiries/ui">Seller enquiries</a><a href="/dashboard/sellers/ui">Sellers</a><a href="/admin/logout">Sign out</a></nav><p class="muted">Confidential. Authority is verified only by a recorded review; a seller record, a role claim or an evidence reference is not authority to market.</p><form id="sl-filters" class="enq-bar" role="search"></form><p id="sl-notice" role="status"></p><div class="enq-layout"><section id="sl-list" aria-live="polite">Loading…</section><aside id="sl-detail" aria-live="polite"><p class="muted">Select a seller.</p></aside></div></main><dialog id="sl-confirm"><form method="dialog"><p id="sl-confirm-text"></p><label id="sl-note-wrap" hidden>Note (required) <textarea id="sl-confirm-note" maxlength="1000" rows="3"></textarea></label><menu><button value="cancel">Cancel</button><button value="ok" class="button button-primary">Confirm</button></menu></form></dialog><script src="/static/js/dashboard-sellers.js" defer></script></body></html>`,
  ),
);

admin.get('/sellers', requireRole(...sellerWorkRoles), async (c) => {
  const q = sellerListQuery.parse(Object.fromEntries(new URL(c.req.url).searchParams));
  const { rows, total } = await listSellers(c.env.DB, q, sellerScopeOf(c));
  return c.json({ data: rows, page: q.page, pageSize: SELLER_PAGE_SIZE, total });
});

admin.get('/sellers/:ref', requireRole(...sellerWorkRoles), async (c) => {
  const found = await loadSeller(c);
  if (found instanceof Response) return found;
  const row = await getSeller(c.env.DB, found.reference, sellerScopeOf(c));
  if (!row) return jsonError(c, 404, 'NOT_FOUND', 'Seller not found.');
  const { id: sellerId, ownerId: _owner, ...data } = row as Record<string, unknown> & { id: string; ownerId: unknown };
  void _owner;
  const [enquiries, links, authority, changes, followups, communications, notes, auditTrail, interests, contacts] = await Promise.all([
    listSellerEnquiries(c.env.DB, sellerId), listSellerLinks(c.env.DB, sellerId), listSellerAuthority(c.env.DB, sellerId), listSellerChanges(c.env.DB, sellerId),
    listSellerFollowups(c.env.DB, sellerId), listSellerCommunications(c.env.DB, sellerId), listSellerNotes(c.env.DB, sellerId), listAuditForEntity(c.env.DB, 'seller', sellerId), listInterests(c.env.DB, sellerId), listSellerContacts(c.env.DB, sellerId),
  ]);
  const withActions = authority.map((r) => ({ ...r, allowedTransitions: isAuthorityStatus(r.status) ? authorityTransitions(r.status) : [] }));
  return c.json({ data, contacts, enquiries, links, interests, authority: withActions, changes, followups, communications, notes, audit: auditTrail, canReview: ['admin', 'super_admin'].includes(c.get('staff').role) });
});

/** Corrections are version-checked, need a reason, and keep the previous value in seller_changes. */
admin.post('/sellers/:ref/update', requireRole(...sellerWorkRoles), async (c) => {
  const parsed = sellerUpdateSchema.safeParse(await readJson(c));
  if (!parsed.success) return jsonError(c, 422, 'VALIDATION_ERROR', 'Provide a reason and at least one valid change.');
  const found = await loadSeller(c);
  if (found instanceof Response) return found;
  if (parsed.data.expectedVersion !== found.version) return jsonError(c, 409, 'VERSION_CONFLICT', 'This seller changed. Reload and try again.');
  const current = await getSeller(c.env.DB, found.reference, sellerScopeOf(c));
  if (!current) return jsonError(c, 404, 'NOT_FOUND', 'Seller not found.');
  const changes = Object.entries(parsed.data.changes)
    .filter(([key]) => COLUMNS[key])
    .map(([key, value]) => ({ column: COLUMNS[key]!, field: key, oldValue: current[key] == null ? null : String(current[key]), newValue: value == null ? null : String(value), changeId: id() }))
    .filter((x) => x.oldValue !== x.newValue);
  if (!changes.length) return jsonError(c, 409, 'NO_CHANGE', 'Nothing would change.');
  const ok = await updateSeller(c.env.DB, { id: c.get('staff').id, requestId: c.get('requestId'), ts: now(), seller: found, changes, reason: parsed.data.reason, auditId: id() });
  if (!ok) return jsonError(c, 409, 'VERSION_CONFLICT', 'This seller changed. Reload and try again.');
  return c.json({ data: { reference: found.reference, version: found.version + 1 } });
});

export default admin;
