import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../env';
import { serializeOpportunity } from '../domain/opportunities/serialize';
import { findBuyerProfile, upsertBuyerProfile, listSavedPublic, publicOpportunityExists, saveOpportunity, unsaveOpportunity, listBuyerActivity } from './buyers-repo';
import { now, jsonError, requireBuyer, audit } from './shared';
import type { BuyerApp } from './shared';

const buyers = new Hono<BuyerApp>();

buyers.get('/account', async (c) =>
  c.html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Buyer account · Luminous Agents</title><link rel="stylesheet" href="/static/css/site.css"><link rel="stylesheet" href="/static/css/dashboard.css"><link rel="stylesheet" href="/static/css/buyer-dashboard.css"></head><body class="buyer-body"><div id="buyer-app"><main class="account buyer-gate" id="sign-in-wrap"><div class="buyer-gate-story"><a class="buyer-brand" href="/"><span class="buyer-brand-mark">L</span><span><strong>Luminous Agents</strong><small>PRIVATE BUYER AREA</small></span></a><h1>Your private<br><em>acquisition desk.</em></h1><p>Track your NDA, preview confidential documents and download the materials you are authorised to see, all in one place.</p><ul class="buyer-gate-points"><li>NDA status and completion at a glance</li><li>Preview shared files before you download</li><li>Every access check is re-verified on each request</li></ul></div><section id="sign-in" class="panel buyer-gate-panel"><p class="eyebrow">PRIVATE BUYER AREA</p><h2>Sign in</h2><p class="muted">Sign in to view saved opportunities, NDA request status and documents you are authorised to access.</p><p id="account-notice" class="notice" role="status"></p><form id="sign-in-form" data-auth-form data-turnstile data-endpoint="/api/buyer/auth/login" data-success-reload><label>Email address<br><input name="email" type="email" autocomplete="email" maxlength="254" required></label> <label>Password<br><input name="password" type="password" autocomplete="current-password" maxlength="200" required></label> <button type="submit" class="buyer-btn buyer-btn-primary">Sign in with password</button><p class="notice" role="status" aria-live="polite"></p></form><details><summary>Sign in with an email one-time code</summary><form id="buyer-code-request" data-auth-form data-turnstile data-endpoint="/api/buyer/auth/request-code"><label>Email address<br><input name="email" type="email" autocomplete="email" maxlength="254" required></label><button type="submit" class="buyer-btn">Email me a code</button><p class="notice" role="status" aria-live="polite"></p></form><form id="buyer-code-verify" data-auth-form data-endpoint="/api/buyer/auth/verify-code" data-success-reload><label>Email address<br><input name="email" type="email" autocomplete="email" maxlength="254" required></label><label>Six-digit code<br><input name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required></label><button type="submit" class="buyer-btn">Verify code and sign in</button><p class="notice" role="status" aria-live="polite"></p></form></details><div class="buyer-register-cta"><div><strong>New to Luminous Agents?</strong><span>Register for review. Registration does not automatically grant confidential access.</span></div><a class="buyer-btn buyer-btn-register" href="/register" id="register-button">Register as a buyer</a></div><p class="muted"><a href="/forgot-password">Forgot your password?</a> · <a href="/">Return to the public site</a></p></section></main><div id="buyer-content" class="buyer-workspace" hidden><aside class="buyer-sidebar" id="buyer-sidebar" aria-label="Buyer navigation"><a class="buyer-brand" href="/"><span class="buyer-brand-mark">L</span><span><strong>Luminous Agents</strong><small>BUYER WORKSPACE</small></span></a><nav class="buyer-nav" aria-label="Buyer sections"><p class="buyer-nav-label">Workspace</p><a class="buyer-link" href="#overview" data-view="overview">Overview</a><a class="buyer-link" href="#nda" data-view="nda">NDA &amp; access</a><a class="buyer-link" href="#documents" data-view="documents">Data room</a><a class="buyer-link" href="#saved" data-view="saved">Saved opportunities</a><p class="buyer-nav-label">Account</p><a class="buyer-link" href="#profile" data-view="profile">Profile &amp; criteria</a><a class="buyer-link" href="/account/change-password">Password</a><a class="buyer-link" href="/opportunities">Browse opportunities</a></nav><div class="buyer-user"><span class="buyer-avatar" id="buyer-avatar">M</span><span class="buyer-user-meta"><strong id="buyer-name">Buyer</strong><span id="buyer-email"></span></span></div><button id="sign-out" type="button" class="buyer-btn buyer-btn-ghost buyer-signout">Sign out</button></aside><div class="buyer-main"><header class="buyer-topbar"><button type="button" id="buyer-menu-toggle" class="buyer-icon-btn" aria-label="Open menu" aria-expanded="false" aria-controls="buyer-sidebar">☰</button><div class="buyer-crumb"><span>Workspace</span><i>/</i><b id="buyer-crumb-title">Overview</b></div><div class="buyer-themes" role="group" aria-label="Colour theme"><button type="button" class="buyer-theme-dot" data-theme-set="forest" aria-label="forest theme" title="Forest theme"></button><button type="button" class="buyer-theme-dot" data-theme-set="ivory" aria-label="ivory theme" title="Ivory theme"></button><button type="button" class="buyer-theme-dot" data-theme-set="midnight" aria-label="midnight theme" title="Midnight theme"></button></div></header><main class="buyer-content" id="buyer-main"><p id="buyer-identity" class="buyer-identity"></p><div id="buyer-flash" class="notice" role="status" aria-live="polite"></div><section class="buyer-view" id="view-overview" data-view-panel="overview"><div class="buyer-head"><p class="eyebrow">Overview</p><h1>Welcome back</h1><p class="muted">Your NDA progress, authorised documents and saved opportunities.</p></div><div class="buyer-metrics" id="buyer-metrics"></div><div class="buyer-card"><h2>NDA completion</h2><div id="overview-progress">Loading…</div></div><div class="buyer-card"><div class="buyer-card-head"><h2>Recently available documents</h2><a class="buyer-btn buyer-btn-sm" href="#documents">Open data room</a></div><div id="overview-docs">Loading…</div></div></section><section class="buyer-view" id="view-nda" data-view-panel="nda" hidden><div class="buyer-head"><p class="eyebrow">NDA &amp; access</p><h1>NDA &amp; access</h1><p class="muted">Download the NDA, track how far each request has progressed and see when access is live.</p></div><section id="nda-request-panel" class="buyer-card" hidden><h2>Request confidential access</h2><p class="muted">Review the active template below. This acknowledgement is not a qualified electronic signature.</p><pre id="nda-template-content" class="nda-template-content">Loading NDA template…</pre><p class="muted" id="nda-template-version"></p><div class="buyer-actions"><a class="buyer-btn buyer-btn-primary" id="nda-template-download" href="/api/buyer/nda-template/download" download>Download NDA</a></div><form id="nda-request-form"><label>Full legal name<br><input name="acceptanceName" minlength="2" maxlength="160" autocomplete="name" required></label> <button type="submit" class="buyer-btn buyer-btn-primary">Submit NDA request</button></form></section><div class="buyer-card"><div class="buyer-card-head"><h2>Your NDA template</h2><a class="buyer-btn buyer-btn-primary buyer-btn-sm" id="nda-template-download-main" href="/api/buyer/nda-template/download" download>Download NDA</a></div><p class="muted" id="nda-template-note">Download the current NDA to review it offline or sign it for upload.</p><progress id="nda-dl-progress" class="buyer-progress" max="100" value="0" hidden aria-label="NDA download progress"></progress><p id="nda-dl-status" class="buyer-dl-status" role="status" aria-live="polite"></p></div><div class="buyer-card"><h2>NDA requests &amp; completion</h2><div id="nda-list">Loading…</div></div></section><section class="buyer-view" id="view-documents" data-view-panel="documents" hidden><div class="buyer-head"><p class="eyebrow">Data room</p><h1>Shared documents</h1><p class="muted">Preview a file first if you wish, then download it. Only security-scanned files within your access tier appear here.</p></div><div id="docs-root">Loading…</div></section><section class="buyer-view" id="view-saved" data-view-panel="saved" hidden><div class="buyer-head"><p class="eyebrow">Saved</p><h1>Saved opportunities</h1><p class="muted">Opportunities you bookmarked while browsing.</p></div><div class="buyer-card"><div id="saved-list">Loading…</div></div></section><section class="buyer-view" id="view-profile" data-view-panel="profile" hidden><div class="buyer-head"><p class="eyebrow">Profile</p><h1>Buyer profile &amp; acquisition requirements</h1><p class="muted">These details help the team understand your acquisition criteria. They are private to your account and authorised staff.</p></div><section id="buyer-profile-panel" class="buyer-card"><form id="buyer-profile-form"><label>Company name<br><input name="companyName" maxlength="180" autocomplete="organization"></label><label>Role / title<br><input name="roleTitle" maxlength="120" autocomplete="organization-title"></label><label>Countries or regions of interest (comma-separated)<br><input name="countries" maxlength="1200" placeholder="United Kingdom, Spain, Europe"></label><div class="flow-grid"><label>Minimum budget<br><input name="budgetMin" type="number" min="0" max="1000000000" step="0.01"></label><label>Maximum budget<br><input name="budgetMax" type="number" min="0" max="1000000000" step="0.01"></label><label>Currency<br><select name="currency"><option value="GBP">GBP (£)</option><option value="USD">USD ($)</option><option value="EUR">EUR (€)</option></select></label></div><label>Acquisition experience and requirements<br><textarea name="experienceNotes" maxlength="3000" rows="4"></textarea></label><button type="submit" class="buyer-btn buyer-btn-primary">Save profile</button><p id="buyer-profile-notice" class="notice" role="status" aria-live="polite"></p></form></section></section></main></div></div><div class="buyer-modal" id="preview-modal" hidden role="dialog" aria-modal="true" aria-labelledby="preview-title"><div class="buyer-modal-box"><header class="buyer-modal-head"><h2 id="preview-title">Preview</h2><div class="buyer-modal-actions"><a class="buyer-btn buyer-btn-primary buyer-btn-sm" id="preview-download" href="#">Download</a><button type="button" class="buyer-btn buyer-btn-sm" id="preview-close">Close</button></div></header><div class="buyer-modal-body" id="preview-body"></div></div></div></div><script src="/static/js/turnstile-forms.js" defer></script><script src="/static/js/auth-forms.js" defer></script><script src="/static/js/buyer-dashboard.js" defer></script></body></html>`,
  ),
);

buyers.get('/api/buyer/me', requireBuyer, async (c) => c.json({ data: c.get('buyer') }));

const buyerProfileShape = z
  .object({
    companyName: z.string().trim().max(180).default(''),
    roleTitle: z.string().trim().max(120).default(''),
    countries: z.array(z.string().trim().min(2).max(100)).max(20).default([]),
    budgetMin: z.number().finite().min(0).max(1_000_000_000).nullable().default(null),
    budgetMax: z.number().finite().min(0).max(1_000_000_000).nullable().default(null),
    currency: z.enum(['GBP', 'USD', 'EUR']).default('GBP'),
    experienceNotes: z.string().trim().max(3000).default(''),
  })
  .strict();

async function getBuyerProfile(env: Env, userId: string) {
  const row = await findBuyerProfile(env.DB, userId);
  if (!row) {
    return {
      companyName: '',
      roleTitle: '',
      countries: [],
      budgetMin: null,
      budgetMax: null,
      currency: 'GBP',
      experienceNotes: '',
      updatedAt: null,
    };
  }
  let countries: string[] = [];
  try {
    const value: unknown = JSON.parse(row.countriesJson);
    if (Array.isArray(value))
      countries = value.filter((item): item is string => typeof item === 'string').slice(0, 20);
  } catch {
    countries = [];
  }
  return {
    companyName: row.companyName,
    roleTitle: row.roleTitle,
    countries,
    budgetMin: row.budgetMinMinor === null ? null : row.budgetMinMinor / 100,
    budgetMax: row.budgetMaxMinor === null ? null : row.budgetMaxMinor / 100,
    currency: ['GBP', 'USD', 'EUR'].includes(row.currency) ? row.currency : 'GBP',
    experienceNotes: row.experienceNotes,
    updatedAt: row.updatedAt,
  };
}

buyers.get('/api/buyer/profile', requireBuyer, async (c) => {
  c.header('Cache-Control', 'private, no-store');
  return c.json({ data: await getBuyerProfile(c.env, c.get('buyer').id) });
});

buyers.put('/api/buyer/profile', requireBuyer, async (c) => {
  const parsed = buyerProfileShape.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return jsonError(
      c,
      422,
      'VALIDATION_ERROR',
      'Check your profile and acquisition requirements.',
    );
  const profile = parsed.data;
  if (
    profile.budgetMin !== null &&
    profile.budgetMax !== null &&
    profile.budgetMin > profile.budgetMax
  ) {
    return jsonError(
      c,
      422,
      'INVALID_BUDGET_RANGE',
      'Minimum budget cannot exceed maximum budget.',
    );
  }
  const countries = [
    ...new Set(profile.countries.map((country) => country.trim()).filter(Boolean)),
  ];
  const timestamp = now();
  const userId = c.get('buyer').id;
  await upsertBuyerProfile(c.env.DB, {
    userId,
    companyName: profile.companyName,
    roleTitle: profile.roleTitle,
    countriesJson: JSON.stringify(countries),
    budgetMinMinor: profile.budgetMin === null ? null : Math.round(profile.budgetMin * 100),
    budgetMaxMinor: profile.budgetMax === null ? null : Math.round(profile.budgetMax * 100),
    currency: profile.currency,
    experienceNotes: profile.experienceNotes,
    timestamp,
  });
  await audit(c, 'buyer.profile_updated', 'buyer_profile', userId, {
    fields: [
      'companyName',
      'roleTitle',
      'countries',
      'budgetMin',
      'budgetMax',
      'currency',
      'experienceNotes',
    ],
  });
  c.header('Cache-Control', 'private, no-store');
  return c.json({ data: await getBuyerProfile(c.env, userId) });
});
buyers.get('/api/buyer/opportunities', requireBuyer, async (c) => {
  const saved = await listSavedPublic(c.env.DB, c.get('buyer').id);
  c.header('Cache-Control', 'private, no-store');
  return c.json({
    data: saved.map((row) => ({
      ...serializeOpportunity(row, 0),
      savedAt: row.savedAt,
    })),
  });
});
buyers.post('/api/buyer/opportunities/:id/save', requireBuyer, async (c) => {
  if (!(await publicOpportunityExists(c.env.DB, c.req.param('id') ?? '')))
    return jsonError(c, 404, 'NOT_FOUND', 'Opportunity not found.');
  await saveOpportunity(c.env.DB, c.get('buyer').id, c.req.param('id') ?? '', now());
  await audit(c, 'opportunity.saved', 'opportunity', c.req.param('id') ?? '');
  return c.json({ data: { saved: true } }, 201);
});
buyers.delete('/api/buyer/opportunities/:id/save', requireBuyer, async (c) => {
  await unsaveOpportunity(c.env.DB, c.get('buyer').id, c.req.param('id') ?? '');
  await audit(c, 'opportunity.unsaved', 'opportunity', c.req.param('id') ?? '');
  return c.json({ data: { saved: false } });
});

buyers.get('/api/buyer/activity', requireBuyer, async (c) => {
  const activity = await listBuyerActivity(c.env.DB, c.get('buyer').id);
  let ndaDownloadedAt: string | null = null;
  const documents: Record<string, { downloadedAt?: string; previewedAt?: string }> = {};
  for (const row of activity) {
    if (row.action === 'nda.template_downloaded') {
      if (!ndaDownloadedAt || row.at > ndaDownloadedAt) ndaDownloadedAt = row.at;
    } else {
      const entry = (documents[row.entityId] ??= {});
      if (row.action === 'document.downloaded') entry.downloadedAt = row.at;
      else entry.previewedAt = row.at;
    }
  }
  c.header('Cache-Control', 'private, no-store');
  return c.json({ data: { ndaDownloadedAt, documents } });
});


export default buyers;
