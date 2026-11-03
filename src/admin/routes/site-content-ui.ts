import { Hono } from 'hono';
import { requireRole } from '../../auth/staff-session';
import type { AdminApp } from '../shared';

const admin = new Hono<AdminApp>();

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Site content · Settings</title><link rel="stylesheet" href="/static/css/site.css"><link rel="stylesheet" href="/static/css/dashboard.css"><link rel="stylesheet" href="/static/css/dashboard-site-content.css"></head><body><main class="admin"><p class="eyebrow">STAFF WORKSPACE</p><h1>Settings</h1><nav class="admin-nav" aria-label="Settings tabs"><a href="/dashboard">Overview</a><a href="/dashboard/settings/ui">Platform settings</a><a href="/dashboard/site-content/ui" aria-current="page"><strong>Site content</strong></a><a href="/dashboard/pages/ui">Pages</a><a href="/dashboard/forms/ui">Forms</a><a href="/admin/logout">Sign out</a></nav><p class="muted">Everything the public site says and shows. Built-in content stays exactly as shipped until you customise it; reset any block to return to the built-in version.</p><div class="sc-layout"><nav class="sc-nav" id="sc-nav" aria-label="Content areas">Loading…</nav><section class="sc-main" id="sc-main" aria-live="polite"></section></div></main><script src="/static/js/dashboard-kit.js" defer></script><script src="/static/js/dashboard-site-content-fields.js" defer></script><script src="/static/js/dashboard-site-content.js" defer></script></body></html>`;

admin.get('/site-content/ui', requireRole('admin', 'super_admin', 'editor'), (c) => c.html(PAGE));

export default admin;
