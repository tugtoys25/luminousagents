import { requireRole } from '../../auth/staff-session';
import { Hono } from 'hono';
import { type AdminApp, audit } from '../shared';
import { countAudit, exportAuditRows, pageAudit } from '../repos/audit-repo';

const admin = new Hono<AdminApp>();

admin.get('/audit/ui', requireRole('admin', 'auditor', 'super_admin'), async (c) =>
  c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Audit log · Casinos of Mayfair</title><link rel="stylesheet" href="/static/css/site.css"><link rel="stylesheet" href="/static/css/dashboard.css"></head><body><main class="admin"><p class="eyebrow">GOVERNANCE</p><h1>Audit log</h1><nav class="admin-nav"><a href="/dashboard">Overview</a><a href="/dashboard/opportunities/ui">Opportunity CMS</a><a href="/dashboard/nda-requests/ui">NDA requests</a><a href="/dashboard/staff/ui">Staff accounts</a><a href="/admin/logout">Sign out</a></nav><p class="muted">Read-only record of administrative and platform events. Filters are applied server-side; details are metadata, not a substitute for reviewing the underlying record.</p><form id="audit-filters" class="flow-grid"><label>Search <input id="audit-search" type="search" maxlength="100" placeholder="Action, entity ID or actor email"></label><label>Action contains <input id="audit-action" type="text" maxlength="100" placeholder="opportunity.updated"></label><label>Entity type <input id="audit-entity" type="text" maxlength="60" placeholder="opportunity"></label><label>From date <input id="audit-from" type="date"></label><label>To date <input id="audit-to" type="date"></label><div class="btn-row"><button type="submit">Apply filters</button><button id="audit-reset" type="button" class="secondary">Reset</button><button id="audit-export" type="button" class="secondary">Export filtered CSV</button></div></form><p class="muted">CSV export is limited to 5,000 matching events per download. Narrow the filters if the result is larger.</p><p id="audit-status" role="status" aria-live="polite">Loading audit events…</p><div class="overflow-x-auto"><table><thead><tr><th>When (UTC)</th><th>Actor</th><th>Action</th><th>Entity</th><th>Details</th></tr></thead><tbody id="audit-rows"><tr><td colspan="5">Loading…</td></tr></tbody></table></div><div class="btn-row"><button id="audit-prev" type="button" disabled>Previous</button><span id="audit-page">Page 1</span><button id="audit-next" type="button" disabled>Next</button></div></main><script src="/static/js/dashboard-audit.js" defer></script></body></html>`),
);

admin.get('/audit/export.csv', requireRole('admin', 'auditor', 'super_admin'), async (c) => {
  const query = c.req.query();
  const search = (query.search ?? '').trim().slice(0, 100);
  const action = (query.action ?? '').trim().slice(0, 100);
  const entityType = (query.entityType ?? '').trim().slice(0, 60);
  const from = query.from ?? '';
  const to = query.to ?? '';
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  const validDate = (value: string) => {
    if (!datePattern.test(value)) return false;
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  };
  if ((from && !validDate(from)) || (to && !validDate(to)) || (from && to && from > to))
    return c.json({ error: { code: 'INVALID_AUDIT_FILTER', message: 'Use valid dates and ensure the start date is not after the end date.' } }, 422);
  const where: string[] = [];
  const binds: string[] = [];
  if (search) { where.push('(a.action LIKE ? OR a.entity_id LIKE ? OR u.email LIKE ?)'); const term = `%${search}%`; binds.push(term, term, term); }
  if (action) { where.push('a.action LIKE ?'); binds.push(`%${action}%`); }
  if (entityType) { where.push('a.entity_type = ?'); binds.push(entityType); }
  if (from) { where.push('a.created_at >= ?'); binds.push(`${from}T00:00:00.000Z`); }
  if (to) { where.push('a.created_at < ?'); const next = new Date(`${to}T00:00:00.000Z`); next.setUTCDate(next.getUTCDate() + 1); binds.push(next.toISOString()); }
  const filterSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const rows = await exportAuditRows(c.env.DB, { filterSql, binds });
  if (rows.length > 5000)
    return c.json({ error: { code: 'AUDIT_EXPORT_TOO_LARGE', message: 'More than 5,000 events match. Add filters and try again.' } }, 422);
  const cell = (value: unknown) => {
    let text = value == null ? '' : typeof value === 'string' ? value : String(value);
    if (/^[\s]*[=+@-]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const header = ['id', 'created_at_utc', 'actor_email', 'actor_type', 'action', 'entity_type', 'entity_id', 'request_id', 'details_json'];
  const csv = [header, ...rows.map((row) => [row.id, row.createdAt, row.actorEmail, row.actorType, row.action, row.entityType, row.entityId, row.requestId, row.details])]
    .map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n';
  await audit(c, 'audit.exported', 'audit_log', 'filtered', { count: rows.length, filters: { search: Boolean(search), action: Boolean(action), entityType: Boolean(entityType), from: from || null, to: to || null }, format: 'csv' });
  c.header('Cache-Control', 'private, no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Content-Type', 'text/csv; charset=utf-8');
  c.header('Content-Disposition', `attachment; filename="casinos-of-mayfair-audit-${new Date().toISOString().slice(0, 10)}.csv"`);
  return c.body(csv);
});

admin.get('/audit', requireRole('admin', 'auditor', 'super_admin'), async (c) => {
  const query = c.req.query();
  const pageRaw = Number(query.page ?? 1);
  const limitRaw = Number(query.limit ?? 50);
  const requestedPage = Number.isSafeInteger(pageRaw) ? Math.max(1, Math.min(10000, pageRaw)) : 1;
  const limit = Number.isSafeInteger(limitRaw) ? Math.max(1, Math.min(100, limitRaw)) : 50;
  const search = (query.search ?? '').trim().slice(0, 100);
  const action = (query.action ?? '').trim().slice(0, 100);
  const entityType = (query.entityType ?? '').trim().slice(0, 60);
  const from = query.from ?? '';
  const to = query.to ?? '';
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  const validDate = (value: string) => {
    if (!datePattern.test(value)) return false;
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  };
  if ((from && !validDate(from)) || (to && !validDate(to)) || (from && to && from > to))
    return c.json({ error: { code: 'INVALID_AUDIT_FILTER', message: 'Use valid dates and ensure the start date is not after the end date.' } }, 422);
  const where: string[] = [];
  const binds: (string | number)[] = [];
  if (search) { where.push('(a.action LIKE ? OR a.entity_id LIKE ? OR u.email LIKE ?)'); const term = `%${search}%`; binds.push(term, term, term); }
  if (action) { where.push('a.action LIKE ?'); binds.push(`%${action}%`); }
  if (entityType) { where.push('a.entity_type = ?'); binds.push(entityType); }
  if (from) { where.push('a.created_at >= ?'); binds.push(`${from}T00:00:00.000Z`); }
  if (to) { where.push('a.created_at < ?'); const next = new Date(`${to}T00:00:00.000Z`); next.setUTCDate(next.getUTCDate() + 1); binds.push(next.toISOString()); }
  const filterSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const total = await countAudit(c.env.DB, { filterSql, binds });
  const pages = Math.ceil(total / limit);
  const page = Math.min(requestedPage, Math.max(1, pages));
  const offset = (page - 1) * limit;
  const data = await pageAudit(c.env.DB, { filterSql, binds }, limit, offset);
  c.header('Cache-Control', 'private, no-store');
  return c.json({ data, page, limit, total, pages });
});

export default admin;
