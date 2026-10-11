import { Hono } from 'hono';
import { z } from 'zod';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env } from '../env';
import { scanR2Document, ScannerError, type VerifiedScan } from '../security/malware-scanner';
import { serializeOpportunity, type OpportunityRow } from '../domain/opportunities/serialize';

type Buyer = { id: string; email: string; displayName: string; status: string; hasPassword: number };
type BuyerApp = { Bindings: Env; Variables: { requestId: string; buyer: Buyer } };
const buyers = new Hono<BuyerApp>();
const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();
const jsonError = (
  c: Context<BuyerApp>,
  status: ContentfulStatusCode,
  code: string,
  message: string,
) => c.json({ error: { code, message }, requestId: c.get('requestId') }, status);
async function digest(value: string): Promise<string> {
  const result = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(result), (b) => b.toString(16).padStart(2, '0')).join('');
}
function readCookie(header: string | undefined, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=') || null;
  }
  return null;
}
async function buyerAuth(c: Context<BuyerApp>): Promise<Buyer | Response> {
  const token = readCookie(c.req.header('cookie'), 'mayfair_buyer_session');
  if (!token) return jsonError(c, 401, 'UNAUTHENTICATED', 'Buyer sign-in required.');
  const tokenHash = await digest(token);
  const row = await c.env.DB.prepare(
    "SELECT u.id, u.email, u.display_name AS displayName, u.status, CASE WHEN u.password_hash IS NULL THEN 0 ELSE 1 END AS hasPassword, u.must_change_password AS mustChange, s.id AS sessionId FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND u.user_type = 'buyer' AND u.status = 'active' LIMIT 1",
  )
    .bind(tokenHash, now())
    .first<Buyer & { sessionId: string; mustChange: number }>();
  if (!row) return jsonError(c, 401, 'UNAUTHENTICATED', 'Buyer session is invalid or expired.');
  await c.env.DB.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?')
    .bind(now(), row.sessionId)
    .run();
  if (row.mustChange === 1)
    return jsonError(
      c,
      403,
      'PASSWORD_CHANGE_REQUIRED',
      'Change your temporary password before continuing.',
    );
  const { sessionId: _sessionId, mustChange: _mustChange, ...buyer } = row;
  return buyer;
}
async function requireBuyer(c: Context<BuyerApp>, next: () => Promise<void>) {
  const identity = await buyerAuth(c);
  if (identity instanceof Response) return identity;
  c.set('buyer', identity);
  await next();
}
async function audit(
  c: Context<BuyerApp>,
  action: string,
  entityType: string,
  entityId: string,
  details: Record<string, unknown> = {},
) {
  await c.env.DB.prepare(
    "INSERT INTO audit_logs (id, actor_user_id, actor_type, action, entity_type, entity_id, request_id, details_json, created_at) VALUES (?, ?, 'buyer', ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      uuid(),
      c.get('buyer').id,
      action,
      entityType,
      entityId,
      c.get('requestId'),
      JSON.stringify(details),
      now(),
    )
    .run();
}

buyers.get('/account', async (c) =>
  c.html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Buyer account · Casinos of Mayfair</title><link rel="stylesheet" href="/static/css/site.css"><link rel="stylesheet" href="/static/css/dashboard.css"></head><body><main class="account"><p class="eyebrow">PRIVATE BUYER AREA</p><h1>Your account</h1><p class="muted">Sign in to view saved opportunities, NDA request status and documents you are authorised to access.</p><p id="account-notice" class="notice" role="status"></p><section id="sign-in" class="panel"><h2>Sign in</h2><form id="sign-in-form" data-auth-form data-endpoint="/api/buyer/auth/login" data-success-reload><label>Email address<br><input name="email" type="email" autocomplete="email" maxlength="254" required></label> <label>Password<br><input name="password" type="password" autocomplete="current-password" maxlength="200" required></label> <button type="submit">Sign in with password</button><p class="notice" role="status" aria-live="polite"></p></form><details><summary>Sign in with an email one-time code</summary><form id="buyer-code-request" data-auth-form data-endpoint="/api/buyer/auth/request-code"><label>Email address<br><input name="email" type="email" autocomplete="email" maxlength="254" required></label><button type="submit">Email me a code</button><p class="notice" role="status" aria-live="polite"></p></form><form id="buyer-code-verify" data-auth-form data-endpoint="/api/buyer/auth/verify-code" data-success-reload><label>Email address<br><input name="email" type="email" autocomplete="email" maxlength="254" required></label><label>Six-digit code<br><input name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required></label><button type="submit">Verify code and sign in</button><p class="notice" role="status" aria-live="polite"></p></form></details><p class="muted"><a href="/forgot-password">Forgot your password?</a></p><p class="muted">Access is available to approved, active buyer accounts only. New buyers can <a href="/register">register for review</a>; registration does not automatically grant confidential access.</p></section><section id="buyer-content" hidden><p id="buyer-identity"></p><section id="buyer-profile-panel" class="panel"><h2>Buyer profile &amp; acquisition requirements</h2><p class="muted">These details help the team understand your acquisition criteria. They are private to your account and authorised staff.</p><form id="buyer-profile-form"><label>Company name<br><input name="companyName" maxlength="180" autocomplete="organization"></label><label>Role / title<br><input name="roleTitle" maxlength="120" autocomplete="organization-title"></label><label>Countries or regions of interest (comma-separated)<br><input name="countries" maxlength="1200" placeholder="United Kingdom, Spain, Europe"></label><div class="flow-grid"><label>Minimum budget<br><input name="budgetMin" type="number" min="0" max="1000000000" step="0.01"></label><label>Maximum budget<br><input name="budgetMax" type="number" min="0" max="1000000000" step="0.01"></label><label>Currency<br><select name="currency"><option value="GBP">GBP (£)</option><option value="USD">USD ($)</option><option value="EUR">EUR (€)</option></select></label></div><label>Acquisition experience and requirements<br><textarea name="experienceNotes" maxlength="3000" rows="4"></textarea></label><button type="submit">Save profile</button><p id="buyer-profile-notice" class="notice" role="status" aria-live="polite"></p></form></section><section id="nda-request-panel" class="panel" hidden><h2>Request confidential access</h2><p>Review the active template below. This acknowledgement is not a qualified electronic signature.</p><pre id="nda-template-content" class="nda-template-content">Loading NDA template…</pre><p class="muted" id="nda-template-version"></p><form id="nda-request-form"><label>Full legal name<br><input name="acceptanceName" minlength="2" maxlength="160" autocomplete="name" required></label> <button type="submit">Submit NDA request</button></form></section><p><a href="/account/change-password">Set or change password</a> · <button id="sign-out" type="button">Sign out</button></p><div class="grid"><section class="panel"><h2>Saved opportunities</h2><div id="saved-list">Loading…</div></section><section class="panel"><h2>NDA requests &amp; access</h2><div id="nda-list">Loading…</div></section></div></section><p><a href="/">Return to the public site</a></p></main><script src="/static/js/auth-forms.js" defer></script><script src="/static/js/buyer-account.js" defer></script></body></html>`,
  ),
);

buyers.get('/api/buyer/me', requireBuyer, async (c) => c.json({ data: c.get('buyer') }));

const buyerProfileShape = z.object({
  companyName: z.string().trim().max(180).default(''),
  roleTitle: z.string().trim().max(120).default(''),
  countries: z.array(z.string().trim().min(2).max(100)).max(20).default([]),
  budgetMin: z.number().finite().min(0).max(1_000_000_000).nullable().default(null),
  budgetMax: z.number().finite().min(0).max(1_000_000_000).nullable().default(null),
  currency: z.enum(['GBP', 'USD', 'EUR']).default('GBP'),
  experienceNotes: z.string().trim().max(3000).default(''),
}).strict();

type BuyerProfileRow = {
  companyName: string;
  roleTitle: string;
  countriesJson: string;
  budgetMinMinor: number | null;
  budgetMaxMinor: number | null;
  currency: string;
  experienceNotes: string;
  updatedAt: string;
};

async function getBuyerProfile(env: Env, userId: string) {
  const row = await env.DB.prepare(
    'SELECT company_name AS companyName, role_title AS roleTitle, countries_json AS countriesJson, budget_min_minor AS budgetMinMinor, budget_max_minor AS budgetMaxMinor, currency, experience_notes AS experienceNotes, updated_at AS updatedAt FROM buyer_profiles WHERE user_id = ? LIMIT 1',
  ).bind(userId).first<BuyerProfileRow>();
  if (!row) {
    return {
      companyName: '', roleTitle: '', countries: [], budgetMin: null, budgetMax: null,
      currency: 'GBP', experienceNotes: '', updatedAt: null,
    };
  }
  let countries: string[] = [];
  try {
    const value: unknown = JSON.parse(row.countriesJson);
    if (Array.isArray(value)) countries = value.filter((item): item is string => typeof item === 'string').slice(0, 20);
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
  if (!parsed.success) return jsonError(c, 422, 'VALIDATION_ERROR', 'Check your profile and acquisition requirements.');
  const profile = parsed.data;
  if (profile.budgetMin !== null && profile.budgetMax !== null && profile.budgetMin > profile.budgetMax) {
    return jsonError(c, 422, 'INVALID_BUDGET_RANGE', 'Minimum budget cannot exceed maximum budget.');
  }
  const countries = [...new Set(profile.countries.map((country) => country.trim()).filter(Boolean))];
  const timestamp = now();
  const userId = c.get('buyer').id;
  await c.env.DB.prepare(
    `INSERT INTO buyer_profiles (user_id, company_name, role_title, countries_json, budget_min_minor, budget_max_minor, currency, experience_notes, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET company_name = excluded.company_name, role_title = excluded.role_title,
       countries_json = excluded.countries_json, budget_min_minor = excluded.budget_min_minor,
       budget_max_minor = excluded.budget_max_minor, currency = excluded.currency,
       experience_notes = excluded.experience_notes, updated_at = excluded.updated_at`,
  ).bind(
    userId, profile.companyName, profile.roleTitle, JSON.stringify(countries),
    profile.budgetMin === null ? null : Math.round(profile.budgetMin * 100),
    profile.budgetMax === null ? null : Math.round(profile.budgetMax * 100),
    profile.currency, profile.experienceNotes, timestamp,
  ).run();
  await audit(c, 'buyer.profile_updated', 'buyer_profile', userId, {
    fields: ['companyName', 'roleTitle', 'countries', 'budgetMin', 'budgetMax', 'currency', 'experienceNotes'],
  });
  c.header('Cache-Control', 'private, no-store');
  return c.json({ data: await getBuyerProfile(c.env, userId) });
});
buyers.get('/api/buyer/opportunities', requireBuyer, async (c) => {
  const result = await c.env.DB.prepare(
    "SELECT o.id, o.slug, o.title, o.country, o.opportunity_type, o.price_text, o.price_visibility, o.lifecycle, o.summary, o.availability, o.points_json, o.seo_title, o.seo_description, o.published_at, o.classification, o.labels_json, (SELECT id FROM opportunity_media m WHERE m.opportunity_id = o.id ORDER BY m.sort_order ASC, m.created_at ASC LIMIT 1) AS cover_media_id, (SELECT alt_text FROM opportunity_media ma WHERE ma.id = (SELECT id FROM opportunity_media mb WHERE mb.opportunity_id = o.id ORDER BY mb.sort_order ASC, mb.created_at ASC LIMIT 1)) AS cover_media_alt, s.created_at AS savedAt FROM saved_opportunities s JOIN opportunities o ON o.id = s.opportunity_id WHERE s.user_id = ? AND o.lifecycle = 'published' AND o.content_review_status = 'approved' AND o.public_visibility = 1 AND o.classification = 'public' ORDER BY s.created_at DESC",
  ).bind(c.get('buyer').id).all<OpportunityRow & { savedAt: string }>();
  c.header('Cache-Control', 'private, no-store');
  return c.json({ data: (result.results ?? []).map((row) => ({ ...serializeOpportunity(row, 0), savedAt: row.savedAt })) });
});
buyers.post('/api/buyer/opportunities/:id/save', requireBuyer, async (c) => {
  const opp = await c.env.DB.prepare(
    "SELECT id FROM opportunities WHERE id = ? AND lifecycle = 'published' AND content_review_status = 'approved' AND public_visibility = 1 AND classification = 'public'",
  )
    .bind(c.req.param('id'))
    .first();
  if (!opp) return jsonError(c, 404, 'NOT_FOUND', 'Opportunity not found.');
  await c.env.DB.prepare(
    'INSERT OR IGNORE INTO saved_opportunities (user_id, opportunity_id, created_at) VALUES (?, ?, ?)',
  )
    .bind(c.get('buyer').id, c.req.param('id'), now())
    .run();
  await audit(c, 'opportunity.saved', 'opportunity', c.req.param('id') ?? '');
  return c.json({ data: { saved: true } }, 201);
});
buyers.delete('/api/buyer/opportunities/:id/save', requireBuyer, async (c) => {
  await c.env.DB.prepare('DELETE FROM saved_opportunities WHERE user_id = ? AND opportunity_id = ?')
    .bind(c.get('buyer').id, c.req.param('id'))
    .run();
  await audit(c, 'opportunity.unsaved', 'opportunity', c.req.param('id') ?? '');
  return c.json({ data: { saved: false } });
});

buyers.get('/api/buyer/nda-requests', requireBuyer, async (c) => {
  const result = await c.env.DB.prepare(
    'SELECT n.id, n.status, n.acceptance_name AS acceptanceName, n.accepted_at AS acceptedAt, n.review_reason AS reviewReason, CASE WHEN n.signed_pdf_r2_key IS NULL THEN 0 ELSE 1 END AS hasSignedPdf, n.created_at AS createdAt, o.id AS opportunityId, o.slug AS opportunitySlug, o.title AS opportunityTitle, g.id AS grantId, g.tier AS accessTier, g.expires_at AS accessExpiresAt, g.revoked_at AS accessRevokedAt FROM nda_requests n JOIN opportunities o ON o.id = n.opportunity_id LEFT JOIN access_grants g ON g.nda_request_id = n.id AND g.user_id = n.user_id WHERE n.user_id = ? ORDER BY n.created_at DESC LIMIT 100',
  )
    .bind(c.get('buyer').id)
    .all();
  return c.json({ data: result.results ?? [] });
});

buyers.get('/api/buyer/opportunities/:id/documents', requireBuyer, async (c) => {
  const opp = await c.env.DB.prepare(
    "SELECT id FROM opportunities WHERE id = ? AND lifecycle = 'published' AND content_review_status = 'approved' AND public_visibility = 1",
  )
    .bind(c.req.param('id'))
    .first();
  if (!opp) return jsonError(c, 404, 'NOT_FOUND', 'Opportunity not found.');
  const grant = await c.env.DB.prepare(
    'SELECT id, tier FROM access_grants WHERE user_id = ? AND opportunity_id = ? AND revoked_at IS NULL AND expires_at > ? LIMIT 1',
  )
    .bind(c.get('buyer').id, c.req.param('id'), now())
    .first<{ id: string; tier: number }>();
  if (!grant)
    return jsonError(c, 403, 'ACCESS_NOT_GRANTED', 'Approved NDA and active access are required.');
  const result = await c.env.DB.prepare(
    "SELECT id, filename, content_type AS contentType, byte_size AS byteSize, tier, created_at AS createdAt FROM documents WHERE opportunity_id = ? AND tier <= ? AND scan_status = 'clean' ORDER BY created_at DESC",
  )
    .bind(c.req.param('id'), grant.tier)
    .all();
  return c.json({ data: result.results ?? [] });
});

buyers.get('/api/buyer/documents/:documentId/download', requireBuyer, async (c) => {
  const doc = await c.env.DB.prepare(
    "SELECT d.id, d.opportunity_id AS opportunityId, d.r2_key AS r2Key, d.filename, d.content_type AS contentType, d.tier FROM documents d JOIN opportunities o ON o.id = d.opportunity_id WHERE d.id = ? AND d.scan_status = 'clean' AND o.lifecycle = 'published' AND o.content_review_status = 'approved' AND o.public_visibility = 1 AND o.classification = 'public'",
  )
    .bind(c.req.param('documentId'))
    .first<{
      id: string;
      opportunityId: string;
      r2Key: string;
      filename: string;
      contentType: string;
      tier: number;
    }>();
  if (!doc) return jsonError(c, 404, 'NOT_FOUND', 'Document not found.');
  const grant = await c.env.DB.prepare(
    'SELECT id, tier FROM access_grants WHERE user_id = ? AND opportunity_id = ? AND revoked_at IS NULL AND expires_at > ? LIMIT 1',
  )
    .bind(c.get('buyer').id, doc.opportunityId, now())
    .first<{ id: string; tier: number }>();
  if (!grant || doc.tier > grant.tier)
    return jsonError(c, 403, 'ACCESS_NOT_GRANTED', 'Approved NDA and active access are required.');
  const file = await c.env.PRIVATE_FILES.get(doc.r2Key);
  if (!file) return jsonError(c, 404, 'NOT_FOUND', 'Document not found.');
  await audit(c, 'document.downloaded', 'document', doc.id, { opportunityId: doc.opportunityId });
  c.header('Content-Type', doc.contentType);
  c.header('Content-Length', String(file.size));
  c.header(
    'Content-Disposition',
    `attachment; filename="${doc.filename.replace(/["\\\r\n]/g, '_')}"`,
  );
  c.header('Cache-Control', 'private, no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  return c.body(file.body as ReadableStream, 200);
});

buyers.get('/api/buyer/nda-template', requireBuyer, async (c) => {
  const template = await c.env.DB.prepare(
    "SELECT id, name, version, r2_key AS r2Key, content_hash AS contentHash FROM nda_templates WHERE status = 'active' ORDER BY version DESC LIMIT 1",
  ).first<{
    id: string;
    name: string;
    version: number;
    r2Key: string | null;
    contentHash: string;
  }>();
  if (!template)
    return jsonError(
      c,
      503,
      'NDA_NOT_CONFIGURED',
      'The NDA is not available yet. Please contact the team.',
    );
  let content: string;
  if (template.r2Key) {
    const object = await c.env.PRIVATE_FILES.get(template.r2Key);
    if (!object)
      return jsonError(
        c,
        503,
        'NDA_TEMPLATE_MISSING',
        'The active NDA template is unavailable. Please contact the team.',
      );
    const bytes = await object.arrayBuffer();
    const digestValue = await digest(new TextDecoder().decode(bytes));
    if (digestValue !== template.contentHash)
      return jsonError(
        c,
        503,
        'NDA_TEMPLATE_HASH_MISMATCH',
        'The active NDA template failed integrity verification.',
      );
    content = new TextDecoder().decode(bytes);
  } else {
    content = `CONFIDENTIALITY AND NON-DISCLOSURE ACKNOWLEDGEMENT\n\nVersion 1 — draft template for legal review\n\nThe recipient acknowledges that information provided in connection with an opportunity may be confidential, may be incomplete, and must not be copied, disclosed, published, or used except to evaluate the opportunity and as authorised in writing. The recipient must restrict access to appropriate professional advisers who are bound by confidentiality obligations, protect materials using reasonable safeguards, and promptly notify the disclosing party of unauthorised access or disclosure. On request, the recipient must stop using the materials and return or securely destroy copies, subject to lawful record-retention duties. No representation, warranty, offer, or commitment is made by this acknowledgement. Any transaction remains subject to definitive written agreements, due diligence, applicable law, and any required regulatory approvals.\n\nBy entering their legal name and submitting an access request, the recipient records an acknowledgement of this template. This workflow is not represented as a qualified electronic signature and does not replace a counsel-approved agreement or signature process. The parties, governing law, remedies, data protection terms, permitted recipients, retention period, and transaction-specific restrictions must be completed or approved by qualified counsel before production use.\n`;
    if ((await digest(content)) !== template.contentHash)
      return jsonError(
        c,
        503,
        'NDA_TEMPLATE_HASH_MISMATCH',
        'The active NDA template failed integrity verification.',
      );
  }
  return c.json({
    data: {
      id: template.id,
      name: template.name,
      version: template.version,
      contentHash: template.contentHash,
      content,
    },
  });
});

buyers.post('/api/buyer/opportunities/:slug/nda-requests', requireBuyer, async (c) => {
  const parsed = z
    .object({
      acceptanceName: z.string().trim().min(2).max(160),
      templateId: z.string().uuid().optional(),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return jsonError(
      c,
      422,
      'VALIDATION_ERROR',
      'Enter the full legal name used to acknowledge the NDA.',
    );
  const opportunity = await c.env.DB.prepare(
    "SELECT id FROM opportunities WHERE slug = ? AND lifecycle = 'published' AND content_review_status = 'approved' AND public_visibility = 1 AND classification = 'public'",
  )
    .bind(c.req.param('slug'))
    .first<{ id: string }>();
  if (!opportunity) return jsonError(c, 404, 'NOT_FOUND', 'Opportunity not found.');
  const template = parsed.data.templateId
    ? await c.env.DB.prepare(
        "SELECT id, content_hash AS contentHash FROM nda_templates WHERE id = ? AND status = 'active'",
      )
        .bind(parsed.data.templateId)
        .first<{ id: string; contentHash: string }>()
    : await c.env.DB.prepare(
        "SELECT id, content_hash AS contentHash FROM nda_templates WHERE status = 'active' ORDER BY version DESC LIMIT 1",
      ).first<{ id: string; contentHash: string }>();
  if (!template)
    return jsonError(
      c,
      503,
      'NDA_NOT_CONFIGURED',
      'The NDA is not available yet. Please contact the team.',
    );
  if (!c.env.IP_HASH_SECRET)
    return jsonError(
      c,
      503,
      'NDA_AUDIT_NOT_CONFIGURED',
      'NDA acknowledgement audit is not configured. Please contact the team.',
    );
  const clientIp = c.req.header('cf-connecting-ip') ?? 'unknown';
  const acceptedIpHash = await digest(`${c.env.IP_HASH_SECRET}:${clientIp}`);
  const previous = await c.env.DB.prepare(
    "SELECT n.id FROM nda_requests n WHERE n.user_id = ? AND n.opportunity_id = ? AND (n.status = 'pending' OR (n.status = 'approved' AND EXISTS (SELECT 1 FROM access_grants g WHERE g.nda_request_id = n.id AND g.revoked_at IS NULL AND g.expires_at > ?))) LIMIT 1",
  )
    .bind(c.get('buyer').id, opportunity.id, now())
    .first();
  if (previous)
    return jsonError(
      c,
      409,
      'REQUEST_EXISTS',
      'An NDA request already exists for this opportunity.',
    );
  const requestId = uuid();
  const notificationJobId = uuid();
  const timestamp = now();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO nda_requests (id, user_id, opportunity_id, template_id, status, acceptance_name, accepted_at, accepted_ip_hash, nda_template_hash, review_reason, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, '', ?, ?)",
    ).bind(
      requestId,
      c.get('buyer').id,
      opportunity.id,
      template.id,
      parsed.data.acceptanceName,
      timestamp,
      acceptedIpHash,
      template.contentHash,
      timestamp,
      timestamp,
    ),
    c.env.DB.prepare(
      "INSERT INTO audit_logs (id, actor_user_id, actor_type, action, entity_type, entity_id, request_id, details_json, created_at) VALUES (?, ?, 'buyer', 'nda.requested', 'nda_request', ?, ?, ?, ?)",
    ).bind(
      uuid(),
      c.get('buyer').id,
      requestId,
      c.get('requestId'),
      JSON.stringify({
        opportunityId: opportunity.id,
        templateId: template.id,
        templateHash: template.contentHash,
      }),
      timestamp,
    ),
    c.env.DB.prepare(
      "INSERT INTO notification_jobs (id, job_type, payload_json, status, attempts, available_at, created_at, updated_at) VALUES (?, 'nda.review_requested', ?, 'queued', 0, ?, ?, ?)",
    ).bind(
      notificationJobId,
      JSON.stringify({ ndaRequestId: requestId }),
      timestamp,
      timestamp,
      timestamp,
    ),
  ]);
  try {
    await c.env.NOTIFICATIONS_QUEUE.send({
      type: 'nda.review_requested',
      jobId: notificationJobId,
    });
  } catch {
    /* queued DB job remains */
  }
  return c.json({ data: { id: requestId, status: 'pending', createdAt: timestamp } }, 201);
});

buyers.post('/api/buyer/nda-requests/:id/signed-pdf', requireBuyer, async (c) => {
  const request = await c.env.DB.prepare(
    "SELECT id, signed_pdf_r2_key AS signedPdfR2Key FROM nda_requests WHERE id = ? AND user_id = ? AND status = 'pending' LIMIT 1",
  ).bind(c.req.param('id'), c.get('buyer').id).first<{ id: string; signedPdfR2Key: string | null }>();
  if (!request) return jsonError(c, 404, 'NOT_FOUND', 'Pending NDA request not found.');
  if (request.signedPdfR2Key) return jsonError(c, 409, 'SIGNED_PDF_ALREADY_UPLOADED', 'A signed PDF is already attached to this request. Contact staff if a correction is required.');
  const body = await c.req.parseBody();
  const file = body.file;
  if (!(file instanceof File) || file.size < 8 || file.size > 10 * 1024 * 1024 || file.type.toLowerCase() !== 'application/pdf') {
    return jsonError(c, 422, 'INVALID_PDF', 'Upload a PDF up to 10 MiB.');
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-') return jsonError(c, 415, 'INVALID_PDF_SIGNATURE', 'The uploaded file is not a valid PDF.');
  const sha256 = await digestBytes(bytes);
  const key = `nda-signed/${request.id}/${uuid()}.pdf`;
  await c.env.PRIVATE_FILES.put(key, bytes.buffer as ArrayBuffer, {
    httpMetadata: { contentType: 'application/pdf', cacheControl: 'private, no-store' },
    customMetadata: { ndaRequestId: request.id, buyerId: c.get('buyer').id, sha256 },
  });
  let scan: VerifiedScan;
  try {
    scan = await scanR2Document(c.env, { documentId: `nda-${request.id}`, r2Key: key, contentType: 'application/pdf', expectedSha256: sha256 });
    if (scan.verdict !== 'clean') {
      await c.env.PRIVATE_FILES.delete(key);
      return jsonError(c, 415, 'PDF_SCAN_REJECTED', 'The signed PDF did not pass the security scan and was not retained.');
    }
  } catch (error) {
    await c.env.PRIVATE_FILES.delete(key);
    if (error instanceof ScannerError) return jsonError(c, 503, 'SCANNER_UNAVAILABLE', 'The document security scanner is unavailable. Please try again later.');
    return jsonError(c, 503, 'SCANNER_UNAVAILABLE', 'The document security scanner could not verify this file.');
  }
  const timestamp = now();
  const notificationJobId = uuid();
  const update = await c.env.DB.prepare(
    "UPDATE nda_requests SET signed_pdf_r2_key = ?, signed_pdf_sha256 = ?, signed_pdf_scan_provider = ?, signed_pdf_scanned_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND status = 'pending' AND signed_pdf_r2_key IS NULL",
  ).bind(key, sha256, scan.provider, scan.scannedAt, timestamp, request.id, c.get('buyer').id).run();
  if ((update.meta?.changes ?? 0) !== 1) {
    await c.env.PRIVATE_FILES.delete(key);
    return jsonError(c, 409, 'REQUEST_CHANGED', 'The NDA request changed while the file was being checked. Refresh and try again.');
  }
  try {
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO audit_logs (id, actor_user_id, actor_type, action, entity_type, entity_id, request_id, details_json, created_at) VALUES (?, ?, 'buyer', 'nda.signed_pdf_uploaded', 'nda_request', ?, ?, ?, ?)").bind(uuid(), c.get('buyer').id, request.id, c.get('requestId'), JSON.stringify({ sha256, scannerProvider: scan.provider, scannedAt: scan.scannedAt }), timestamp),
      c.env.DB.prepare("INSERT INTO notification_jobs (id, job_type, payload_json, status, attempts, available_at, created_at, updated_at) VALUES (?, 'nda.signed_pdf_uploaded', ?, 'queued', 0, ?, ?, ?)").bind(notificationJobId, JSON.stringify({ ndaRequestId: request.id }), timestamp, timestamp, timestamp),
    ]);
  } catch {
    await c.env.DB.prepare('UPDATE nda_requests SET signed_pdf_r2_key = NULL, signed_pdf_sha256 = NULL, signed_pdf_scan_provider = NULL, signed_pdf_scanned_at = NULL, updated_at = ? WHERE id = ? AND signed_pdf_r2_key = ?').bind(now(), request.id, key).run();
    await c.env.PRIVATE_FILES.delete(key);
    return jsonError(c, 503, 'PERSISTENCE_FAILED', 'The signed PDF could not be safely recorded. Please try again.');
  }
  try { await c.env.NOTIFICATIONS_QUEUE.send({ type: 'nda.signed_pdf_uploaded', jobId: notificationJobId }); } catch { /* durable job recovery retries */ }
  c.header('Cache-Control', 'private, no-store');
  return c.json({ data: { id: request.id, signedPdfUploaded: true, scanStatus: 'clean' } }, 201);
});

async function digestBytes(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), (value) => value.toString(16).padStart(2, '0')).join('');
}

export default buyers;
