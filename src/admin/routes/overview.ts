import { requireRole } from '../../auth/staff-session';
import { Hono } from 'hono';
import type { AdminApp } from '../shared';
import { listActiveBrokers, loadOverview } from '../repos/overview-repo';

const admin = new Hono<AdminApp>();

admin.get('/', async (c) => {
  const staff = c.get('staff');
  const brokerOnly = staff.role === 'broker' ? 1 : 0;
  const { counts, pending, recent } = await loadOverview(c.env.DB, staff.id, brokerOnly);
  const escape = (s: unknown) =>
    String(s ?? '').replace(
      /[&<>"']/g,
      (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
    );
  const toneFor = (value: unknown): string => {
    const v = String(value ?? '').toLowerCase();
    if (v === 'approved' || v === 'published') return 'ok';
    if (v === 'pending' || v === 'draft' || v === 'under_offer' || v === 'on_hold') return 'warn';
    if (v === 'rejected' || v === 'sold' || v === 'archived') return 'danger';
    return '';
  };
  const badge = (value: unknown) => {
    const tone = toneFor(value);
    return `<span class="ws-badge${tone ? ` ws-badge--${tone}` : ''}">${escape(String(value ?? '—').replace(/_/g, ' '))}</span>`;
  };
  const rows = recent
    .map((item) => {
      const row = item as Record<string, unknown>;
      return `<tr><td>${escape(row.title)}</td><td>${escape(row.country || '—')}</td><td>${badge(row.lifecycle)}</td><td>${badge(row.reviewStatus)}</td><td><a href="/dashboard/opportunities/ui?selected=${encodeURIComponent(String(row.id))}">Open</a></td></tr>`;
    })
    .join('');
  const pendingRows = pending
    .map((item) => {
      const row = item as Record<string, unknown>;
      return `<li><a href="/dashboard/opportunities/ui?selected=${encodeURIComponent(String(row.id))}">${escape(row.title)}</a><span class="ws-badge">${escape(row.country || 'Country not set')}</span></li>`;
    })
    .join('');
  return c.html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Staff dashboard · Luminous Agents</title><link rel="stylesheet" href="/static/css/site.css"><link rel="stylesheet" href="/static/css/dashboard.css"></head><body><main class="admin"><p class="eyebrow">STAFF WORKSPACE</p><h1>Platform dashboard</h1><p class="muted">Signed in as ${escape(staff.displayName || staff.email)} · ${escape(staff.role)}</p><nav class="admin-nav"><a href="/dashboard">Overview</a><a href="/dashboard/opportunities/ui">Opportunity CMS</a><a href="/dashboard/opportunities/review-queue/ui">Needs review</a><a href="/dashboard/buyers/ui">Buyer access</a><a href="/dashboard/enquiries/ui">Enquiries</a><a href="/dashboard/tasks/ui">Tasks</a><a href="/dashboard/notifications/ui">Notifications</a><a href="/dashboard/nda-requests/ui">NDA requests</a><a href="/dashboard/access-grants/ui">Access grants</a><a href="/dashboard/documents/ui">Data room documents</a><a href="/dashboard/nda-templates/ui">NDA templates</a><a href="/dashboard/audit/ui">Audit log</a>${staff.role === 'super_admin' ? '<a href="/dashboard/staff/ui">Staff accounts</a><a href="/dashboard/sessions/ui">Staff sessions</a><a href="/dashboard/buyer-sessions/ui">Buyer sessions</a>' : ''}<a href="/dashboard/settings/ui">Platform settings</a><a href="/dashboard/pages/ui">Pages</a><a href="/dashboard/forms/ui">Forms</a><a href="/admin/change-password">Change password</a><a href="/">View public site</a><a href="/admin/logout">Sign out</a></nav><section class="metric-grid" aria-label="Key numbers"><a class="metric" href="/dashboard/opportunities/ui"><span class="muted">Total records</span><strong>${counts?.total ?? 0}</strong><small>Opportunities you can access</small></a><a class="metric" href="/dashboard/opportunities/ui" data-tone="${(counts?.pending ?? 0) > 0 ? 'warn' : 'ok'}"><span class="muted">Awaiting review</span><strong>${counts?.pending ?? 0}</strong><small>${(counts?.pending ?? 0) > 0 ? 'Content waiting for a decision' : 'Nothing waiting'}</small></a><a class="metric" href="/dashboard/opportunities/ui" data-tone="ok"><span class="muted">Published &amp; approved</span><strong>${counts?.published ?? 0}</strong><small>Visible on the public site</small></a></section><h2>Quick actions</h2><section class="quick-grid" aria-label="Quick actions"><a class="quick-card" href="/dashboard/opportunities/ui"><strong>Opportunity CMS</strong><span>Create, edit, review and publish listings.</span></a><a class="quick-card" href="/dashboard/nda-requests/ui"><strong>NDA requests</strong><span>Review requests and grant time-limited access.</span></a><a class="quick-card" href="/dashboard/buyers/ui"><strong>Buyer access</strong><span>Approve registrations and manage accounts.</span></a><a class="quick-card" href="/dashboard/tasks/ui"><strong>Tasks</strong><span>Assign and track operational follow-ups.</span></a><a class="quick-card" href="/dashboard/pages/ui"><strong>Pages</strong><span>Write and publish SEO-friendly content pages.</span></a><a class="quick-card" href="/dashboard/settings/ui"><strong>Platform settings</strong><span>Branding, contact channels and navigation.</span></a></section><div class="dash-cols"><section class="ws-card"><h2>Needs content review</h2>${pendingRows ? `<ul class="review-list">${pendingRows}</ul>` : '<p class="empty-state">No records awaiting review.</p>'}</section><section><h2>Recently updated opportunities</h2><div class="overflow-x-auto"><table><thead><tr><th>Title</th><th>Country</th><th>Lifecycle</th><th>Review</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="5">No records yet.</td></tr>'}</tbody></table></div></section></div></main></body></html>`,
  );
});

admin.get(
  '/brokers',
  requireRole('admin', 'editor', 'broker', 'publisher', 'super_admin'),
  async (c) => {
    return c.json({ data: await listActiveBrokers(c.env.DB) });
  },
);

export default admin;
